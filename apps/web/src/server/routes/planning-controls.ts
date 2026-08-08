import { createUuidV7, rankBetween } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertAllowed, assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { ActorContext, AppEnv } from "../http/types";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  sha256,
} from "../idempotency";
import {
  calculatePlanningBudgetLine,
  evaluateLogisticsReadiness,
  findReservationConflicts,
  rollupBudgetTotals,
  spreadsheetSafeCell,
  type ReservationPlanningRow,
} from "../planning/services";
import { parseIfMatch, versionGuard } from "../records/version";

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/u)
  .transform((value) => value.toUpperCase());
const optionalText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const timestampSchema = z.number().int().positive();
const idSchema = z.string().min(1).max(128);

const createBudgetSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    currency: currencySchema.default("EUR"),
    contingencyBps: z.number().int().min(0).max(100_000).default(0),
    exchangeRateNote: optionalText(1_000),
  })
  .strict();

const createBudgetVersionSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    sourceVersionId: idSchema.optional(),
    contingencyBps: z.number().int().min(0).max(100_000).optional(),
    exchangeRateNote: optionalText(1_000),
  })
  .strict();

const createAccountSchema = z
  .object({
    versionId: idSchema,
    code: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[A-Za-z0-9.-]+$/u),
    title: z.string().trim().min(2).max(160),
    parentAccountId: idSchema.nullable().optional(),
  })
  .strict();

const budgetLineSchema = z
  .object({
    versionId: idSchema,
    accountId: idSchema,
    title: z.string().trim().min(2).max(240),
    notes: optionalText(4_000),
    unit: optionalText(80),
    quantityMilli: z.number().int().min(0).max(1_000_000_000),
    durationMilli: z.number().int().min(0).max(1_000_000_000),
    rateMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    fringeBps: z.number().int().min(0).max(100_000).default(0),
    taxBps: z.number().int().min(0).max(100_000).default(0),
    markupBps: z.number().int().min(0).max(100_000).default(0),
    approvedMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    committedMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    actualMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    paidMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict();

const approvalSchema = z
  .object({
    versionId: idSchema,
    comment: z.string().trim().min(8).max(4_000),
  })
  .strict();

const requirementTypeSchema = z.enum([
  "chain_of_title",
  "writer_creator_agreement",
  "cast_crew_agreement",
  "deal_memo",
  "appearance_release",
  "location_release",
  "minor_guardian_permission",
  "permit",
  "insurance",
  "music_rights",
  "artwork_clearance",
  "archive_clearance",
  "trademark_clearance",
  "product_clearance",
  "drone_permission",
  "road_permission",
  "fire_permission",
  "animal_permission",
  "weapon_permission",
  "stunt_permission",
  "special_effect_permission",
  "public_space_permission",
  "privacy_consent",
  "custom",
]);
const requirementStatusSchema = z.enum([
  "missing",
  "draft",
  "requested",
  "pending",
  "executed",
  "approved",
  "expired",
  "not_required",
  "blocked",
]);

const createRequirementSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    requirementType: requirementTypeSchema,
    status: requirementStatusSchema.default("missing"),
    summary: optionalText(4_000),
    jurisdiction: optionalText(160),
    dueAt: timestampSchema.nullable().optional(),
    expiresAt: timestampSchema.nullable().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
    isBlocking: z.boolean().default(false),
    signedExecutedState: z
      .enum(["not_required", "unsigned", "pending_external", "executed", "manual_uploaded"])
      .default("not_required"),
    currentFileVersionId: idSchema.nullable().optional(),
    restricted: z.boolean().default(true),
  })
  .strict();
const patchRequirementSchema = createRequirementSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

const createRiskSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z.enum(["draft", "in_review", "approved", "superseded"]).default("draft"),
    summary: optionalText(4_000),
    reviewAt: timestampSchema.nullable().optional(),
  })
  .strict();
const createHazardSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    description: optionalText(4_000),
    affectedPeople: optionalText(1_000),
    likelihood: z.number().int().min(1).max(5),
    impact: z.number().int().min(1).max(5),
    residualLikelihood: z.number().int().min(1).max(5).nullable().optional(),
    residualImpact: z.number().int().min(1).max(5).nullable().optional(),
    status: z.enum(["open", "controlled", "accepted", "closed"]).default("open"),
  })
  .strict();
const createControlSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    description: optionalText(4_000),
    status: z.enum(["planned", "in_progress", "complete", "not_required"]).default("planned"),
    dueAt: timestampSchema.nullable().optional(),
  })
  .strict();

const legalHoldSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    reason: z.string().trim().min(12).max(4_000),
    scope: z.enum(["project", "object", "file"]).default("project"),
    objectRegistryId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope !== "project" && !value.objectRegistryId) {
      context.addIssue({
        code: "custom",
        message: "An object is required for an object or file hold.",
        path: ["objectRegistryId"],
      });
    }
  });
const releaseLegalHoldSchema = z.object({ reason: z.string().trim().min(12).max(4_000) }).strict();

const createEquipmentSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z
      .enum(["available", "planned", "reserved", "ready", "unavailable", "service_required"])
      .default("available"),
    summary: optionalText(4_000),
    ownershipType: z.enum(["owned", "borrowed", "rented"]),
    category: z.string().trim().min(1).max(100),
    manufacturer: optionalText(120),
    model: optionalText(120),
    serialAssetId: optionalText(160),
    condition: optionalText(240),
    valueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    currency: currencySchema.nullable().optional(),
    storageLocation: optionalText(240),
  })
  .strict();
const createKitSchema = z
  .object({ title: z.string().trim().min(2).max(240), summary: optionalText(4_000) })
  .strict();
const addKitMemberSchema = z
  .object({ equipmentItemId: idSchema, quantity: z.number().int().min(1).max(10_000) })
  .strict();
const reservationSchema = z
  .object({
    equipmentItemId: idSchema.nullable().optional(),
    equipmentKitId: idSchema.nullable().optional(),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    timezone: z.string().trim().min(1).max(64),
    status: z.enum(["planned", "held", "confirmed", "ready"]).default("planned"),
    overrideReason: z.string().trim().min(12).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.equipmentItemId) === Boolean(value.equipmentKitId)) {
      context.addIssue({
        code: "custom",
        message: "Select exactly one equipment item or kit.",
        path: ["equipmentItemId"],
      });
    }
    if (value.endsAt <= value.startsAt)
      context.addIssue({ code: "custom", message: "End must be after start.", path: ["endsAt"] });
  });

const logisticsPlanSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z
      .enum(["draft", "in_review", "approved", "confirmed", "ready", "blocked"])
      .default("draft"),
    summary: optionalText(4_000),
    baseCamp: optionalText(1_000),
    holding: optionalText(1_000),
    greenRoom: optionalText(1_000),
    toilets: optionalText(1_000),
    powerCharging: optionalText(1_000),
    waste: optionalText(1_000),
    security: optionalText(1_000),
    accessNotes: optionalText(2_000),
    emergencyNotes: optionalText(2_000),
  })
  .strict();
const transportSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z
      .enum(["draft", "planned", "confirmed", "ready", "approved", "not_required"])
      .default("planned"),
    summary: optionalText(4_000),
    routeMapUrl: z.string().trim().url().max(2_000).nullable().optional(),
  })
  .strict();
const cateringSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z
      .enum(["draft", "planned", "confirmed", "ready", "approved", "not_required"])
      .default("planned"),
    summary: optionalText(4_000),
    headCount: z.number().int().min(0).max(100_000),
    costMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    currency: currencySchema.nullable().optional(),
    mealTimes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  })
  .strict();

interface BudgetRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly currency: string;
  readonly working_version_id: string | null;
  readonly approved_version_id: string | null;
  readonly version: number;
  readonly archived_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}
interface BudgetVersionRow {
  readonly id: string;
  readonly budget_id: string;
  readonly version_number: number;
  readonly name: string;
  readonly status: "draft" | "working" | "approved" | "superseded";
  readonly currency: string;
  readonly exchange_rate_note: string | null;
  readonly contingency_basis_points: number;
  readonly total_estimate_minor: number;
  readonly total_approved_minor: number;
  readonly total_committed_minor: number;
  readonly total_actual_minor: number;
  readonly total_paid_minor: number;
  readonly content_hash: string;
  readonly created_at: number;
}
interface BudgetAccountRow {
  readonly id: string;
  readonly budget_version_id: string;
  readonly parent_account_id: string | null;
  readonly code: string;
  readonly title: string;
  readonly sort_rank: string;
}
interface BudgetLineRow {
  readonly id: string;
  readonly budget_version_id: string;
  readonly budget_account_id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly quantity_micros: number;
  readonly unit: string | null;
  readonly rate_minor: number;
  readonly duration_micros: number;
  readonly subtotal_minor: number;
  readonly fringe_basis_points: number;
  readonly tax_basis_points: number;
  readonly markup_basis_points: number;
  readonly estimate_minor: number;
  readonly approved_minor: number;
  readonly committed_minor: number;
  readonly actual_minor: number;
  readonly paid_minor: number;
  readonly currency: string;
  readonly sort_rank: string;
}
interface RequirementRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly requirement_type: string;
  readonly jurisdiction: string | null;
  readonly due_at: number | null;
  readonly expires_at: number | null;
  readonly priority: string;
  readonly is_blocking: number;
  readonly signed_executed_state: string;
  readonly current_file_version_id: string | null;
  readonly restricted: number;
  readonly version: number;
  readonly archived_at: number | null;
  readonly updated_at: number;
}
interface RiskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly review_at: number | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface HazardRow {
  readonly id: string;
  readonly risk_assessment_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly affected_people: string | null;
  readonly likelihood: number;
  readonly impact: number;
  readonly initial_score: number;
  readonly residual_likelihood: number | null;
  readonly residual_impact: number | null;
  readonly residual_score: number | null;
  readonly status: string;
  readonly version: number;
  readonly archived_at: number | null;
}
interface ControlRow {
  readonly id: string;
  readonly hazard_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly due_at: number | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface LegalHoldRow {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly scope: string;
  readonly placed_at: number;
  readonly released_at: number | null;
  readonly release_reason: string | null;
  readonly placed_by: string;
  readonly released_by: string | null;
}
interface EquipmentRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly ownership_type: string;
  readonly category: string;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly serial_asset_id: string | null;
  readonly condition: string | null;
  readonly value_minor: number | null;
  readonly currency: string | null;
  readonly storage_location: string | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface KitRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface KitMemberRow {
  readonly equipment_kit_id: string;
  readonly equipment_item_id: string;
  readonly quantity: number;
  readonly item_title: string;
}
interface ReservationRow {
  readonly id: string;
  readonly equipment_item_id: string | null;
  readonly equipment_kit_id: string | null;
  readonly starts_at: number;
  readonly ends_at: number;
  readonly timezone: string;
  readonly status: string;
  readonly version: number;
  readonly archived_at: number | null;
  readonly resource_title: string;
}
interface LogisticsRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly base_camp: string | null;
  readonly holding: string | null;
  readonly green_room: string | null;
  readonly toilets: string | null;
  readonly power_charging: string | null;
  readonly waste: string | null;
  readonly security: string | null;
  readonly access_notes: string | null;
  readonly emergency_notes: string | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface SimplePlanRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly version: number;
  readonly archived_at: number | null;
}
interface TransportRow extends SimplePlanRow {
  readonly route_map_url: string | null;
}
interface CateringRow extends SimplePlanRow {
  readonly head_count: number;
  readonly meal_times_json: string;
  readonly cost_minor: number | null;
  readonly currency: string | null;
}

export const planningControlRoutes = new Hono<AppEnv>();
planningControlRoutes.use("*", requireActor, requireSameOrigin, requireCsrf, requireJson);

planningControlRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  assertAllowed(actor, "project.sensitive");
  return ok(context, await loadPlanningControls(context.env.DB, actor, projectId));
});

planningControlRoutes.post("/budgets", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const input = createBudgetSchema.parse(await context.req.json());
  const [budgetRank, accountRanks] = await Promise.all([
    nextRank(context.env.DB, "budgets", actor.workspaceId, projectId),
    Promise.resolve(
      defaultBudgetAccounts().map((_, index) =>
        rankBetween(index === 0 ? undefined : defaultBudgetAccounts()[index - 1]?.rank, undefined),
      ),
    ),
  ]);
  const budgetId = createUuidV7();
  const versionId = createUuidV7();
  const registryId = createUuidV7();
  const now = Date.now();
  const accounts = defaultBudgetAccounts();
  const contentHash = await sha256(
    canonicalJson({
      name: `${input.title} v1`,
      currency: input.currency,
      contingencyBps: input.contingencyBps,
      accounts: accounts.map(({ code, title }) => ({ code, title })),
      lines: [],
    }),
  );
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO budgets
      (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, currency,
       working_version_id, approved_version_id, details_json, version, archived_at, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'working', NULL, ?5, ?6, ?7, ?8, NULL, '{}', 1, NULL, ?5, ?9, ?9)`,
    ).bind(
      budgetId,
      actor.workspaceId,
      projectId,
      input.title,
      actor.userId,
      budgetRank,
      input.currency,
      versionId,
      now,
    ),
    context.env.DB.prepare(
      `INSERT INTO budget_versions
      (id, workspace_id, project_id, budget_id, version_number, name, status, currency, exchange_rate_note,
       contingency_basis_points, total_estimate_minor, total_approved_minor, total_committed_minor,
       total_actual_minor, total_paid_minor, content_hash, author_user_id, created_at)
      VALUES (?1, ?2, ?3, ?4, 1, ?5, 'working', ?6, ?7, ?8, 0, 0, 0, 0, 0, ?9, ?10, ?11)`,
    ).bind(
      versionId,
      actor.workspaceId,
      projectId,
      budgetId,
      `${input.title} v1`,
      input.currency,
      input.exchangeRateNote ?? null,
      input.contingencyBps,
      contentHash,
      actor.userId,
      now,
    ),
  ];
  accounts.forEach((account, index) => {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO budget_accounts
      (id, workspace_id, project_id, budget_version_id, parent_account_id, code, title, sort_rank, created_at)
      VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)`,
      ).bind(
        account.id,
        actor.workspaceId,
        projectId,
        versionId,
        account.code,
        account.title,
        accountRanks[index] ?? rankBetween(),
        now,
      ),
    );
  });
  statements.push(
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      registryId,
      "budget",
      "budgets",
      budgetId,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "budget.created",
      objectType: "budget",
      objectId: budgetId,
      requestId: context.get("requestId"),
      details: { versionId },
      occurredAt: now,
    }),
  );
  await context.env.DB.batch(statements);
  return ok(context, { id: budgetId, versionId, version: 1 }, 201);
});

planningControlRoutes.post("/budgets/:budgetId/versions", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const budgetId = requiredParam(context.req.param("budgetId"), "budgetId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = createBudgetVersionSchema.parse(await context.req.json());
  const budget = await requireBudget(context.env.DB, actor, projectId, budgetId);
  if (budget.working_version_id)
    throw new HttpError(
      409,
      "working_version_exists",
      "Approve or discard the current working version before creating another.",
    );
  const sourceId = input.sourceVersionId ?? budget.approved_version_id;
  const source = sourceId
    ? await requireBudgetVersion(context.env.DB, actor, projectId, budgetId, sourceId)
    : null;
  const [sourceAccounts, sourceLines, nextVersion] = await Promise.all([
    source
      ? context.env.DB.prepare(
          "SELECT id, budget_version_id, parent_account_id, code, title, sort_rank FROM budget_accounts WHERE workspace_id = ?1 AND project_id = ?2 AND budget_version_id = ?3 ORDER BY sort_rank",
        )
          .bind(actor.workspaceId, projectId, source.id)
          .all<BudgetAccountRow>()
      : Promise.resolve({ results: [] as BudgetAccountRow[] }),
    source
      ? context.env.DB.prepare(
          "SELECT id, budget_version_id, budget_account_id, title, notes, quantity_micros, unit, rate_minor, duration_micros, subtotal_minor, fringe_basis_points, tax_basis_points, markup_basis_points, estimate_minor, approved_minor, committed_minor, actual_minor, paid_minor, currency, sort_rank FROM budget_lines WHERE workspace_id = ?1 AND project_id = ?2 AND budget_version_id = ?3 ORDER BY sort_rank",
        )
          .bind(actor.workspaceId, projectId, source.id)
          .all<BudgetLineRow>()
      : Promise.resolve({ results: [] as BudgetLineRow[] }),
    context.env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM budget_versions WHERE budget_id = ?1",
    )
      .bind(budgetId)
      .first<number>("next"),
  ]);
  const versionId = createUuidV7();
  const now = Date.now();
  const accountMap = new Map(sourceAccounts.results.map((account) => [account.id, createUuidV7()]));
  const contentHash = await sha256(
    canonicalJson({
      sourceVersionId: source?.id ?? null,
      sourceHash: source?.content_hash ?? null,
      name: input.name,
      version: nextVersion ?? 1,
    }),
  );
  const guard = versionGuard(
    context.env.DB,
    "budgets",
    budgetId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const statements: D1PreparedStatement[] = [
    guard.insert,
    context.env.DB.prepare(
      `INSERT INTO budget_versions
      (id, workspace_id, project_id, budget_id, version_number, name, status, currency, exchange_rate_note,
       contingency_basis_points, total_estimate_minor, total_approved_minor, total_committed_minor,
       total_actual_minor, total_paid_minor, content_hash, author_user_id, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'working', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    ).bind(
      versionId,
      actor.workspaceId,
      projectId,
      budgetId,
      nextVersion ?? 1,
      input.name,
      source?.currency ?? budget.currency,
      input.exchangeRateNote ?? source?.exchange_rate_note ?? null,
      input.contingencyBps ?? source?.contingency_basis_points ?? 0,
      source?.total_estimate_minor ?? 0,
      source?.total_approved_minor ?? 0,
      source?.total_committed_minor ?? 0,
      source?.total_actual_minor ?? 0,
      source?.total_paid_minor ?? 0,
      contentHash,
      actor.userId,
      now,
    ),
  ];
  for (const account of sourceAccounts.results) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO budget_accounts
      (id, workspace_id, project_id, budget_version_id, parent_account_id, code, title, sort_rank, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        accountMap.get(account.id),
        actor.workspaceId,
        projectId,
        versionId,
        account.parent_account_id ? (accountMap.get(account.parent_account_id) ?? null) : null,
        account.code,
        account.title,
        account.sort_rank,
        now,
      ),
    );
  }
  for (const line of sourceLines.results) {
    const accountId = accountMap.get(line.budget_account_id);
    if (!accountId)
      throw new HttpError(
        409,
        "budget_clone_invalid",
        "A source budget line has no source account.",
      );
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO budget_lines
      (id, workspace_id, project_id, budget_version_id, budget_account_id, title, notes, owner_user_id,
       quantity_micros, unit, rate_minor, duration_micros, subtotal_minor, fringe_basis_points, tax_basis_points,
       markup_basis_points, estimate_minor, approved_minor, committed_minor, actual_minor, paid_minor, currency, sort_rank, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`,
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        versionId,
        accountId,
        line.title,
        line.notes,
        actor.userId,
        line.quantity_micros,
        line.unit,
        line.rate_minor,
        line.duration_micros,
        line.subtotal_minor,
        line.fringe_basis_points,
        line.tax_basis_points,
        line.markup_basis_points,
        line.estimate_minor,
        line.approved_minor,
        line.committed_minor,
        line.actual_minor,
        line.paid_minor,
        line.currency,
        line.sort_rank,
        now,
      ),
    );
  }
  statements.push(
    context.env.DB.prepare(
      "UPDATE budgets SET working_version_id = ?1, status = 'working', version = version + 1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
    ).bind(versionId, now, budgetId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "budget.version_created",
      objectType: "budget",
      objectId: budgetId,
      requestId: context.get("requestId"),
      details: { versionId, sourceVersionId: source?.id ?? null },
      occurredAt: now,
    }),
    guard.remove,
  );
  await guardedBudgetBatch(context.env.DB, actor, projectId, budgetId, expected, statements);
  return ok(
    context,
    { id: versionId, versionNumber: nextVersion ?? 1, budgetVersion: expected + 1 },
    201,
  );
});

planningControlRoutes.post("/budgets/:budgetId/accounts", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const budgetId = requiredParam(context.req.param("budgetId"), "budgetId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = createAccountSchema.parse(await context.req.json());
  const budget = await requireWorkingBudget(
    context.env.DB,
    actor,
    projectId,
    budgetId,
    input.versionId,
  );
  if (input.parentAccountId)
    await requireBudgetAccount(
      context.env.DB,
      actor,
      projectId,
      input.versionId,
      input.parentAccountId,
    );
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRankBy(
    context.env.DB,
    "budget_accounts",
    "budget_version_id",
    input.versionId,
  );
  const contentHash = await sha256(
    canonicalJson({
      previous: budget.working.content_hash,
      operation: "account.add",
      id,
      code: input.code,
      title: input.title,
    }),
  );
  const guard = versionGuard(
    context.env.DB,
    "budgets",
    budgetId,
    actor.workspaceId,
    projectId,
    expected,
  );
  await guardedBudgetBatch(context.env.DB, actor, projectId, budgetId, expected, [
    guard.insert,
    context.env.DB.prepare(
      "INSERT INTO budget_accounts (id, workspace_id, project_id, budget_version_id, parent_account_id, code, title, sort_rank, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.versionId,
      input.parentAccountId ?? null,
      input.code.toUpperCase(),
      input.title,
      rank,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE budget_versions SET content_hash = ?1 WHERE id = ?2 AND status = 'working'",
    ).bind(contentHash, input.versionId),
    context.env.DB.prepare(
      "UPDATE budgets SET version = version + 1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
    ).bind(now, budgetId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "budget.account_created",
      objectType: "budget",
      objectId: budgetId,
      requestId: context.get("requestId"),
      details: { versionId: input.versionId, accountId: id },
      occurredAt: now,
    }),
    guard.remove,
  ]);
  return ok(context, { id, budgetVersion: expected + 1 }, 201);
});

planningControlRoutes.post("/budgets/:budgetId/lines", async (context) => {
  return saveBudgetLine(context, null);
});

planningControlRoutes.put("/budgets/:budgetId/lines/:lineId", async (context) => {
  return saveBudgetLine(context, requiredParam(context.req.param("lineId"), "lineId"));
});

planningControlRoutes.post("/budgets/:budgetId/approve", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const budgetId = requiredParam(context.req.param("budgetId"), "budgetId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = approvalSchema.parse(await context.req.json());
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: "budget.approve",
    key: context.req.header("Idempotency-Key"),
    requestBody: { projectId, budgetId, ...input },
  });
  if (lease.replayRef) {
    const replay = await requireBudgetVersion(
      context.env.DB,
      actor,
      projectId,
      budgetId,
      lease.replayRef,
    );
    return ok(context, budgetVersionView(replay, true));
  }
  try {
    const budget = await requireWorkingBudget(
      context.env.DB,
      actor,
      projectId,
      budgetId,
      input.versionId,
    );
    const [accounts, lines, registry] = await Promise.all([
      context.env.DB.prepare(
        "SELECT id, budget_version_id, parent_account_id, code, title, sort_rank FROM budget_accounts WHERE workspace_id = ?1 AND project_id = ?2 AND budget_version_id = ?3 ORDER BY sort_rank",
      )
        .bind(actor.workspaceId, projectId, input.versionId)
        .all<BudgetAccountRow>(),
      context.env.DB.prepare(
        "SELECT id, budget_version_id, budget_account_id, title, notes, quantity_micros, unit, rate_minor, duration_micros, subtotal_minor, fringe_basis_points, tax_basis_points, markup_basis_points, estimate_minor, approved_minor, committed_minor, actual_minor, paid_minor, currency, sort_rank FROM budget_lines WHERE workspace_id = ?1 AND project_id = ?2 AND budget_version_id = ?3 ORDER BY sort_rank",
      )
        .bind(actor.workspaceId, projectId, input.versionId)
        .all<BudgetLineRow>(),
      context.env.DB.prepare(
        "SELECT id FROM object_registry WHERE workspace_id = ?1 AND project_id = ?2 AND domain_table = 'budgets' AND domain_id = ?3 LIMIT 1",
      )
        .bind(actor.workspaceId, projectId, budgetId)
        .first<{ id: string }>(),
    ]);
    if (lines.results.length === 0)
      throw new HttpError(409, "budget_empty", "Add at least one budget line before approval.");
    if (!registry)
      throw new HttpError(
        409,
        "budget_registry_missing",
        "The budget object registration is incomplete.",
      );
    const contentHash = await sha256(
      canonicalJson({
        budget: { id: budgetId, title: budget.title },
        version: budget.working,
        accounts: accounts.results,
        lines: lines.results,
      }),
    );
    const approvalId = createUuidV7();
    const decisionId = createUuidV7();
    const now = Date.now();
    const guard = versionGuard(
      context.env.DB,
      "budgets",
      budgetId,
      actor.workspaceId,
      projectId,
      expected,
    );
    await guardedBudgetBatch(context.env.DB, actor, projectId, budgetId, expected, [
      guard.insert,
      context.env.DB.prepare(
        "UPDATE budget_versions SET status = 'approved', content_hash = ?1 WHERE id = ?2 AND status = 'working'",
      ).bind(contentHash, input.versionId),
      context.env.DB.prepare(
        "UPDATE budgets SET working_version_id = NULL, approved_version_id = ?1, status = 'approved', version = version + 1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
      ).bind(input.versionId, now, budgetId, actor.workspaceId, projectId),
      context.env.DB.prepare(
        `INSERT INTO approvals (id, workspace_id, project_id, object_id, title, status, summary, owner_user_id, approver_user_id, pinned_version_id, requested_at, self_approval_allowed, details_json, version, archived_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'approved', ?6, ?7, ?7, ?8, ?9, 1, '{}', 1, NULL, ?9, ?9)`,
      ).bind(
        approvalId,
        actor.workspaceId,
        projectId,
        registry.id,
        `Budget v${budget.working.version_number} approval`,
        input.comment,
        actor.userId,
        input.versionId,
        now,
      ),
      context.env.DB.prepare(
        "INSERT INTO approval_decisions (id, workspace_id, project_id, approval_id, decision, actor_user_id, comment, pinned_version_id, created_at) VALUES (?1, ?2, ?3, ?4, 'approved', ?5, ?6, ?7, ?8)",
      ).bind(
        decisionId,
        actor.workspaceId,
        projectId,
        approvalId,
        actor.userId,
        input.comment,
        input.versionId,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "budget.version_approved",
        objectType: "budget",
        objectId: budgetId,
        requestId: context.get("requestId"),
        details: { versionId: input.versionId, contentHash, approvalId, selfApprovalAllowed: true },
        occurredAt: now,
      }),
      completeIdempotentOperation(context.env.DB, lease.id, input.versionId),
      guard.remove,
    ]);
    return ok(
      context,
      budgetVersionView(
        await requireBudgetVersion(context.env.DB, actor, projectId, budgetId, input.versionId),
        true,
      ),
    );
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
});

planningControlRoutes.get("/budgets/:budgetId/export.csv", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const budgetId = requiredParam(context.req.param("budgetId"), "budgetId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  assertAllowed(actor, "project.sensitive");
  const budget = await requireBudget(context.env.DB, actor, projectId, budgetId);
  const versionId =
    context.req.query("versionId") ?? budget.working_version_id ?? budget.approved_version_id;
  if (!versionId)
    throw new HttpError(409, "budget_version_missing", "The budget has no version to export.");
  await requireBudgetVersion(context.env.DB, actor, projectId, budgetId, versionId);
  const result = await context.env.DB.prepare(
    `SELECT a.code, a.title AS account_title, l.title, l.quantity_micros, l.duration_micros,
    l.unit, l.rate_minor, l.estimate_minor, l.approved_minor, l.committed_minor, l.actual_minor, l.paid_minor, l.currency
    FROM budget_lines l JOIN budget_accounts a ON a.id = l.budget_account_id
    WHERE l.workspace_id = ?1 AND l.project_id = ?2 AND l.budget_version_id = ?3 ORDER BY a.sort_rank, l.sort_rank`,
  )
    .bind(actor.workspaceId, projectId, versionId)
    .all<Record<string, string | number | null>>();
  const columns = [
    "Account",
    "Account title",
    "Line",
    "Quantity",
    "Duration",
    "Unit",
    "Rate minor",
    "Estimate minor",
    "Approved minor",
    "Committed minor",
    "Actual minor",
    "Paid minor",
    "Currency",
  ];
  const keys = [
    "code",
    "account_title",
    "title",
    "quantity_micros",
    "duration_micros",
    "unit",
    "rate_minor",
    "estimate_minor",
    "approved_minor",
    "committed_minor",
    "actual_minor",
    "paid_minor",
    "currency",
  ];
  const csv = [
    columns.map(spreadsheetSafeCell).join(","),
    ...result.results.map((row) =>
      keys.map((key) => spreadsheetSafeCell(row[key] ?? null)).join(","),
    ),
  ].join("\r\n");
  return new Response(`\uFEFF${csv}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFileName(budget.title)}-budget.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

planningControlRoutes.post("/requirements", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const input = createRequirementSchema.parse(await context.req.json());
  await assertFileVersionScope(
    context.env.DB,
    actor,
    projectId,
    input.currentFileVersionId ?? null,
  );
  const id = createUuidV7();
  const registryId = createUuidV7();
  const now = Date.now();
  const rank = await nextRank(context.env.DB, "requirements", actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO requirements
      (id, workspace_id, project_id, object_id, title, status, summary, owner_user_id, sort_rank, requirement_type,
       jurisdiction, due_at, expires_at, priority, is_blocking, template_version_id, current_file_version_id,
       signed_executed_state, approval_id, restricted, details_json, version, archived_at, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16, NULL, ?17, '{}', 1, NULL, ?7, ?18, ?18)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.requirementType,
      input.jurisdiction ?? null,
      input.dueAt ?? null,
      input.expiresAt ?? null,
      input.priority,
      input.isBlocking ? 1 : 0,
      input.currentFileVersionId ?? null,
      input.signedExecutedState,
      input.restricted ? 1 : 0,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      registryId,
      "requirement",
      "requirements",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "requirement.created",
      objectType: "requirement",
      objectId: id,
      requestId: context.get("requestId"),
      details: { requirementType: input.requirementType, restricted: input.restricted },
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.patch("/requirements/:requirementId", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const requirementId = requiredParam(context.req.param("requirementId"), "requirementId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = patchRequirementSchema.parse(await context.req.json());
  const current = await requireRequirement(context.env.DB, actor, projectId, requirementId);
  await assertFileVersionScope(
    context.env.DB,
    actor,
    projectId,
    input.currentFileVersionId === undefined
      ? current.current_file_version_id
      : input.currentFileVersionId,
  );
  const guard = versionGuard(
    context.env.DB,
    "requirements",
    requirementId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  const next = {
    title: input.title ?? current.title,
    status: input.status ?? current.status,
    summary: input.summary === undefined ? current.summary : input.summary,
    requirementType: input.requirementType ?? current.requirement_type,
    jurisdiction: input.jurisdiction === undefined ? current.jurisdiction : input.jurisdiction,
    dueAt: input.dueAt === undefined ? current.due_at : input.dueAt,
    expiresAt: input.expiresAt === undefined ? current.expires_at : input.expiresAt,
    priority: input.priority ?? current.priority,
    isBlocking: input.isBlocking === undefined ? current.is_blocking : input.isBlocking ? 1 : 0,
    signedState: input.signedExecutedState ?? current.signed_executed_state,
    fileVersionId:
      input.currentFileVersionId === undefined
        ? current.current_file_version_id
        : input.currentFileVersionId,
    restricted: input.restricted === undefined ? current.restricted : input.restricted ? 1 : 0,
  };
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        `UPDATE requirements SET title=?1,status=?2,summary=?3,requirement_type=?4,jurisdiction=?5,due_at=?6,expires_at=?7,priority=?8,is_blocking=?9,signed_executed_state=?10,current_file_version_id=?11,restricted=?12,version=version+1,updated_at=?13 WHERE id=?14 AND workspace_id=?15 AND project_id=?16`,
      ).bind(
        next.title,
        next.status,
        next.summary,
        next.requirementType,
        next.jurisdiction,
        next.dueAt,
        next.expiresAt,
        next.priority,
        next.isBlocking,
        next.signedState,
        next.fileVersionId,
        next.restricted,
        now,
        requirementId,
        actor.workspaceId,
        projectId,
      ),
      context.env.DB.prepare(
        "UPDATE object_registry SET title=?1,version=version+1,updated_at=?2 WHERE workspace_id=?3 AND project_id=?4 AND domain_table='requirements' AND domain_id=?5",
      ).bind(next.title, now, actor.workspaceId, projectId, requirementId),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "requirement.updated",
        objectType: "requirement",
        objectId: requirementId,
        requestId: context.get("requestId"),
        details: { fields: Object.keys(input) },
        occurredAt: now,
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw await versionConflict(
        context.env.DB,
        "requirements",
        actor.workspaceId,
        projectId,
        requirementId,
        expected,
      );
    throw error;
  }
  return ok(context, { id: requirementId, version: expected + 1 });
});

planningControlRoutes.post("/risks", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const input = createRiskSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRank(context.env.DB, "risk_assessments", actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO risk_assessments (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,review_at,approval_id,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,'{}',1,NULL,?7,?10,?10)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.reviewAt ?? null,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "risk_assessment",
      "risk_assessments",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "risk.created",
      objectType: "risk_assessment",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/risks/:riskId/hazards", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const riskId = requiredParam(context.req.param("riskId"), "riskId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  await requireRisk(context.env.DB, actor, projectId, riskId);
  const input = createHazardSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRankBy(context.env.DB, "hazards", "risk_assessment_id", riskId);
  const residualScore =
    input.residualLikelihood && input.residualImpact
      ? input.residualLikelihood * input.residualImpact
      : null;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO hazards (id,workspace_id,project_id,risk_assessment_id,title,description,affected_people,likelihood,impact,initial_score,residual_likelihood,residual_impact,residual_score,owner_user_id,status,sort_rank,version,archived_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,1,NULL,?17,?17)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      riskId,
      input.title,
      input.description ?? null,
      input.affectedPeople ?? null,
      input.likelihood,
      input.impact,
      input.likelihood * input.impact,
      input.residualLikelihood ?? null,
      input.residualImpact ?? null,
      residualScore,
      actor.userId,
      input.status,
      rank,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "hazard",
      "hazards",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "hazard.created",
      objectType: "hazard",
      objectId: id,
      requestId: context.get("requestId"),
      details: { initialScore: input.likelihood * input.impact, residualScore },
      occurredAt: now,
    }),
  ]);
  return ok(
    context,
    { id, initialScore: input.likelihood * input.impact, residualScore, version: 1 },
    201,
  );
});

planningControlRoutes.post("/hazards/:hazardId/controls", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const hazardId = requiredParam(context.req.param("hazardId"), "hazardId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  await requireHazard(context.env.DB, actor, projectId, hazardId);
  const input = createControlSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRankBy(context.env.DB, "control_measures", "hazard_id", hazardId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO control_measures (id,workspace_id,project_id,hazard_id,title,description,owner_user_id,status,due_at,evidence_object_id,sort_rank,version,archived_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,1,NULL,?11,?11)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      hazardId,
      input.title,
      input.description ?? null,
      actor.userId,
      input.status,
      input.dueAt ?? null,
      rank,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "control_measure",
      "control_measures",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "hazard.control_created",
      objectType: "control_measure",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/legal-holds", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "legal_hold.manage");
  const input = legalHoldSchema.parse(await context.req.json());
  if (input.objectRegistryId)
    await assertRegistryScope(context.env.DB, actor, projectId, input.objectRegistryId);
  const id = createUuidV7();
  const now = Date.now();
  const statements = [
    context.env.DB.prepare(
      "INSERT INTO legal_holds (id,workspace_id,project_id,title,reason,scope,placed_by_user_id,placed_at,released_by_user_id,released_at,release_reason) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,NULL,NULL)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.reason,
      input.scope,
      actor.userId,
      now,
    ),
  ];
  if (input.objectRegistryId)
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO legal_hold_objects (legal_hold_id,object_id) VALUES (?1,?2)",
      ).bind(id, input.objectRegistryId),
    );
  statements.push(
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "legal_hold.placed",
      objectType: "legal_hold",
      objectId: id,
      requestId: context.get("requestId"),
      details: { scope: input.scope },
      occurredAt: now,
    }),
  );
  await context.env.DB.batch(statements);
  return ok(context, { id, placedAt: now }, 201);
});

planningControlRoutes.post("/legal-holds/:holdId/release", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const holdId = requiredParam(context.req.param("holdId"), "holdId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "legal_hold.manage");
  const input = releaseLegalHoldSchema.parse(await context.req.json());
  const now = Date.now();
  const result = await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE legal_holds SET released_by_user_id=?1,released_at=?2,release_reason=?3 WHERE id=?4 AND workspace_id=?5 AND project_id=?6 AND released_at IS NULL",
    ).bind(actor.userId, now, input.reason, holdId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "legal_hold.released",
      objectType: "legal_hold",
      objectId: holdId,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new HttpError(
      409,
      "legal_hold_not_active",
      "The legal hold is missing or already released.",
    );
  return ok(context, { id: holdId, releasedAt: now });
});

planningControlRoutes.post("/equipment", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = createEquipmentSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextEquipmentRank(context.env.DB, actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO equipment_items (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,ownership_type,category,manufacturer,model,serial_asset_id,condition,value_minor,currency,storage_location,vendor_id,insurance_requirement_id,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,NULL,NULL,'{}',1,NULL,?7,?18,?18)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.ownershipType,
      input.category,
      input.manufacturer ?? null,
      input.model ?? null,
      input.serialAssetId ?? null,
      input.condition ?? null,
      input.valueMinor ?? null,
      input.currency ?? null,
      input.storageLocation ?? null,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "equipment_item",
      "equipment_items",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "equipment.created",
      objectType: "equipment_item",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/kits", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = createKitSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextEquipmentKitRank(context.env.DB, actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO equipment_kits (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,'active',?5,?6,?7,'{}',1,NULL,?6,?8,?8)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.summary ?? null,
      actor.userId,
      rank,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "equipment_kit",
      "equipment_kits",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "equipment.kit_created",
      objectType: "equipment_kit",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/kits/:kitId/members", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const kitId = requiredParam(context.req.param("kitId"), "kitId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = addKitMemberSchema.parse(await context.req.json());
  await Promise.all([
    requireKit(context.env.DB, actor, projectId, kitId),
    requireEquipment(context.env.DB, actor, projectId, input.equipmentItemId),
  ]);
  const rank = await nextRankBy(context.env.DB, "kit_members", "equipment_kit_id", kitId);
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO kit_members (equipment_kit_id,equipment_item_id,quantity,sort_rank) VALUES (?1,?2,?3,?4) ON CONFLICT(equipment_kit_id,equipment_item_id) DO UPDATE SET quantity=excluded.quantity",
    ).bind(kitId, input.equipmentItemId, input.quantity, rank),
    context.env.DB.prepare(
      "UPDATE equipment_kits SET version=version+1,updated_at=?1 WHERE id=?2 AND workspace_id=?3 AND project_id=?4",
    ).bind(now, kitId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "equipment.kit_member_set",
      objectType: "equipment_kit",
      objectId: kitId,
      requestId: context.get("requestId"),
      details: { equipmentItemId: input.equipmentItemId, quantity: input.quantity },
      occurredAt: now,
    }),
  ]);
  return ok(context, { changed: true });
});

planningControlRoutes.post("/reservations/preview", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const input = reservationSchema.parse(await context.req.json());
  await assertReservationResource(
    context.env.DB,
    actor,
    projectId,
    input.equipmentItemId ?? null,
    input.equipmentKitId ?? null,
  );
  const conflicts = await reservationConflictsWith(context.env.DB, actor, projectId, {
    id: "preview",
    equipmentItemId: input.equipmentItemId ?? null,
    equipmentKitId: input.equipmentKitId ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status: input.status,
  });
  return ok(context, { conflicts });
});

planningControlRoutes.post("/reservations", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = reservationSchema.parse(await context.req.json());
  await assertReservationResource(
    context.env.DB,
    actor,
    projectId,
    input.equipmentItemId ?? null,
    input.equipmentKitId ?? null,
  );
  const id = createUuidV7();
  const candidate = {
    id,
    equipmentItemId: input.equipmentItemId ?? null,
    equipmentKitId: input.equipmentKitId ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    status: input.status,
  };
  const conflicts = await reservationConflictsWith(context.env.DB, actor, projectId, candidate);
  if (conflicts.length > 0 && !input.overrideReason)
    throw new HttpError(
      409,
      "resource_conflict",
      "The reservation overlaps another use. Review the conflict or provide an explicit override reason.",
      { conflicts },
    );
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO reservations (id,workspace_id,project_id,equipment_item_id,equipment_kit_id,starts_at,ends_at,timezone,status,planned_custodian_person_id,collection_checklist_json,return_checklist_json,version,archived_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,'[]','[]',1,NULL,?10,?10)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.equipmentItemId ?? null,
      input.equipmentKitId ?? null,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.status,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "reservation",
      "reservations",
      id,
      `Equipment reservation ${new Date(input.startsAt).toISOString()}`,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: conflicts.length
        ? "equipment.reservation_conflict_overridden"
        : "equipment.reservation_created",
      objectType: "reservation",
      objectId: id,
      requestId: context.get("requestId"),
      details: { conflicts, overrideReason: input.overrideReason ?? null },
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1, conflicts, overridden: conflicts.length > 0 }, 201);
});

planningControlRoutes.post("/logistics", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = logisticsPlanSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRank(context.env.DB, "logistics_plans", actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO logistics_plans (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,base_camp,holding,green_room,toilets,power_charging,waste,security,access_notes,emergency_notes,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'{}',1,NULL,?7,?18,?18)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.baseCamp ?? null,
      input.holding ?? null,
      input.greenRoom ?? null,
      input.toilets ?? null,
      input.powerCharging ?? null,
      input.waste ?? null,
      input.security ?? null,
      input.accessNotes ?? null,
      input.emergencyNotes ?? null,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "logistics_plan",
      "logistics_plans",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "logistics.created",
      objectType: "logistics_plan",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/transport", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = transportSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRank(context.env.DB, "transport_plans", actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO transport_plans (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,route_map_url,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'{}',1,NULL,?7,?10,?10)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.routeMapUrl ?? null,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "transport_plan",
      "transport_plans",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "transport.created",
      objectType: "transport_plan",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

planningControlRoutes.post("/catering", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = cateringSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const rank = await nextRank(context.env.DB, "catering_plans", actor.workspaceId, projectId);
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO catering_plans (id,workspace_id,project_id,title,status,summary,owner_user_id,sort_rank,vendor_id,head_count,meal_times_json,cost_minor,currency,details_json,version,archived_at,created_by,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10,?11,?12,'{}',1,NULL,?7,?13,?13)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary ?? null,
      actor.userId,
      rank,
      input.headCount,
      JSON.stringify(input.mealTimes),
      input.costMinor ?? null,
      input.currency ?? null,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor,
      projectId,
      createUuidV7(),
      "catering_plan",
      "catering_plans",
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "catering.created",
      objectType: "catering_plan",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { id, version: 1 }, 201);
});

async function saveBudgetLine(context: Parameters<typeof ok>[0], lineId: string | null) {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const budgetId = requiredParam(context.req.param("budgetId"), "budgetId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "project.sensitive");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = budgetLineSchema.parse(await context.req.json());
  const budget = await requireWorkingBudget(
    context.env.DB,
    actor,
    projectId,
    budgetId,
    input.versionId,
  );
  await requireBudgetAccount(context.env.DB, actor, projectId, input.versionId, input.accountId);
  const amounts = calculatePlanningBudgetLine({
    currency: budget.working.currency,
    rateMinor: input.rateMinor,
    quantityMilli: input.quantityMilli,
    durationMilli: input.durationMilli,
    fringeBps: input.fringeBps,
    taxBps: input.taxBps,
    markupBps: input.markupBps,
    approvedMinor: input.approvedMinor,
    committedMinor: input.committedMinor,
    actualMinor: input.actualMinor,
    paidMinor: input.paidMinor,
  });
  if (lineId) {
    const existing = await context.env.DB.prepare(
      "SELECT id FROM budget_lines WHERE id=?1 AND workspace_id=?2 AND project_id=?3 AND budget_version_id=?4 LIMIT 1",
    )
      .bind(lineId, actor.workspaceId, projectId, input.versionId)
      .first();
    if (!existing) throw new HttpError(404, "not_found", "The budget line was not found.");
  }
  const id = lineId ?? createUuidV7();
  const now = Date.now();
  const rank = lineId
    ? null
    : await nextRankBy(context.env.DB, "budget_lines", "budget_version_id", input.versionId);
  const contentHash = await sha256(
    canonicalJson({
      previous: budget.working.content_hash,
      operation: lineId ? "line.update" : "line.add",
      id,
      input,
      amounts,
    }),
  );
  const guard = versionGuard(
    context.env.DB,
    "budgets",
    budgetId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const lineStatement = lineId
    ? context.env.DB.prepare(
        `UPDATE budget_lines SET budget_account_id=?1,title=?2,notes=?3,quantity_micros=?4,unit=?5,rate_minor=?6,duration_micros=?7,subtotal_minor=?8,fringe_basis_points=?9,tax_basis_points=?10,markup_basis_points=?11,estimate_minor=?12,approved_minor=?13,committed_minor=?14,actual_minor=?15,paid_minor=?16,currency=?17 WHERE id=?18 AND workspace_id=?19 AND project_id=?20 AND budget_version_id=?21`,
      ).bind(
        input.accountId,
        input.title,
        input.notes ?? null,
        input.quantityMilli,
        input.unit ?? null,
        input.rateMinor,
        input.durationMilli,
        amounts.subtotalMinor,
        input.fringeBps,
        input.taxBps,
        input.markupBps,
        amounts.estimateMinor,
        input.approvedMinor,
        input.committedMinor,
        input.actualMinor,
        input.paidMinor,
        budget.working.currency,
        id,
        actor.workspaceId,
        projectId,
        input.versionId,
      )
    : context.env.DB.prepare(
        `INSERT INTO budget_lines (id,workspace_id,project_id,budget_version_id,budget_account_id,title,notes,owner_user_id,quantity_micros,unit,rate_minor,duration_micros,subtotal_minor,fringe_basis_points,tax_basis_points,markup_basis_points,estimate_minor,approved_minor,committed_minor,actual_minor,paid_minor,currency,sort_rank,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        input.versionId,
        input.accountId,
        input.title,
        input.notes ?? null,
        actor.userId,
        input.quantityMilli,
        input.unit ?? null,
        input.rateMinor,
        input.durationMilli,
        amounts.subtotalMinor,
        input.fringeBps,
        input.taxBps,
        input.markupBps,
        amounts.estimateMinor,
        input.approvedMinor,
        input.committedMinor,
        input.actualMinor,
        input.paidMinor,
        budget.working.currency,
        rank,
        now,
      );
  await guardedBudgetBatch(context.env.DB, actor, projectId, budgetId, expected, [
    guard.insert,
    lineStatement,
    budgetTotalsStatement(context.env.DB, input.versionId, contentHash),
    context.env.DB.prepare(
      "UPDATE budgets SET version=version+1,updated_at=?1 WHERE id=?2 AND workspace_id=?3 AND project_id=?4",
    ).bind(now, budgetId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: lineId ? "budget.line_updated" : "budget.line_created",
      objectType: "budget",
      objectId: budgetId,
      requestId: context.get("requestId"),
      details: { versionId: input.versionId, lineId: id },
      occurredAt: now,
    }),
    guard.remove,
  ]);
  return ok(context, { id, budgetVersion: expected + 1, amounts }, lineId ? 200 : 201);
}

async function loadPlanningControls(db: D1Database, actor: ActorContext, projectId: string) {
  const project = await db
    .prepare(
      "SELECT currency,timezone,paper_size FROM projects WHERE id=?1 AND workspace_id=?2 LIMIT 1",
    )
    .bind(projectId, actor.workspaceId)
    .first<{ currency: string; timezone: string; paper_size: string }>();
  if (!project) throw new HttpError(404, "not_found", "The requested project was not found.");
  const [
    budgets,
    versions,
    accounts,
    lines,
    requirements,
    risks,
    hazards,
    controls,
    holds,
    equipment,
    kits,
    kitMembers,
    reservations,
    logistics,
    transport,
    catering,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT id,title,status,summary,currency,working_version_id,approved_version_id,version,archived_at,created_at,updated_at FROM budgets WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<BudgetRow>(),
    db
      .prepare(
        "SELECT id,budget_id,version_number,name,status,currency,exchange_rate_note,contingency_basis_points,total_estimate_minor,total_approved_minor,total_committed_minor,total_actual_minor,total_paid_minor,content_hash,created_at FROM budget_versions WHERE workspace_id=?1 AND project_id=?2 ORDER BY budget_id,version_number DESC",
      )
      .bind(actor.workspaceId, projectId)
      .all<BudgetVersionRow>(),
    db
      .prepare(
        "SELECT id,budget_version_id,parent_account_id,code,title,sort_rank FROM budget_accounts WHERE workspace_id=?1 AND project_id=?2 ORDER BY sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<BudgetAccountRow>(),
    db
      .prepare(
        "SELECT id,budget_version_id,budget_account_id,title,notes,quantity_micros,unit,rate_minor,duration_micros,subtotal_minor,fringe_basis_points,tax_basis_points,markup_basis_points,estimate_minor,approved_minor,committed_minor,actual_minor,paid_minor,currency,sort_rank FROM budget_lines WHERE workspace_id=?1 AND project_id=?2 ORDER BY sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<BudgetLineRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,requirement_type,jurisdiction,due_at,expires_at,priority,is_blocking,signed_executed_state,current_file_version_id,restricted,version,archived_at,updated_at FROM requirements WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,is_blocking DESC,due_at,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<RequirementRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,review_at,version,archived_at FROM risk_assessments WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<RiskRow>(),
    db
      .prepare(
        "SELECT id,risk_assessment_id,title,description,affected_people,likelihood,impact,initial_score,residual_likelihood,residual_impact,residual_score,status,version,archived_at FROM hazards WHERE workspace_id=?1 AND project_id=?2 ORDER BY sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<HazardRow>(),
    db
      .prepare(
        "SELECT id,hazard_id,title,description,status,due_at,version,archived_at FROM control_measures WHERE workspace_id=?1 AND project_id=?2 ORDER BY sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<ControlRow>(),
    db
      .prepare(
        "SELECT h.id,h.title,h.reason,h.scope,h.placed_at,h.released_at,h.release_reason,p.display_name AS placed_by,r.display_name AS released_by FROM legal_holds h JOIN user_identities p ON p.id=h.placed_by_user_id LEFT JOIN user_identities r ON r.id=h.released_by_user_id WHERE h.workspace_id=?1 AND h.project_id=?2 ORDER BY h.placed_at DESC",
      )
      .bind(actor.workspaceId, projectId)
      .all<LegalHoldRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,ownership_type,category,manufacturer,model,serial_asset_id,condition,value_minor,currency,storage_location,version,archived_at FROM equipment_items WHERE workspace_id=?1 AND (project_id=?2 OR project_id IS NULL) ORDER BY archived_at IS NOT NULL,category,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<EquipmentRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,version,archived_at FROM equipment_kits WHERE workspace_id=?1 AND (project_id=?2 OR project_id IS NULL) ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<KitRow>(),
    db
      .prepare(
        "SELECT km.equipment_kit_id,km.equipment_item_id,km.quantity,e.title AS item_title FROM kit_members km JOIN equipment_kits k ON k.id=km.equipment_kit_id JOIN equipment_items e ON e.id=km.equipment_item_id WHERE k.workspace_id=?1 AND (k.project_id=?2 OR k.project_id IS NULL) ORDER BY km.sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<KitMemberRow>(),
    db
      .prepare(
        "SELECT r.id,r.equipment_item_id,r.equipment_kit_id,r.starts_at,r.ends_at,r.timezone,r.status,r.version,r.archived_at,COALESCE(e.title,k.title,'Unknown resource') AS resource_title FROM reservations r LEFT JOIN equipment_items e ON e.id=r.equipment_item_id LEFT JOIN equipment_kits k ON k.id=r.equipment_kit_id WHERE r.workspace_id=?1 AND r.project_id=?2 ORDER BY r.starts_at,r.id",
      )
      .bind(actor.workspaceId, projectId)
      .all<ReservationRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,base_camp,holding,green_room,toilets,power_charging,waste,security,access_notes,emergency_notes,version,archived_at FROM logistics_plans WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<LogisticsRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,route_map_url,version,archived_at FROM transport_plans WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<TransportRow>(),
    db
      .prepare(
        "SELECT id,title,status,summary,head_count,meal_times_json,cost_minor,currency,version,archived_at FROM catering_plans WHERE workspace_id=?1 AND project_id=?2 ORDER BY archived_at IS NOT NULL,sort_rank",
      )
      .bind(actor.workspaceId, projectId)
      .all<CateringRow>(),
  ]);
  const versionsByBudget = new Map<string, BudgetVersionRow[]>();
  versions.results.forEach((version) => {
    const rows = versionsByBudget.get(version.budget_id) ?? [];
    rows.push(version);
    versionsByBudget.set(version.budget_id, rows);
  });
  const accountsByVersion = new Map<string, BudgetAccountRow[]>();
  accounts.results.forEach((account) => {
    const rows = accountsByVersion.get(account.budget_version_id) ?? [];
    rows.push(account);
    accountsByVersion.set(account.budget_version_id, rows);
  });
  const linesByVersion = new Map<string, BudgetLineRow[]>();
  lines.results.forEach((line) => {
    const rows = linesByVersion.get(line.budget_version_id) ?? [];
    rows.push(line);
    linesByVersion.set(line.budget_version_id, rows);
  });
  const conflictRows = findReservationConflicts(
    reservations.results
      .filter((row) => row.archived_at === null)
      .map((row) => ({
        id: row.id,
        equipmentItemId: row.equipment_item_id,
        equipmentKitId: row.equipment_kit_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
      })),
    kitMembers.results.map((row) => ({
      kitId: row.equipment_kit_id,
      itemId: row.equipment_item_id,
    })),
  );
  const itemNames = new Map(equipment.results.map((item) => [item.id, item.title]));
  const primaryLogistics = logistics.results.find((plan) => plan.archived_at === null) ?? null;
  const logisticsReadiness = evaluateLogisticsReadiness({
    loaded: true,
    planStatus: primaryLogistics?.status ?? null,
    baseCamp: primaryLogistics?.base_camp ?? null,
    toilets: primaryLogistics?.toilets ?? null,
    powerCharging: primaryLogistics?.power_charging ?? null,
    accessNotes: primaryLogistics?.access_notes ?? null,
    emergencyNotes: primaryLogistics?.emergency_notes ?? null,
    transportStatuses: transport.results
      .filter((row) => row.archived_at === null)
      .map((row) => row.status),
    cateringStatuses: catering.results
      .filter((row) => row.archived_at === null)
      .map((row) => row.status),
  });
  return {
    project: {
      currency: project.currency,
      timezone: project.timezone,
      paperSize: project.paper_size,
    },
    budget: {
      budgets: budgets.results.map((budget) => ({
        id: budget.id,
        title: budget.title,
        status: budget.status,
        currency: budget.currency,
        workingVersionId: budget.working_version_id,
        approvedVersionId: budget.approved_version_id,
        version: budget.version,
        archivedAt: budget.archived_at,
        versions: (versionsByBudget.get(budget.id) ?? []).map((version) => ({
          ...budgetVersionView(version, version.id === budget.approved_version_id),
          varianceMinor: version.total_actual_minor - version.total_approved_minor,
          accounts: (accountsByVersion.get(version.id) ?? []).map((account) => ({
            id: account.id,
            parentAccountId: account.parent_account_id,
            code: account.code,
            title: account.title,
            lines: (linesByVersion.get(version.id) ?? [])
              .filter((line) => line.budget_account_id === account.id)
              .map(budgetLineView),
          })),
        })),
      })),
    },
    legalSafety: {
      requirements: requirements.results.map(requirementView),
      risks: risks.results.map((risk) => ({
        ...riskView(risk),
        hazards: hazards.results
          .filter((hazard) => hazard.risk_assessment_id === risk.id)
          .map((hazard) => ({
            ...hazardView(hazard),
            controls: controls.results
              .filter((control) => control.hazard_id === hazard.id)
              .map(controlView),
          })),
      })),
      legalHolds: holds.results.map((hold) => ({
        id: hold.id,
        title: hold.title,
        reason: hold.reason,
        scope: hold.scope,
        placedAt: hold.placed_at,
        releasedAt: hold.released_at,
        releaseReason: hold.release_reason,
        placedBy: hold.placed_by,
        releasedBy: hold.released_by,
      })),
      providers: {
        externalSignature: {
          state: "not_configured",
          manualFallback: "Upload the executed file version and record execution manually.",
        },
        legalDetermination: {
          state: "not_provided",
          notice: "This register tracks evidence and does not make legal determinations.",
        },
      },
    },
    equipment: {
      items: equipment.results.map(equipmentView),
      kits: kits.results.map((kit) => ({
        ...kitView(kit),
        members: kitMembers.results
          .filter((member) => member.equipment_kit_id === kit.id)
          .map((member) => ({
            equipmentItemId: member.equipment_item_id,
            title: member.item_title,
            quantity: member.quantity,
          })),
      })),
      reservations: reservations.results.map(reservationView),
      conflicts: conflictRows.map((conflict) => ({
        ...conflict,
        resourceTitle: itemNames.get(conflict.resourceItemId) ?? "Unknown equipment",
      })),
    },
    logistics: {
      plans: logistics.results.map(logisticsView),
      transport: transport.results.map(transportView),
      catering: catering.results.map(cateringView),
      readiness: logisticsReadiness,
      providers: {
        maps: {
          state: "manual",
          notice: "Validated external map links are used; no paid map provider is configured.",
        },
        booking: {
          state: "not_configured",
          notice: "Travel, accommodation and catering bookings are recorded manually.",
        },
      },
    },
  };
}

function budgetVersionView(row: BudgetVersionRow, isCurrentApproved: boolean) {
  return {
    id: row.id,
    versionNumber: row.version_number,
    name: row.name,
    status: row.status,
    currency: row.currency,
    exchangeRateNote: row.exchange_rate_note,
    contingencyBps: row.contingency_basis_points,
    totalEstimateMinor: row.total_estimate_minor,
    totalApprovedMinor: row.total_approved_minor,
    totalCommittedMinor: row.total_committed_minor,
    totalActualMinor: row.total_actual_minor,
    totalPaidMinor: row.total_paid_minor,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    isCurrentApproved,
  };
}
function budgetLineView(row: BudgetLineRow) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    quantityMilli: row.quantity_micros,
    durationMilli: row.duration_micros,
    unit: row.unit,
    rateMinor: row.rate_minor,
    subtotalMinor: row.subtotal_minor,
    fringeBps: row.fringe_basis_points,
    taxBps: row.tax_basis_points,
    markupBps: row.markup_basis_points,
    estimateMinor: row.estimate_minor,
    approvedMinor: row.approved_minor,
    committedMinor: row.committed_minor,
    actualMinor: row.actual_minor,
    paidMinor: row.paid_minor,
    currency: row.currency,
  };
}
function requirementView(row: RequirementRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    requirementType: row.requirement_type,
    jurisdiction: row.jurisdiction,
    dueAt: row.due_at,
    expiresAt: row.expires_at,
    priority: row.priority,
    isBlocking: row.is_blocking === 1,
    signedExecutedState: row.signed_executed_state,
    currentFileVersionId: row.current_file_version_id,
    restricted: row.restricted === 1,
    version: row.version,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}
function riskView(row: RiskRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    reviewAt: row.review_at,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function hazardView(row: HazardRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    affectedPeople: row.affected_people,
    likelihood: row.likelihood,
    impact: row.impact,
    initialScore: row.initial_score,
    residualLikelihood: row.residual_likelihood,
    residualImpact: row.residual_impact,
    residualScore: row.residual_score,
    status: row.status,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function controlView(row: ControlRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dueAt: row.due_at,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function equipmentView(row: EquipmentRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    ownershipType: row.ownership_type,
    category: row.category,
    manufacturer: row.manufacturer,
    model: row.model,
    serialAssetId: row.serial_asset_id,
    condition: row.condition,
    valueMinor: row.value_minor,
    currency: row.currency,
    storageLocation: row.storage_location,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function kitView(row: KitRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function reservationView(row: ReservationRow) {
  return {
    id: row.id,
    equipmentItemId: row.equipment_item_id,
    equipmentKitId: row.equipment_kit_id,
    resourceTitle: row.resource_title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    status: row.status,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function logisticsView(row: LogisticsRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    baseCamp: row.base_camp,
    holding: row.holding,
    greenRoom: row.green_room,
    toilets: row.toilets,
    powerCharging: row.power_charging,
    waste: row.waste,
    security: row.security,
    accessNotes: row.access_notes,
    emergencyNotes: row.emergency_notes,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function transportView(row: TransportRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    routeMapUrl: row.route_map_url,
    version: row.version,
    archivedAt: row.archived_at,
  };
}
function cateringView(row: CateringRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    headCount: row.head_count,
    mealTimes: parseStringArray(row.meal_times_json),
    costMinor: row.cost_minor,
    currency: row.currency,
    version: row.version,
    archivedAt: row.archived_at,
  };
}

async function requireBudget(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  budgetId: string,
) {
  const row = await db
    .prepare(
      "SELECT id,title,status,summary,currency,working_version_id,approved_version_id,version,archived_at,created_at,updated_at FROM budgets WHERE id=?1 AND workspace_id=?2 AND project_id=?3 LIMIT 1",
    )
    .bind(budgetId, actor.workspaceId, projectId)
    .first<BudgetRow>();
  if (!row) throw new HttpError(404, "not_found", "The budget was not found.");
  if (row.archived_at)
    throw new HttpError(409, "record_archived", "Restore the budget before editing it.");
  return row;
}
async function requireBudgetVersion(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  budgetId: string,
  versionId: string,
) {
  const row = await db
    .prepare(
      "SELECT id,budget_id,version_number,name,status,currency,exchange_rate_note,contingency_basis_points,total_estimate_minor,total_approved_minor,total_committed_minor,total_actual_minor,total_paid_minor,content_hash,created_at FROM budget_versions WHERE id=?1 AND workspace_id=?2 AND project_id=?3 AND budget_id=?4 LIMIT 1",
    )
    .bind(versionId, actor.workspaceId, projectId, budgetId)
    .first<BudgetVersionRow>();
  if (!row) throw new HttpError(404, "not_found", "The budget version was not found.");
  return row;
}
async function requireWorkingBudget(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  budgetId: string,
  versionId: string,
) {
  const budget = await requireBudget(db, actor, projectId, budgetId);
  if (budget.working_version_id !== versionId)
    throw new HttpError(
      409,
      "budget_version_not_working",
      "Only the current working version can be changed.",
    );
  const working = await requireBudgetVersion(db, actor, projectId, budgetId, versionId);
  if (working.status !== "working")
    throw new HttpError(
      409,
      "budget_version_immutable",
      "Approved budget versions are immutable; create a new working version.",
    );
  return { ...budget, working };
}
async function requireBudgetAccount(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  versionId: string,
  accountId: string,
) {
  const row = await db
    .prepare(
      "SELECT id FROM budget_accounts WHERE id=?1 AND workspace_id=?2 AND project_id=?3 AND budget_version_id=?4 LIMIT 1",
    )
    .bind(accountId, actor.workspaceId, projectId, versionId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The budget account was not found.");
}
async function requireRequirement(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      "SELECT id,title,status,summary,requirement_type,jurisdiction,due_at,expires_at,priority,is_blocking,signed_executed_state,current_file_version_id,restricted,version,archived_at,updated_at FROM requirements WHERE id=?1 AND workspace_id=?2 AND project_id=?3 LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first<RequirementRow>();
  if (!row) throw new HttpError(404, "not_found", "The requirement was not found.");
  if (row.archived_at)
    throw new HttpError(409, "record_archived", "Restore the requirement before editing it.");
  return row;
}
async function requireRisk(db: D1Database, actor: ActorContext, projectId: string, id: string) {
  const row = await db
    .prepare(
      "SELECT id FROM risk_assessments WHERE id=?1 AND workspace_id=?2 AND project_id=?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The risk assessment was not found.");
}
async function requireHazard(db: D1Database, actor: ActorContext, projectId: string, id: string) {
  const row = await db
    .prepare(
      "SELECT id FROM hazards WHERE id=?1 AND workspace_id=?2 AND project_id=?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The hazard was not found.");
}
async function requireEquipment(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      "SELECT id FROM equipment_items WHERE id=?1 AND workspace_id=?2 AND (project_id=?3 OR project_id IS NULL) AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The equipment item was not found.");
}
async function requireKit(db: D1Database, actor: ActorContext, projectId: string, id: string) {
  const row = await db
    .prepare(
      "SELECT id FROM equipment_kits WHERE id=?1 AND workspace_id=?2 AND (project_id=?3 OR project_id IS NULL) AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The equipment kit was not found.");
}
async function assertReservationResource(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  itemId: string | null,
  kitId: string | null,
) {
  if (itemId) await requireEquipment(db, actor, projectId, itemId);
  else if (kitId) await requireKit(db, actor, projectId, kitId);
}
async function assertRegistryScope(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      "SELECT id FROM object_registry WHERE id=?1 AND workspace_id=?2 AND project_id=?3 LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row) throw new HttpError(404, "not_found", "The selected object was not found.");
}
async function assertFileVersionScope(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  id: string | null,
) {
  if (!id) return;
  const row = await db
    .prepare(
      "SELECT id FROM file_versions WHERE id=?1 AND workspace_id=?2 AND project_id=?3 LIMIT 1",
    )
    .bind(id, actor.workspaceId, projectId)
    .first();
  if (!row)
    throw new HttpError(
      404,
      "file_version_not_found",
      "The selected evidence file version was not found.",
    );
}

async function reservationConflictsWith(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  candidate: ReservationPlanningRow,
) {
  const [reservations, members] = await Promise.all([
    db
      .prepare(
        "SELECT id,equipment_item_id,equipment_kit_id,starts_at,ends_at,status FROM reservations WHERE workspace_id=?1 AND project_id=?2 AND archived_at IS NULL AND status<>'cancelled' AND ends_at>?3 AND starts_at<?4",
      )
      .bind(actor.workspaceId, projectId, candidate.startsAt, candidate.endsAt)
      .all<{
        id: string;
        equipment_item_id: string | null;
        equipment_kit_id: string | null;
        starts_at: number;
        ends_at: number;
        status: string;
      }>(),
    db
      .prepare(
        "SELECT km.equipment_kit_id,km.equipment_item_id FROM kit_members km JOIN equipment_kits k ON k.id=km.equipment_kit_id WHERE k.workspace_id=?1 AND (k.project_id=?2 OR k.project_id IS NULL)",
      )
      .bind(actor.workspaceId, projectId)
      .all<{ equipment_kit_id: string; equipment_item_id: string }>(),
  ]);
  return findReservationConflicts(
    [
      ...reservations.results.map((row) => ({
        id: row.id,
        equipmentItemId: row.equipment_item_id,
        equipmentKitId: row.equipment_kit_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
      })),
      candidate,
    ],
    members.results.map((row) => ({ kitId: row.equipment_kit_id, itemId: row.equipment_item_id })),
  ).filter((conflict) => conflict.reservationIds.includes(candidate.id));
}

function budgetTotalsStatement(db: D1Database, versionId: string, contentHash: string) {
  return db
    .prepare(
      `UPDATE budget_versions SET content_hash=?1,total_estimate_minor=COALESCE((SELECT SUM(estimate_minor) FROM budget_lines WHERE budget_version_id=?2),0)+CAST((COALESCE((SELECT SUM(estimate_minor) FROM budget_lines WHERE budget_version_id=?2),0)*contingency_basis_points+5000)/10000 AS INTEGER),total_approved_minor=COALESCE((SELECT SUM(approved_minor) FROM budget_lines WHERE budget_version_id=?2),0),total_committed_minor=COALESCE((SELECT SUM(committed_minor) FROM budget_lines WHERE budget_version_id=?2),0),total_actual_minor=COALESCE((SELECT SUM(actual_minor) FROM budget_lines WHERE budget_version_id=?2),0),total_paid_minor=COALESCE((SELECT SUM(paid_minor) FROM budget_lines WHERE budget_version_id=?2),0) WHERE id=?2 AND status='working'`,
    )
    .bind(contentHash, versionId);
}
async function guardedBudgetBatch(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  budgetId: string,
  expected: number,
  statements: D1PreparedStatement[],
) {
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error))
      throw await versionConflict(db, "budgets", actor.workspaceId, projectId, budgetId, expected);
    throw error;
  }
}
async function versionConflict(
  db: D1Database,
  table: string,
  workspaceId: string,
  projectId: string,
  id: string,
  expected: number,
) {
  const current = await db
    .prepare(
      `SELECT id,version,updated_at FROM ${table} WHERE id=?1 AND workspace_id=?2 AND project_id=?3 LIMIT 1`,
    )
    .bind(id, workspaceId, projectId)
    .first<{ id: string; version: number; updated_at: number }>();
  return new HttpError(409, "version_conflict", "This record changed in another session.", {
    expectedVersion: expected,
    current: current
      ? { id: current.id, version: current.version, updatedAt: current.updated_at }
      : null,
  });
}
function isConstraintError(error: unknown) {
  return (
    error instanceof Error && /constraint|version_step|CHECK|UNIQUE|immutable/iu.test(error.message)
  );
}
function registryStatement(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  registryId: string,
  objectType: string,
  table: string,
  domainId: string,
  title: string,
  now: number,
) {
  return db
    .prepare(
      "INSERT INTO object_registry (id,workspace_id,project_id,object_type,domain_table,domain_id,title,version,archived_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,NULL,?8,?8)",
    )
    .bind(registryId, actor.workspaceId, projectId, objectType, table, domainId, title, now);
}
async function nextRank(db: D1Database, table: string, workspaceId: string, projectId: string) {
  const row = await db
    .prepare(
      `SELECT sort_rank FROM ${table} WHERE workspace_id=?1 AND project_id=?2 ORDER BY sort_rank DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId)
    .first<{ sort_rank: string }>();
  return safeNextRank(row?.sort_rank);
}
async function nextEquipmentRank(db: D1Database, workspaceId: string, projectId: string) {
  const row = await db
    .prepare(
      "SELECT sort_rank FROM equipment_items WHERE workspace_id=?1 AND (project_id=?2 OR project_id IS NULL) ORDER BY sort_rank DESC LIMIT 1",
    )
    .bind(workspaceId, projectId)
    .first<{ sort_rank: string }>();
  return safeNextRank(row?.sort_rank);
}
async function nextEquipmentKitRank(db: D1Database, workspaceId: string, projectId: string) {
  const row = await db
    .prepare(
      "SELECT sort_rank FROM equipment_kits WHERE workspace_id=?1 AND (project_id=?2 OR project_id IS NULL) ORDER BY sort_rank DESC LIMIT 1",
    )
    .bind(workspaceId, projectId)
    .first<{ sort_rank: string }>();
  return safeNextRank(row?.sort_rank);
}
async function nextRankBy(db: D1Database, table: string, column: string, value: string) {
  const row = await db
    .prepare(`SELECT sort_rank FROM ${table} WHERE ${column}=?1 ORDER BY sort_rank DESC LIMIT 1`)
    .bind(value)
    .first<{ sort_rank: string }>();
  return safeNextRank(row?.sort_rank);
}
function safeNextRank(value?: string) {
  try {
    return rankBetween(value, undefined);
  } catch {
    return rankBetween(undefined, undefined);
  }
}
function defaultBudgetAccounts() {
  const definitions = [
    ["100", "Development"],
    ["200", "Production"],
    ["300", "Art & Locations"],
    ["400", "Equipment & Logistics"],
    ["500", "Legal & Safety"],
  ] as const;
  let previous: string | undefined;
  return definitions.map(([code, title]) => {
    const rank = rankBetween(previous, undefined);
    previous = rank;
    return { id: createUuidV7(), code, title, rank };
  });
}
function requiredParam(value: string | undefined, name: string) {
  if (!value) throw new HttpError(404, "route_not_found", `Missing route parameter: ${name}.`);
  return value;
}
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return value === undefined ? "null" : "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function parseStringArray(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
function safeFileName(value: string) {
  const result = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return result || "production";
}

export const planningControlTestSupport = { calculatePlanningBudgetLine, rollupBudgetTotals };
