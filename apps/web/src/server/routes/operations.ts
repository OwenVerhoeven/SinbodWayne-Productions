import { createUuidV7, rankBetween, type ResourceConflict } from "@swp/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertAllowed, assertProjectAccess } from "../auth/policy";
import { randomToken, sha256 as secretDigest } from "../auth/crypto";
import { requireActor, requireCsrf } from "../auth/session";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  sha256,
} from "../idempotency";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import {
  buildCallSheetIssue,
  buildProductionPackManifest,
  calculateRevisionConflicts,
  calculateRevisionTotals,
  canonicalJson,
  safeRelativePath,
  type CallSheetRecipientInput,
  type ProductionPackManifestEntry,
  type ScheduleArtifactItem,
} from "../operations/artifacts";
import { parseIfMatch, versionGuard } from "../records/version";

const itemTypeSchema = z.enum([
  "scene",
  "scene_segment",
  "day_break",
  "meal",
  "company_move",
  "banner",
  "rehearsal",
  "pickup_dropoff",
  "note",
]);
const resourceTypeSchema = z.enum(["cast", "crew", "location", "equipment", "vehicle"]);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const detailsSchema = z.record(z.string(), z.unknown()).default({});

const resourceAssignmentInputSchema = z
  .object({
    assignmentId: z.string().optional(),
    resourceType: resourceTypeSchema,
    resourceId: z.string().min(1).max(128),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    locationId: z.string().min(1).max(128).optional(),
    unit: z.string().trim().min(1).max(100).default("Main"),
    minimumTurnaroundMs: z.number().int().min(0).default(0),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: "Assignment end must follow its start.",
  });

const availabilityInputSchema = z
  .object({
    resourceType: resourceTypeSchema,
    resourceId: z.string().min(1).max(128),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: "Availability end must follow its start.",
  });

const travelInputSchema = z
  .object({
    fromLocationId: z.string().min(1).max(128),
    toLocationId: z.string().min(1).max(128),
    durationMs: z.number().int().min(0),
  })
  .strict();

export const scheduleItemInputSchema = z
  .object({
    itemType: itemTypeSchema,
    title: z.string().trim().max(240).default(""),
    sceneId: z.string().min(1).max(128).nullable().optional(),
    sceneSegmentId: z.string().min(1).max(128).nullable().optional(),
    shootDate: isoDateSchema.nullable().optional(),
    unit: z.string().trim().min(1).max(100).default("Main"),
    dayCount: z.number().int().positive().nullable().optional(),
    generalCallLocal: localTimeSchema.nullable().optional(),
    estimatedStartLocal: localTimeSchema.nullable().optional(),
    estimatedWrapLocal: localTimeSchema.nullable().optional(),
    timezone: z.string().trim().min(1).max(64).default("Europe/Amsterdam"),
    locationId: z.string().min(1).max(128).nullable().optional(),
    pageEighths: z.number().int().min(0).max(800).default(0),
    prepDurationMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60_000)
      .default(0),
    setupDurationMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60_000)
      .default(0),
    shootDurationMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60_000)
      .default(0),
    moveDurationMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60_000)
      .default(0),
    mealDurationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60_000)
      .default(0),
    startAt: z.number().int().min(0).optional(),
    endAt: z.number().int().min(1).optional(),
    hardConstraints: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    details: detailsSchema,
    assignments: z.array(resourceAssignmentInputSchema).max(500).default([]),
  })
  .strict()
  .superRefine((item, context) => {
    const sceneItem = item.itemType === "scene" || item.itemType === "scene_segment";
    if (sceneItem !== Boolean(item.sceneId))
      context.addIssue({
        code: "custom",
        message: "Scene strips require a scene ID; non-scene strips must not include one.",
        path: ["sceneId"],
      });
    if ((item.itemType === "scene_segment") !== Boolean(item.sceneSegmentId))
      context.addIssue({
        code: "custom",
        message: "Scene-segment strips require a segment ID only.",
        path: ["sceneSegmentId"],
      });
    if ((item.startAt === undefined) !== (item.endAt === undefined))
      context.addIssue({
        code: "custom",
        message: "Timeline start and end must be supplied together.",
        path: ["startAt"],
      });
    if (item.startAt !== undefined && item.endAt !== undefined && item.endAt <= item.startAt)
      context.addIssue({
        code: "custom",
        message: "Timeline end must follow start.",
        path: ["endAt"],
      });
  });

const revisionInputSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    sourceScriptRevisionId: z.string().min(1).max(128).nullable().optional(),
    items: z.array(scheduleItemInputSchema).min(1).max(2_000),
    availability: z.array(availabilityInputSchema).max(2_000).default([]),
    travelDurations: z.array(travelInputSchema).max(2_000).default([]),
  })
  .strict();

const scheduleCreateSchema = revisionInputSchema
  .extend({
    title: z.string().trim().min(2).max(200),
    isDefault: z.boolean().default(false),
  })
  .strict();

const scheduleDuplicateSchema = z.object({ title: z.string().trim().min(2).max(200) }).strict();
const conflictResolutionSchema = z
  .object({
    resolution: z.enum(["resolved", "overridden"]),
    reason: z.string().trim().min(3).max(2_000),
    expiresAt: z.number().int().positive().nullable().optional(),
  })
  .strict();
const shootDayCreateSchema = z
  .object({
    scheduleRevisionId: z.string().min(1).max(128),
    dayBreakItemId: z.string().min(1).max(128),
    title: z.string().trim().min(2).max(200).optional(),
    shootDate: isoDateSchema.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    generalCallAt: z.number().int().min(0).nullable().optional(),
    estimatedStartAt: z.number().int().min(0).nullable().optional(),
    baseLocationId: z.string().min(1).max(128).nullable().optional(),
    primaryLocationId: z.string().min(1).max(128).nullable().optional(),
    hardConstraints: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict();
const shootDayPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    status: z.enum(["planned", "approved", "superseded"]).optional(),
    readinessState: z.enum(["blocked", "warning", "ready", "stale", "unavailable"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

const callSheetSectionInputSchema = z
  .object({
    sectionType: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/u),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(20_000),
    visible: z.boolean().default(true),
  })
  .strict();
const personCallInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    callAt: z.number().int().min(0),
    timezone: z.string().trim().min(1).max(64),
  })
  .strict();
const callSheetRecipientInputSchema = z
  .object({
    personId: z.string().min(1).max(128),
    label: z.string().trim().min(1).max(200),
    privateNote: z.string().trim().max(10_000).default(""),
    requiredConfirmation: z.boolean().default(true),
    calls: z.array(personCallInputSchema).min(1).max(20),
  })
  .strict();
const callSheetCreateSchema = z
  .object({
    shootDayId: z.string().min(1).max(128).nullable().optional(),
    callSheetType: z
      .enum(["shoot_day", "scout", "rehearsal", "fitting_test", "custom"])
      .default("shoot_day"),
    title: z.string().trim().min(2).max(200),
    paperSize: z.enum(["A4", "Letter"]).default("A4"),
    layout: z.enum(["standard", "compact"]).default("standard"),
    manualWeather: detailsSchema,
    sections: z.array(callSheetSectionInputSchema).max(50).default([]),
    recipients: z.array(callSheetRecipientInputSchema).max(500).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.callSheetType === "shoot_day" && !value.shootDayId)
      context.addIssue({
        code: "custom",
        message: "A shoot-day call sheet requires a shoot day.",
        path: ["shootDayId"],
      });
  });
const callSheetPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    paperSize: z.enum(["A4", "Letter"]).optional(),
    layout: z.enum(["standard", "compact"]).optional(),
    manualWeather: detailsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
const callSheetIssueSchema = z
  .object({
    confidentiality: z.string().trim().max(500).default("SINBOD WAYNE — CONFIDENTIAL"),
    supersedesIssueId: z.string().min(1).max(128).nullable().optional(),
    linkExpiresAt: z.number().int().positive().optional(),
  })
  .strict();
const manualConfirmationSchema = z
  .object({ note: z.string().trim().max(500).default("") })
  .strict();

const packItemInputSchema = z
  .object({
    objectId: z.string().min(1).max(128).nullable().optional(),
    fileVersionId: z.string().min(1).max(128).nullable().optional(),
    revisionOrIssueId: z.string().min(1).max(128).nullable().optional(),
    sectionType: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_-]*$/u),
    title: z.string().trim().min(1).max(240),
    includeFile: z.boolean().default(true),
    permissionScope: z
      .enum(["project", "finance", "legal", "safety", "recipient"])
      .default("project"),
  })
  .strict()
  .refine(
    (value) => Boolean(value.objectId || value.fileVersionId || value.revisionOrIssueId),
    "A pack item must pin a production object, file version, or revision/issue.",
  );
const packCreateSchema = z
  .object({
    shootDayId: z.string().min(1).max(128).nullable().optional(),
    title: z.string().trim().min(2).max(200),
    summary: z.string().trim().max(4_000).default(""),
    paperSize: z.enum(["A4", "Letter"]).default("A4"),
    confidentiality: z.string().trim().max(500).default("SINBOD WAYNE — INTERNAL"),
    items: z.array(packItemInputSchema).min(1).max(500),
  })
  .strict();
const packIssueSchema = z
  .object({ supersedesIssueId: z.string().min(1).max(128).nullable().optional() })
  .strict();

interface ScheduleRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly is_default: number;
  readonly current_revision_id: string | null;
  readonly approved_revision_id: string | null;
  readonly version: number;
  readonly archived_at: number | null;
  readonly updated_at: number;
  readonly revision_name: string | null;
  readonly revision_number: number | null;
  readonly revision_status: string | null;
  readonly totals_json: string | null;
  readonly item_count: number;
  readonly open_conflicts: number;
  readonly day_break_item_id: string | null;
}

interface ScheduleRevisionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly schedule_id: string;
  readonly revision_number: number;
  readonly name: string;
  readonly source_script_revision_id: string | null;
  readonly status: "draft" | "approved" | "superseded";
  readonly content_hash: string;
  readonly totals_json: string;
  readonly author_user_id: string;
  readonly created_at: number;
}

interface ScheduleItemRow {
  readonly id: string;
  readonly item_type: z.infer<typeof itemTypeSchema>;
  readonly scene_id: string | null;
  readonly scene_segment_id: string | null;
  readonly title: string | null;
  readonly shoot_date: string | null;
  readonly unit: string | null;
  readonly day_count: number | null;
  readonly general_call_local: string | null;
  readonly estimated_start_local: string | null;
  readonly estimated_wrap_local: string | null;
  readonly timezone: string | null;
  readonly location_id: string | null;
  readonly page_eighths: number;
  readonly prep_duration_ms: number;
  readonly setup_duration_ms: number;
  readonly shoot_duration_ms: number;
  readonly move_duration_ms: number;
  readonly hard_constraints_json: string;
  readonly details_json: string;
  readonly sort_rank: string;
  readonly created_at: number;
}

export const operationsRoutes = new Hono<AppEnv>();
operationsRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

operationsRoutes.get("/schedules", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const result = await context.env.DB.prepare(
    `SELECT s.id, s.title, s.status, s.is_default, s.current_revision_id, s.approved_revision_id,
            s.version, s.archived_at, s.updated_at, sr.name AS revision_name,
            sr.revision_number, sr.status AS revision_status, sr.totals_json,
            (SELECT COUNT(*) FROM schedule_items si WHERE si.schedule_revision_id = sr.id) AS item_count,
            (SELECT COUNT(*) FROM resource_conflicts rc WHERE rc.schedule_revision_id = sr.id AND rc.status = 'open') AS open_conflicts,
            (SELECT si.id FROM schedule_items si WHERE si.schedule_revision_id = sr.id AND si.item_type = 'day_break' ORDER BY si.sort_rank LIMIT 1) AS day_break_item_id
       FROM schedules s
       LEFT JOIN schedule_revisions sr ON sr.id = s.current_revision_id AND sr.workspace_id = s.workspace_id AND sr.project_id = s.project_id
      WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.archived_at IS NULL
      ORDER BY s.is_default DESC, s.sort_rank, s.id`,
  )
    .bind(actor.workspaceId, projectId)
    .all<ScheduleRow>();
  return ok(context, { items: result.results.map(scheduleView) });
});

operationsRoutes.post("/schedules", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const input = scheduleCreateSchema.parse(await context.req.json());
  await validateScheduleInput(context.env.DB, actor.workspaceId, projectId, input);
  const scheduleId = createUuidV7();
  const now = Date.now();
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM schedules WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  const scheduleRank = rankBetween(last?.sort_rank, undefined);
  const prepared = await prepareRevision(
    actor.workspaceId,
    projectId,
    scheduleId,
    1,
    input.name,
    input.sourceScriptRevisionId ?? null,
    input.items,
    input.availability,
    input.travelDurations,
    actor.userId,
    now,
  );
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO schedules
        (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, is_default,
         current_revision_id, approved_revision_id, details_json, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'working', NULL, ?5, ?6, ?7, ?8, NULL, '{}', 1, NULL, ?9, ?9)`,
    ).bind(
      scheduleId,
      actor.workspaceId,
      projectId,
      input.title,
      actor.userId,
      scheduleRank,
      input.isDefault ? 1 : 0,
      prepared.id,
      now,
    ),
    ...preparedStatements(context.env.DB, prepared),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule",
      "schedules",
      scheduleId,
      input.title,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      "schedule_revisions",
      prepared.id,
      input.name,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "schedule.created",
      objectType: "schedule",
      objectId: scheduleId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        revisionId: prepared.id,
        itemCount: prepared.items.length,
        conflictCount: prepared.conflicts.length,
      },
    }),
  ];
  if (input.isDefault)
    statements.unshift(
      context.env.DB.prepare(
        "UPDATE schedules SET is_default = 0, updated_at = ?1, version = version + 1 WHERE workspace_id = ?2 AND project_id = ?3 AND is_default = 1 AND archived_at IS NULL",
      ).bind(now, actor.workspaceId, projectId),
    );
  await context.env.DB.batch(statements);
  return ok(
    context,
    await loadScheduleView(context.env.DB, actor.workspaceId, projectId, scheduleId),
    201,
  );
});

operationsRoutes.get("/schedules/:scheduleId", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const scheduleId = requiredParam(context.req.param("scheduleId"), "scheduleId");
  const schedule = await loadScheduleView(context.env.DB, actor.workspaceId, projectId, scheduleId);
  const revisions = await context.env.DB.prepare(
    `SELECT id, workspace_id, project_id, schedule_id, revision_number, name, source_script_revision_id,
            status, content_hash, totals_json, author_user_id, created_at
       FROM schedule_revisions WHERE schedule_id = ?1 AND workspace_id = ?2 AND project_id = ?3
      ORDER BY revision_number DESC`,
  )
    .bind(scheduleId, actor.workspaceId, projectId)
    .all<ScheduleRevisionRow>();
  const revisionId = schedule.currentRevisionId;
  const items = revisionId
    ? await loadScheduleItems(context.env.DB, actor.workspaceId, projectId, revisionId)
    : [];
  const conflicts = revisionId
    ? await loadConflicts(context.env.DB, actor.workspaceId, projectId, revisionId)
    : [];
  return ok(context, {
    ...schedule,
    revisions: revisions.results.map(revisionView),
    items: items.map(scheduleItemView),
    conflicts,
  });
});

operationsRoutes.post("/schedules/:scheduleId/revisions", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const scheduleId = requiredParam(context.req.param("scheduleId"), "scheduleId");
  const input = revisionInputSchema.parse(await context.req.json());
  await requireSchedule(context.env.DB, actor.workspaceId, projectId, scheduleId);
  await validateScheduleInput(context.env.DB, actor.workspaceId, projectId, input);
  const prior = await context.env.DB.prepare(
    "SELECT COALESCE(MAX(revision_number), 0) AS value FROM schedule_revisions WHERE schedule_id = ?1",
  )
    .bind(scheduleId)
    .first<{ value: number }>();
  const now = Date.now();
  const prepared = await prepareRevision(
    actor.workspaceId,
    projectId,
    scheduleId,
    (prior?.value ?? 0) + 1,
    input.name,
    input.sourceScriptRevisionId ?? null,
    input.items,
    input.availability,
    input.travelDurations,
    actor.userId,
    now,
  );
  await context.env.DB.batch([
    ...preparedStatements(context.env.DB, prepared),
    context.env.DB.prepare(
      "UPDATE schedules SET current_revision_id = ?1, status = 'working', updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
    ).bind(prepared.id, now, scheduleId, actor.workspaceId, projectId),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      "schedule_revisions",
      prepared.id,
      input.name,
      now,
    ),
    staleReadinessStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      prepared.id,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "schedule.revision_created",
      objectType: "schedule",
      objectId: scheduleId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        revisionId: prepared.id,
        revisionNumber: prepared.revisionNumber,
        itemCount: prepared.items.length,
        conflictCount: prepared.conflicts.length,
      },
    }),
  ]);
  return ok(
    context,
    {
      revision: revisionView(prepared),
      items: prepared.items.map(scheduleItemView),
      conflicts: prepared.conflicts.map(preparedConflictView),
    },
    201,
  );
});

operationsRoutes.post("/schedules/:scheduleId/approve", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  assertAllowed(actor, "artifact.issue");
  const scheduleId = requiredParam(context.req.param("scheduleId"), "scheduleId");
  const input = z
    .object({ name: z.string().trim().min(2).max(200).optional() })
    .strict()
    .parse(await context.req.json());
  const schedule = await requireSchedule(context.env.DB, actor.workspaceId, projectId, scheduleId);
  if (!schedule.current_revision_id)
    throw new HttpError(409, "schedule_empty", "Create a working revision before approval.");
  const source = await requireRevision(
    context.env.DB,
    actor.workspaceId,
    projectId,
    schedule.current_revision_id,
  );
  const items = await loadScheduleItems(context.env.DB, actor.workspaceId, projectId, source.id);
  const prior = await context.env.DB.prepare(
    "SELECT COALESCE(MAX(revision_number), 0) AS value FROM schedule_revisions WHERE schedule_id = ?1",
  )
    .bind(scheduleId)
    .first<{ value: number }>();
  const now = Date.now();
  const approvedId = createUuidV7();
  const number = (prior?.value ?? 0) + 1;
  const name = input.name ?? `${source.name} — approved`;
  const encoded = canonicalJson({
    sourceRevisionId: source.id,
    number,
    items: items.map(scheduleItemView),
    totals: parseObject(source.totals_json),
  });
  const hash = await sha256(encoded);
  const itemCopies: PreparedScheduleItem[] = items.map((item) => ({
    ...item,
    id: createUuidV7(),
    workspace_id: actor.workspaceId,
    project_id: projectId,
    schedule_revision_id: approvedId,
    created_at: now,
  }));
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO schedule_revisions (id, workspace_id, project_id, schedule_id, revision_number, name, source_script_revision_id, status, content_hash, totals_json, author_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'approved', ?8, ?9, ?10, ?11)`,
    ).bind(
      approvedId,
      actor.workspaceId,
      projectId,
      scheduleId,
      number,
      name,
      source.source_script_revision_id,
      hash,
      source.totals_json,
      actor.userId,
      now,
    ),
    ...itemCopies.map((item) => scheduleItemInsert(context.env.DB, item)),
    context.env.DB.prepare(
      "UPDATE schedules SET current_revision_id = ?1, approved_revision_id = ?1, status = 'approved', updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
    ).bind(approvedId, now, scheduleId, actor.workspaceId, projectId),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      "schedule_revisions",
      approvedId,
      name,
      now,
    ),
    staleReadinessStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      approvedId,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "schedule.approved_revision_issued",
      objectType: "schedule_revision",
      objectId: approvedId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { scheduleId, sourceRevisionId: source.id, revisionNumber: number },
    }),
  ];
  await context.env.DB.batch(statements);
  return ok(
    context,
    {
      id: approvedId,
      scheduleId,
      revisionNumber: number,
      name,
      status: "approved" as const,
      contentHash: hash,
      createdAt: now,
    },
    201,
  );
});

operationsRoutes.post("/schedules/:scheduleId/duplicate", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const sourceId = requiredParam(context.req.param("scheduleId"), "scheduleId");
  const input = scheduleDuplicateSchema.parse(await context.req.json());
  const source = await requireSchedule(context.env.DB, actor.workspaceId, projectId, sourceId);
  if (!source.current_revision_id)
    throw new HttpError(409, "schedule_empty", "The source schedule has no revision to duplicate.");
  const revision = await requireRevision(
    context.env.DB,
    actor.workspaceId,
    projectId,
    source.current_revision_id,
  );
  const items = await loadScheduleItems(context.env.DB, actor.workspaceId, projectId, revision.id);
  const mappedItems = items.map(scheduleItemAsInput);
  const duplicateInput = scheduleCreateSchema.parse({
    title: input.title,
    name: `${input.title} revision 1`,
    sourceScriptRevisionId: revision.source_script_revision_id,
    isDefault: false,
    items: mappedItems,
    availability: [],
    travelDurations: [],
  });
  const scheduleId = createUuidV7();
  const now = Date.now();
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM schedules WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  const prepared = await prepareRevision(
    actor.workspaceId,
    projectId,
    scheduleId,
    1,
    duplicateInput.name,
    revision.source_script_revision_id,
    duplicateInput.items,
    [],
    [],
    actor.userId,
    now,
  );
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO schedules (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, is_default, current_revision_id, approved_revision_id, details_json, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'working', ?5, ?6, ?7, 0, ?8, NULL, ?9, 1, NULL, ?10, ?10)`,
    ).bind(
      scheduleId,
      actor.workspaceId,
      projectId,
      input.title,
      `Duplicated from ${source.title}`,
      actor.userId,
      rankBetween(last?.sort_rank, undefined),
      prepared.id,
      JSON.stringify({ duplicatedFromScheduleId: sourceId, duplicatedFromRevisionId: revision.id }),
      now,
    ),
    ...preparedStatements(context.env.DB, prepared),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule",
      "schedules",
      scheduleId,
      input.title,
      now,
    ),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "schedule_revision",
      "schedule_revisions",
      prepared.id,
      prepared.name,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "schedule.duplicated",
      objectType: "schedule",
      objectId: scheduleId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { sourceScheduleId: sourceId, sourceRevisionId: revision.id },
    }),
  ]);
  return ok(
    context,
    await loadScheduleView(context.env.DB, actor.workspaceId, projectId, scheduleId),
    201,
  );
});

operationsRoutes.get("/schedules/:scheduleId/revisions/:revisionId/export.csv", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const scheduleId = requiredParam(context.req.param("scheduleId"), "scheduleId");
  const revisionId = requiredParam(context.req.param("revisionId"), "revisionId");
  const revision = await requireRevision(context.env.DB, actor.workspaceId, projectId, revisionId);
  if (revision.schedule_id !== scheduleId)
    throw new HttpError(404, "not_found", "The schedule revision was not found.");
  const items = await loadScheduleItems(context.env.DB, actor.workspaceId, projectId, revisionId);
  const lines = [
    [
      "Rank",
      "Type",
      "Scene ID",
      "Title",
      "Shoot date",
      "Unit",
      "Day",
      "Pages (eighths)",
      "Prep ms",
      "Setup ms",
      "Shoot ms",
      "Move ms",
    ],
    ...items.map((item) => [
      item.sort_rank,
      item.item_type,
      item.scene_id ?? "",
      item.title ?? "",
      item.shoot_date ?? "",
      item.unit ?? "",
      String(item.day_count ?? ""),
      String(item.page_eighths),
      String(item.prep_duration_ms),
      String(item.setup_duration_ms),
      String(item.shoot_duration_ms),
      String(item.move_duration_ms),
    ]),
  ];
  return csvResponse(lines, `${safeFileName(revision.name)}.csv`);
});

operationsRoutes.post("/conflicts/:conflictId/resolve", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const conflictId = requiredParam(context.req.param("conflictId"), "conflictId");
  const input = conflictResolutionSchema.parse(await context.req.json());
  const current = await context.env.DB.prepare(
    "SELECT id, status, version FROM resource_conflicts WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
  )
    .bind(conflictId, actor.workspaceId, projectId)
    .first<{ id: string; status: string; version: number }>();
  if (!current) throw new HttpError(404, "not_found", "The schedule conflict was not found.");
  if (current.status !== "open")
    throw new HttpError(
      409,
      "conflict_already_closed",
      "The schedule conflict has already been resolved or overridden.",
    );
  const expected = parseIfMatch(context.req.header("If-Match"));
  const guard = versionGuard(
    context.env.DB,
    "resource_conflicts",
    conflictId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        "UPDATE resource_conflicts SET status = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
      ).bind(input.resolution, now, conflictId, actor.workspaceId, projectId),
      context.env.DB.prepare(
        "INSERT INTO conflict_resolutions (id, workspace_id, project_id, resource_conflict_id, resolution, reason, actor_user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        conflictId,
        input.resolution,
        input.reason,
        actor.userId,
        input.expiresAt ?? null,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: `schedule.conflict_${input.resolution}`,
        objectType: "resource_conflict",
        objectId: conflictId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { reason: input.reason, expiresAt: input.expiresAt ?? null },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(409, "version_conflict", "This conflict changed in another session.", {
        expectedVersion: expected,
      });
    throw error;
  }
  return ok(context, {
    id: conflictId,
    status: input.resolution,
    version: expected + 1,
    resolvedAt: now,
  });
});

operationsRoutes.get("/shoot-days", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const result = await context.env.DB.prepare(
    `SELECT sd.id, sd.title, sd.status, sd.summary, sd.schedule_revision_id, sd.shoot_date,
            sd.unit, sd.day_count, sd.timezone, sd.general_call_at, sd.estimated_start_at,
            sd.estimated_wrap_at, sd.readiness_state, sd.version, sd.archived_at, sd.updated_at,
            sr.name AS revision_name, s.current_revision_id,
            (SELECT COUNT(*) FROM resource_conflicts rc WHERE rc.schedule_revision_id = sd.schedule_revision_id AND (rc.shoot_day_id IS NULL OR rc.shoot_day_id = sd.id) AND rc.status = 'open') AS open_conflicts,
            (SELECT COUNT(*) FROM call_sheet_drafts csd WHERE csd.shoot_day_id = sd.id AND csd.archived_at IS NULL) AS call_sheet_count
       FROM shoot_days sd
       LEFT JOIN schedule_revisions sr ON sr.id = sd.schedule_revision_id
       LEFT JOIN schedules s ON s.id = sr.schedule_id
      WHERE sd.workspace_id = ?1 AND sd.project_id = ?2 AND sd.archived_at IS NULL
      ORDER BY sd.shoot_date, sd.unit, sd.day_count, sd.id`,
  )
    .bind(actor.workspaceId, projectId)
    .all<Record<string, unknown>>();
  return ok(context, { items: result.results.map(shootDayView) });
});

operationsRoutes.post("/shoot-days", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const input = shootDayCreateSchema.parse(await context.req.json());
  const revision = await requireRevision(
    context.env.DB,
    actor.workspaceId,
    projectId,
    input.scheduleRevisionId,
  );
  const dayBreak = await context.env.DB.prepare(
    `SELECT * FROM schedule_items WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3
      AND schedule_revision_id = ?4 AND item_type = 'day_break' LIMIT 1`,
  )
    .bind(input.dayBreakItemId, actor.workspaceId, projectId, revision.id)
    .first<ScheduleItemRow>();
  if (!dayBreak)
    throw new HttpError(
      422,
      "day_break_required",
      "Select a day break from the pinned schedule revision.",
    );
  if (input.baseLocationId)
    await validateScopedIds(
      context.env.DB,
      "locations",
      [input.baseLocationId],
      actor.workspaceId,
      projectId,
    );
  if (input.primaryLocationId)
    await validateScopedIds(
      context.env.DB,
      "locations",
      [input.primaryLocationId],
      actor.workspaceId,
      projectId,
    );
  const nextBreak = await context.env.DB.prepare(
    "SELECT sort_rank FROM schedule_items WHERE schedule_revision_id = ?1 AND item_type = 'day_break' AND sort_rank > ?2 ORDER BY sort_rank LIMIT 1",
  )
    .bind(revision.id, dayBreak.sort_rank)
    .first<{ sort_rank: string }>();
  const dayItems = await context.env.DB.prepare(
    `SELECT * FROM schedule_items WHERE schedule_revision_id = ?1 AND sort_rank >= ?2
      AND (?3 IS NULL OR sort_rank < ?3) ORDER BY sort_rank`,
  )
    .bind(revision.id, dayBreak.sort_rank, nextBreak?.sort_rank ?? null)
    .all<ScheduleItemRow>();
  const totals = calculateRevisionTotals(dayItems.results.map(scheduleArtifactFromRow));
  const shootDate = input.shootDate ?? dayBreak.shoot_date;
  if (!shootDate)
    throw new HttpError(
      422,
      "shoot_date_required",
      "The selected day break has no shoot date; enter one before generating the shoot day.",
    );
  const unit = dayBreak.unit ?? "Main";
  const dayCount = dayBreak.day_count ?? 1;
  const generalCallAt = input.generalCallAt ?? null;
  const estimatedStartAt = input.estimatedStartAt ?? generalCallAt;
  const estimatedWrapAt = generalCallAt === null ? null : generalCallAt + totals.totalMs;
  const id = createUuidV7();
  const now = Date.now();
  const title = input.title ?? `${unit} — Shoot Day ${dayCount}`;
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM shoot_days WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO shoot_days
          (id, workspace_id, project_id, schedule_revision_id, title, status, summary, owner_user_id,
           sort_rank, shoot_date, unit, day_count, timezone, general_call_at, estimated_start_at,
           estimated_wrap_at, base_location_id, primary_location_id, hard_constraints_json,
           readiness_state, details_json, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'planned', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, 'blocked', ?19, 1, NULL, ?20, ?20)`,
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        revision.id,
        title,
        `${dayItems.results.length - 1} scheduled strips pinned to revision ${revision.revision_number}.`,
        actor.userId,
        rankBetween(last?.sort_rank, undefined),
        shootDate,
        unit,
        dayCount,
        input.timezone ?? dayBreak.timezone ?? "Europe/Amsterdam",
        generalCallAt,
        estimatedStartAt,
        estimatedWrapAt,
        input.baseLocationId ?? dayBreak.location_id,
        input.primaryLocationId ?? dayBreak.location_id,
        JSON.stringify(input.hardConstraints),
        JSON.stringify({
          dayBreakItemId: dayBreak.id,
          scheduleTotals: totals,
          scheduleItemIds: dayItems.results.map((item) => item.id),
        }),
        now,
      ),
      context.env.DB.prepare(
        "UPDATE resource_conflicts SET shoot_day_id = ?1, updated_at = ?2, version = version + 1 WHERE schedule_revision_id = ?3 AND shoot_day_id IS NULL AND workspace_id = ?4 AND project_id = ?5",
      ).bind(id, now, revision.id, actor.workspaceId, projectId),
      registryStatement(
        context.env.DB,
        actor.workspaceId,
        projectId,
        "shoot_day",
        "shoot_days",
        id,
        title,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "shoot_day.generated",
        objectType: "shoot_day",
        objectId: id,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: {
          scheduleRevisionId: revision.id,
          dayBreakItemId: dayBreak.id,
          itemCount: dayItems.results.length,
          totals,
        },
      }),
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(
        409,
        "shoot_day_exists",
        "This schedule revision already generated the selected unit and day count.",
      );
    throw error;
  }
  return ok(
    context,
    await requireShootDayView(context.env.DB, actor.workspaceId, projectId, id),
    201,
  );
});

operationsRoutes.patch("/shoot-days/:shootDayId", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const id = requiredParam(context.req.param("shootDayId"), "shootDayId");
  const input = shootDayPatchSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const current = await context.env.DB.prepare(
    "SELECT title, status, readiness_state FROM shoot_days WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
  )
    .bind(id, actor.workspaceId, projectId)
    .first<{ title: string; status: string; readiness_state: string }>();
  if (!current) throw new HttpError(404, "not_found", "The shoot day was not found.");
  const guard = versionGuard(
    context.env.DB,
    "shoot_days",
    id,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        "UPDATE shoot_days SET title = ?1, status = ?2, readiness_state = ?3, version = version + 1, updated_at = ?4 WHERE id = ?5 AND workspace_id = ?6 AND project_id = ?7",
      ).bind(
        input.title ?? current.title,
        input.status ?? current.status,
        input.readinessState ?? current.readiness_state,
        now,
        id,
        actor.workspaceId,
        projectId,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "shoot_day.updated",
        objectType: "shoot_day",
        objectId: id,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { fields: Object.keys(input) },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(409, "version_conflict", "This shoot day changed in another session.", {
        expectedVersion: expected,
      });
    throw error;
  }
  return ok(context, await requireShootDayView(context.env.DB, actor.workspaceId, projectId, id));
});

operationsRoutes.get("/call-sheets", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const [drafts, recipients, people, shootDays] = await Promise.all([
    context.env.DB.prepare(
      `SELECT csd.id, csd.title, csd.status, csd.shoot_day_id, csd.source_schedule_revision_id,
              csd.call_sheet_type, csd.issue_number_next, csd.timezone, csd.paper_size, csd.layout,
              csd.manual_weather_json, csd.version, csd.archived_at, csd.updated_at,
              sd.shoot_date, sd.unit, sd.day_count,
              (SELECT COUNT(*) FROM call_sheet_recipients cr WHERE cr.call_sheet_draft_id = csd.id AND cr.archived_at IS NULL) AS recipient_count,
              (SELECT COUNT(*) FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id) AS issue_count,
              (SELECT ci.id FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id ORDER BY ci.issue_number DESC LIMIT 1) AS latest_issue_id,
              (SELECT ci.issue_number FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id ORDER BY ci.issue_number DESC LIMIT 1) AS latest_issue_number
         FROM call_sheet_drafts csd LEFT JOIN shoot_days sd ON sd.id = csd.shoot_day_id
        WHERE csd.workspace_id = ?1 AND csd.project_id = ?2 AND csd.archived_at IS NULL
        ORDER BY csd.updated_at DESC, csd.id DESC`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT cri.id AS recipient_issue_id, cri.call_sheet_issue_id, cri.call_sheet_recipient_id,
              cri.share_link_id, p.title AS person_name, cr.label, cr.required_confirmation,
              ci.issue_number, ci.call_sheet_draft_id,
              sl.public_locator, sl.expires_at, sl.revoked_at,
              (SELECT MIN(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'viewed') AS viewed_at,
              (SELECT MAX(c.confirmed_at) FROM confirmations c WHERE c.call_sheet_recipient_issue_id = cri.id) AS confirmed_at,
              (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'provider_failed') AS failed_at,
              (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'not_configured') AS not_configured_at
         FROM call_sheet_recipient_issues cri
         JOIN call_sheet_issues ci ON ci.id = cri.call_sheet_issue_id
         JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id
         JOIN people p ON p.id = cr.person_id
         LEFT JOIN share_links sl ON sl.id = cri.share_link_id
        WHERE cri.workspace_id = ?1 AND cri.project_id = ?2
        ORDER BY ci.created_at DESC, p.title`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT p.id, p.title,
              (SELECT cp.value FROM contact_points cp WHERE cp.person_id = p.id AND cp.type = 'email' AND cp.archived_at IS NULL ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS email,
              (SELECT cp.value FROM contact_points cp WHERE cp.person_id = p.id AND cp.type = 'phone' AND cp.archived_at IS NULL ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS phone
         FROM people p WHERE p.workspace_id = ?1 AND (p.project_id = ?2 OR p.project_id IS NULL) AND p.archived_at IS NULL
        ORDER BY p.title LIMIT 1000`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT id, title, shoot_date, unit, day_count, timezone, general_call_at, estimated_wrap_at,
              schedule_revision_id, version FROM shoot_days
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
        ORDER BY shoot_date, unit, day_count`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
  ]);
  return ok(context, {
    drafts: drafts.results.map(callSheetDraftView),
    recipientIssues: recipients.results.map(recipientIssueView),
    people: people.results.map((person) => ({
      id: stringValue(person.id),
      title: stringValue(person.title),
      email: nullableString(person.email),
      phone: nullableString(person.phone),
    })),
    shootDays: shootDays.results.map((day) => ({
      id: stringValue(day.id),
      title: stringValue(day.title),
      shootDate: nullableString(day.shoot_date),
      unit: stringValue(day.unit),
      dayCount: numberValue(day.day_count),
      timezone: stringValue(day.timezone),
      generalCallAt: nullableNumber(day.general_call_at),
      estimatedWrapAt: nullableNumber(day.estimated_wrap_at),
      scheduleRevisionId: nullableString(day.schedule_revision_id),
      version: numberValue(day.version),
    })),
    providers: {
      email: "not_configured" as const,
      sms: "not_configured" as const,
      manualFallback: "Copy each secure link, download/print, and record manual confirmation.",
    },
  });
});

operationsRoutes.post("/call-sheets", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const input = callSheetCreateSchema.parse(await context.req.json());
  const shootDay = input.shootDayId
    ? await requireShootDay(context.env.DB, actor.workspaceId, projectId, input.shootDayId)
    : null;
  const personIds = input.recipients.map((recipient) => recipient.personId);
  if (new Set(personIds).size !== personIds.length)
    throw new HttpError(
      422,
      "duplicate_recipient",
      "Each person can appear only once on a call-sheet draft.",
    );
  await validatePeople(context.env.DB, personIds, actor.workspaceId, projectId);
  const generatedSections = shootDay
    ? await callSheetSectionsFromShootDay(
        context.env.DB,
        actor.workspaceId,
        projectId,
        shootDay,
        input.manualWeather,
      )
    : [];
  const sections = [...generatedSections, ...input.sections];
  if (sections.length === 0)
    sections.push({
      sectionType: "overview",
      title: "Overview",
      body: "Complete the call-sheet details before issue.",
      visible: true,
    });
  const id = createUuidV7();
  const now = Date.now();
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM call_sheet_drafts WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO call_sheet_drafts
        (id, workspace_id, project_id, shoot_day_id, source_schedule_revision_id, title, status,
         summary, owner_user_id, sort_rank, call_sheet_type, issue_number_next, timezone, paper_size,
         layout, manual_weather_json, details_json, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13, ?14, ?15, 1, NULL, ?16, ?16)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      shootDay?.id ?? null,
      shootDay?.schedule_revision_id ?? null,
      input.title,
      shootDay
        ? `Generated from ${shootDay.title}; source revision remains pinned.`
        : "Standalone call-sheet draft.",
      actor.userId,
      rankBetween(last?.sort_rank, undefined),
      input.callSheetType,
      shootDay?.timezone ?? "Europe/Amsterdam",
      input.paperSize,
      input.layout,
      JSON.stringify(input.manualWeather),
      JSON.stringify({
        providerState: "not_configured",
        sourceShootDayVersion: shootDay?.version ?? null,
      }),
      now,
    ),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "call_sheet_draft",
      "call_sheet_drafts",
      id,
      input.title,
      now,
    ),
  ];
  let priorSectionRank: string | undefined;
  for (const section of sections) {
    const sectionId = createUuidV7();
    const sectionRank = rankBetween(priorSectionRank, undefined);
    priorSectionRank = sectionRank;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO call_sheet_sections
        (id, workspace_id, project_id, call_sheet_draft_id, section_type, title, visible,
         columns_json, body_json, sort_rank, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '[]', ?8, ?9, 1, NULL, ?10, ?10)`,
      ).bind(
        sectionId,
        actor.workspaceId,
        projectId,
        id,
        section.sectionType,
        section.title,
        section.visible ? 1 : 0,
        JSON.stringify({ text: section.body }),
        sectionRank,
        now,
      ),
    );
  }
  let priorRecipientRank: string | undefined;
  for (const recipient of input.recipients) {
    const recipientId = createUuidV7();
    const recipientRank = rankBetween(priorRecipientRank, undefined);
    priorRecipientRank = recipientRank;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO call_sheet_recipients
        (id, workspace_id, project_id, call_sheet_draft_id, person_id, label, private_note,
         required_confirmation, recipient_projection_json, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, NULL, ?10, ?10)`,
      ).bind(
        recipientId,
        actor.workspaceId,
        projectId,
        id,
        recipient.personId,
        recipient.label,
        recipient.privateNote || null,
        recipient.requiredConfirmation ? 1 : 0,
        JSON.stringify({ includePrivateNote: true, includeRates: false, sortRank: recipientRank }),
        now,
      ),
    );
    let priorCallRank: string | undefined;
    for (const call of recipient.calls) {
      const callRank = rankBetween(priorCallRank, undefined);
      priorCallRank = callRank;
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO call_sheet_person_calls
          (id, workspace_id, project_id, call_sheet_draft_id, person_id, call_type, call_at,
           timezone, sort_rank, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, NULL, ?10, ?10)`,
        ).bind(
          createUuidV7(),
          actor.workspaceId,
          projectId,
          id,
          recipient.personId,
          call.label,
          call.callAt,
          call.timezone,
          callRank,
          now,
        ),
      );
    }
  }
  statements.push(
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "call_sheet.draft_created",
      objectType: "call_sheet_draft",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        shootDayId: shootDay?.id ?? null,
        sourceScheduleRevisionId: shootDay?.schedule_revision_id ?? null,
        recipientCount: input.recipients.length,
        sectionCount: sections.length,
      },
    }),
  );
  await context.env.DB.batch(statements);
  return ok(
    context,
    await requireCallSheetDraftView(context.env.DB, actor.workspaceId, projectId, id),
    201,
  );
});

operationsRoutes.patch("/call-sheets/:draftId", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const draftId = requiredParam(context.req.param("draftId"), "draftId");
  const input = callSheetPatchSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const current = await requireCallSheetDraft(
    context.env.DB,
    actor.workspaceId,
    projectId,
    draftId,
  );
  const guard = versionGuard(
    context.env.DB,
    "call_sheet_drafts",
    draftId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        "UPDATE call_sheet_drafts SET title = ?1, paper_size = ?2, layout = ?3, manual_weather_json = ?4, status = 'draft', version = version + 1, updated_at = ?5 WHERE id = ?6 AND workspace_id = ?7 AND project_id = ?8",
      ).bind(
        input.title ?? current.title,
        input.paperSize ?? current.paper_size,
        input.layout ?? current.layout,
        input.manualWeather ? JSON.stringify(input.manualWeather) : current.manual_weather_json,
        now,
        draftId,
        actor.workspaceId,
        projectId,
      ),
      staleReadinessStatement(
        context.env.DB,
        actor.workspaceId,
        projectId,
        "call_sheet_draft",
        draftId,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "call_sheet.draft_updated",
        objectType: "call_sheet_draft",
        objectId: draftId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { fields: Object.keys(input) },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(409, "version_conflict", "This call sheet changed in another session.", {
        expectedVersion: expected,
      });
    throw error;
  }
  return ok(
    context,
    await requireCallSheetDraftView(context.env.DB, actor.workspaceId, projectId, draftId),
  );
});

operationsRoutes.post("/call-sheets/:draftId/issue", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  assertAllowed(actor, "artifact.issue");
  const draftId = requiredParam(context.req.param("draftId"), "draftId");
  const input = callSheetIssueSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const draft = await requireCallSheetDraft(context.env.DB, actor.workspaceId, projectId, draftId);
  if (draft.version !== expected)
    throw new HttpError(409, "version_conflict", "This call-sheet draft changed before issue.", {
      expectedVersion: expected,
      currentVersion: draft.version,
    });
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: `call_sheet.issue:${draftId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef)
    return ok(context, {
      ...(await requireCallSheetIssueView(
        context.env.DB,
        actor.workspaceId,
        projectId,
        lease.replayRef,
      )),
      linksRevealed: false,
      recipientLinks: [],
    });
  const project = await context.env.DB.prepare(
    "SELECT title, company FROM projects WHERE id = ?1 AND workspace_id = ?2 LIMIT 1",
  )
    .bind(projectId, actor.workspaceId)
    .first<{ title: string; company: string }>();
  if (!project) throw new HttpError(404, "not_found", "The project was not found.");
  const sections = await context.env.DB.prepare(
    "SELECT id, section_type, title, body_json, sort_rank FROM call_sheet_sections WHERE call_sheet_draft_id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL AND visible = 1 ORDER BY sort_rank",
  )
    .bind(draftId, actor.workspaceId, projectId)
    .all<{
      id: string;
      section_type: string;
      title: string;
      body_json: string;
      sort_rank: string;
    }>();
  const recipients = await loadDraftRecipients(
    context.env.DB,
    actor.workspaceId,
    projectId,
    draftId,
  );
  if (recipients.length === 0) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw new HttpError(
      409,
      "recipient_required",
      "Add at least one recipient before issuing a call sheet.",
    );
  }
  if (input.supersedesIssueId)
    await requireSupersededCallSheet(
      context.env.DB,
      actor.workspaceId,
      projectId,
      draftId,
      input.supersedesIssueId,
    );
  const issueId = createUuidV7();
  const now = Date.now();
  const expiresAt = input.linkExpiresAt ?? now + 14 * 24 * 60 * 60_000;
  if (expiresAt < now + 5 * 60_000 || expiresAt > now + 90 * 24 * 60 * 60_000) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw new HttpError(
      422,
      "invalid_share_expiry",
      "Recipient links must expire between five minutes and ninety days after issue.",
    );
  }
  const recipientSecrets = await Promise.all(
    recipients.map(async (recipient) => {
      const recipientIssueId = createUuidV7();
      const shareId = createUuidV7();
      const locator = randomToken(18);
      const secret = randomToken(32);
      return {
        recipient,
        recipientIssueId,
        shareId,
        locator,
        secret,
        digest: await secretDigest(secret),
      };
    }),
  );
  const artifactRecipients: CallSheetRecipientInput[] = recipientSecrets.map(
    ({ recipient, recipientIssueId }) => ({
      recipientId: recipient.id,
      recipientIssueId,
      displayName: recipient.person_name,
      roleLabel: recipient.label ?? "Production",
      ...(recipient.email ? { email: recipient.email } : {}),
      ...(recipient.phone ? { phone: recipient.phone } : {}),
      calls: recipient.calls.map((call) => ({
        label: call.call_type,
        time: formatLocalTime(call.call_at, call.timezone),
      })),
      privateNote: recipient.private_note ?? "",
    }),
  );
  const built = await buildCallSheetIssue({
    issueId,
    issueNumber: draft.issue_number_next,
    projectTitle: project.title,
    companyName: project.company,
    shootDate: draft.shoot_date ?? "1970-01-01",
    confidentiality: input.confidentiality,
    sections: sections.results.map((section) => ({
      key: section.section_type,
      title: section.title,
      body: bodyText(section.body_json),
    })),
    recipients: artifactRecipients,
  });
  const guard = versionGuard(
    context.env.DB,
    "call_sheet_drafts",
    draftId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const statements: D1PreparedStatement[] = [
    guard.insert,
    context.env.DB.prepare(
      `INSERT INTO call_sheet_issues
        (id, workspace_id, project_id, call_sheet_draft_id, shoot_day_id, source_schedule_revision_id,
         issue_number, title, confidentiality_marking, canonical_snapshot_json, content_hash,
         r2_object_key, supersedes_issue_id, created_by_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13, ?14)`,
    ).bind(
      issueId,
      actor.workspaceId,
      projectId,
      draftId,
      draft.shoot_day_id,
      draft.source_schedule_revision_id,
      draft.issue_number_next,
      `${draft.title} — issue ${draft.issue_number_next}`,
      input.confidentiality,
      built.canonicalJson,
      built.contentHash,
      input.supersedesIssueId ?? null,
      actor.userId,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE call_sheet_drafts SET status = 'issued', issue_number_next = issue_number_next + 1, version = version + 1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
    ).bind(now, draftId, actor.workspaceId, projectId),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "call_sheet_issue",
      "call_sheet_issues",
      issueId,
      `${draft.title} — issue ${draft.issue_number_next}`,
      now,
    ),
  ];
  for (const secretRecord of recipientSecrets) {
    const variant = built.variants.get(secretRecord.recipientIssueId);
    if (!variant)
      throw new HttpError(
        500,
        "recipient_projection_failed",
        "A recipient-safe call-sheet variant could not be created.",
      );
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO share_links
          (id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
           object_id, allowed_actions_json, field_projection_json, created_by_user_id,
           expires_at, revoked_at, last_used_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'call_sheet_recipient', 'call_sheet_recipient_issue', ?6,
                 '["confirm","view"]', ?7, ?8, ?9, NULL, NULL, ?10)`,
      ).bind(
        secretRecord.shareId,
        actor.workspaceId,
        projectId,
        secretRecord.locator,
        secretRecord.digest,
        secretRecord.recipientIssueId,
        JSON.stringify({
          version: 1,
          source: "immutable_recipient_variant",
          includeRates: false,
          includeOtherRecipients: false,
        }),
        actor.userId,
        expiresAt,
        now,
      ),
      context.env.DB.prepare(
        `INSERT INTO call_sheet_recipient_issues
          (id, workspace_id, project_id, call_sheet_issue_id, call_sheet_recipient_id, share_link_id,
           variant_snapshot_json, content_hash, r2_object_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)`,
      ).bind(
        secretRecord.recipientIssueId,
        actor.workspaceId,
        projectId,
        issueId,
        secretRecord.recipient.id,
        secretRecord.shareId,
        variant.json,
        variant.hash,
        now,
      ),
      registryStatement(
        context.env.DB,
        actor.workspaceId,
        projectId,
        "call_sheet_recipient_issue",
        "call_sheet_recipient_issues",
        secretRecord.recipientIssueId,
        `${draft.title} — ${secretRecord.recipient.person_name}`,
        now,
      ),
      context.env.DB.prepare(
        "INSERT INTO delivery_events (id, workspace_id, project_id, call_sheet_recipient_issue_id, outbox_entry_id, event_type, evidence_json, idempotency_key, occurred_at, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 'issued', ?5, ?6, ?7, ?7)",
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        secretRecord.recipientIssueId,
        JSON.stringify({ method: "secure_link", provider: "manual" }),
        `issued:${issueId}:${secretRecord.recipientIssueId}`,
        now,
      ),
      context.env.DB.prepare(
        "INSERT INTO delivery_events (id, workspace_id, project_id, call_sheet_recipient_issue_id, outbox_entry_id, event_type, evidence_json, idempotency_key, occurred_at, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 'not_configured', ?5, ?6, ?7, ?7)",
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        secretRecord.recipientIssueId,
        JSON.stringify({ email: "not_configured", sms: "not_configured", fallback: "secure_link" }),
        `provider-state:${issueId}:${secretRecord.recipientIssueId}`,
        now,
      ),
    );
  }
  statements.push(
    staleReadinessStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "call_sheet_issue",
      issueId,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: input.supersedesIssueId ? "call_sheet.correction_issued" : "call_sheet.issued",
      objectType: "call_sheet_issue",
      objectId: issueId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        draftId,
        issueNumber: draft.issue_number_next,
        sourceScheduleRevisionId: draft.source_schedule_revision_id,
        supersedesIssueId: input.supersedesIssueId ?? null,
        recipientCount: recipientSecrets.length,
        contentHash: built.contentHash,
      },
    }),
    completeIdempotentOperation(context.env.DB, lease.id, issueId, 201),
    guard.remove,
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    if (isConstraintError(error))
      throw new HttpError(
        409,
        "issue_conflict",
        "The call sheet changed or was issued in another session.",
      );
    throw error;
  }
  return ok(
    context,
    {
      ...(await requireCallSheetIssueView(context.env.DB, actor.workspaceId, projectId, issueId)),
      linksRevealed: true,
      recipientLinks: recipientSecrets.map((entry) => ({
        recipientIssueId: entry.recipientIssueId,
        displayName: entry.recipient.person_name,
        expiresAt,
        url: `${context.env.APP_ORIGIN}/s/${encodeURIComponent(entry.locator)}#${entry.secret}`,
      })),
    },
    201,
  );
});

operationsRoutes.post(
  "/call-sheet-recipient-issues/:recipientIssueId/confirm-manual",
  requireJson,
  async (context) => {
    const { actor, projectId } = await editableProjectContext(context);
    const recipientIssueId = requiredParam(
      context.req.param("recipientIssueId"),
      "recipientIssueId",
    );
    const input = manualConfirmationSchema.parse(await context.req.json());
    await requireRecipientIssue(context.env.DB, actor.workspaceId, projectId, recipientIssueId);
    const lease = await beginIdempotentOperation({
      db: context.env.DB,
      workspaceId: actor.workspaceId,
      actorFingerprint: `user:${actor.userId}`,
      operation: `call_sheet.manual_confirmation:${recipientIssueId}`,
      key: context.req.header("Idempotency-Key"),
      requestBody: input,
    });
    if (!lease.replayRef) {
      const id = createUuidV7();
      const now = Date.now();
      try {
        await context.env.DB.batch([
          context.env.DB.prepare(
            "INSERT INTO confirmations (id, workspace_id, project_id, call_sheet_recipient_issue_id, confirmed_by_type, confirmed_by_user_id, share_link_id, note, idempotency_key, confirmed_at, created_at) VALUES (?1, ?2, ?3, ?4, 'producer_manual', ?5, NULL, ?6, ?7, ?8, ?8)",
          ).bind(
            id,
            actor.workspaceId,
            projectId,
            recipientIssueId,
            actor.userId,
            input.note || null,
            context.req.header("Idempotency-Key"),
            now,
          ),
          completeIdempotentOperation(context.env.DB, lease.id, id, 201),
          auditStatement(context.env.DB, {
            workspaceId: actor.workspaceId,
            projectId,
            actor,
            action: "call_sheet.manually_confirmed",
            objectType: "call_sheet_recipient_issue",
            objectId: recipientIssueId,
            requestId: context.get("requestId"),
            occurredAt: now,
            details: { confirmationId: id, noteProvided: Boolean(input.note) },
          }),
        ]);
      } catch (error) {
        await failIdempotentOperation(context.env.DB, lease.id);
        throw error;
      }
    }
    return ok(
      context,
      await recipientIssueStatus(context.env.DB, actor.workspaceId, projectId, recipientIssueId),
    );
  },
);

operationsRoutes.post(
  "/call-sheet-recipient-issues/:recipientIssueId/link-copied",
  requireJson,
  async (context) => {
    const { actor, projectId } = await editableProjectContext(context);
    const recipientIssueId = requiredParam(
      context.req.param("recipientIssueId"),
      "recipientIssueId",
    );
    await requireRecipientIssue(context.env.DB, actor.workspaceId, projectId, recipientIssueId);
    const input = z
      .object({})
      .strict()
      .parse(await context.req.json());
    const lease = await beginIdempotentOperation({
      db: context.env.DB,
      workspaceId: actor.workspaceId,
      actorFingerprint: `user:${actor.userId}`,
      operation: `call_sheet.link_copied:${recipientIssueId}`,
      key: context.req.header("Idempotency-Key"),
      requestBody: input,
    });
    if (!lease.replayRef) {
      const eventId = createUuidV7();
      const now = Date.now();
      try {
        await context.env.DB.batch([
          context.env.DB.prepare(
            "INSERT INTO delivery_events (id, workspace_id, project_id, call_sheet_recipient_issue_id, outbox_entry_id, event_type, evidence_json, idempotency_key, occurred_at, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 'link_copied', ?5, ?6, ?7, ?7)",
          ).bind(
            eventId,
            actor.workspaceId,
            projectId,
            recipientIssueId,
            JSON.stringify({ actorUserId: actor.userId }),
            context.req.header("Idempotency-Key"),
            now,
          ),
          completeIdempotentOperation(context.env.DB, lease.id, eventId),
        ]);
      } catch (error) {
        await failIdempotentOperation(context.env.DB, lease.id);
        throw error;
      }
    }
    return ok(
      context,
      await recipientIssueStatus(context.env.DB, actor.workspaceId, projectId, recipientIssueId),
    );
  },
);

operationsRoutes.get("/production-packs", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const [drafts, pins, files, shootDays] = await Promise.all([
    context.env.DB.prepare(
      `SELECT ppd.id, ppd.title, ppd.status, ppd.summary, ppd.shoot_day_id, ppd.paper_size,
              ppd.confidentiality_marking, ppd.version, ppd.updated_at,
              (SELECT COUNT(*) FROM production_pack_items ppi WHERE ppi.production_pack_draft_id = ppd.id AND ppi.archived_at IS NULL) AS item_count,
              (SELECT COUNT(*) FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id) AS issue_count,
              (SELECT ppi.id FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_issue_id,
              (SELECT ppi.issue_number FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_issue_number,
              (SELECT ppi.manifest_hash FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_manifest_hash
         FROM production_pack_drafts ppd
        WHERE ppd.workspace_id = ?1 AND ppd.project_id = ?2 AND ppd.archived_at IS NULL
        ORDER BY ppd.updated_at DESC, ppd.id DESC`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT object_registry.id, object_registry.object_type, object_registry.domain_id, object_registry.title,
              object_registry.updated_at
         FROM object_registry
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
          AND object_type IN ('script_revision', 'schedule_revision', 'call_sheet_issue', 'sides_issue', 'report_snapshot', 'readiness_issue', 'shot_list', 'storyboard', 'technical_look_plan', 'risk_assessment', 'requirement', 'equipment_item', 'logistics_plan')
        ORDER BY updated_at DESC, id DESC LIMIT 500`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      `SELECT fv.id, f.title, fv.safe_display_name, fv.version_number, fv.byte_size, fv.mime_type,
              fv.sha256, fv.scan_state
         FROM file_versions fv JOIN files f ON f.id = fv.file_id
        WHERE fv.workspace_id = ?1 AND fv.project_id = ?2 AND f.archived_at IS NULL
        ORDER BY fv.created_at DESC LIMIT 500`,
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
    context.env.DB.prepare(
      "SELECT id, title, shoot_date, unit, day_count FROM shoot_days WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL ORDER BY shoot_date, unit, day_count",
    )
      .bind(actor.workspaceId, projectId)
      .all<Record<string, unknown>>(),
  ]);
  return ok(context, {
    drafts: drafts.results.map(packDraftView),
    availablePins: pins.results.map((pin) => ({
      id: stringValue(pin.id),
      objectType: stringValue(pin.object_type),
      domainId: stringValue(pin.domain_id),
      title: nullableString(pin.title) ?? stringValue(pin.object_type).replaceAll("_", " "),
      updatedAt: numberValue(pin.updated_at),
    })),
    availableFiles: files.results.map((file) => ({
      id: stringValue(file.id),
      title: stringValue(file.title),
      displayName: stringValue(file.safe_display_name),
      versionNumber: numberValue(file.version_number),
      byteSize: numberValue(file.byte_size),
      mimeType: stringValue(file.mime_type),
      sha256: stringValue(file.sha256),
      scanState: stringValue(file.scan_state),
    })),
    shootDays: shootDays.results.map((day) => ({
      id: stringValue(day.id),
      title: stringValue(day.title),
      shootDate: nullableString(day.shoot_date),
      unit: stringValue(day.unit),
      dayCount: numberValue(day.day_count),
    })),
  });
});

operationsRoutes.post("/production-packs", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  const input = packCreateSchema.parse(await context.req.json());
  if (input.shootDayId)
    await requireShootDay(context.env.DB, actor.workspaceId, projectId, input.shootDayId);
  await validatePackItems(context.env.DB, actor.workspaceId, projectId, input.items);
  const id = createUuidV7();
  const now = Date.now();
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM production_pack_drafts WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO production_pack_drafts
        (id, workspace_id, project_id, shoot_day_id, title, status, summary, owner_user_id,
         sort_rank, paper_size, confidentiality_marking, details_json, version, archived_at,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?11, 1, NULL, ?12, ?12)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.shootDayId ?? null,
      input.title,
      input.summary || null,
      actor.userId,
      rankBetween(last?.sort_rank, undefined),
      input.paperSize,
      input.confidentiality,
      JSON.stringify({
        itemCount: input.items.length,
        generation: { print: "available", zip: "not_configured" },
      }),
      now,
    ),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "production_pack_draft",
      "production_pack_drafts",
      id,
      input.title,
      now,
    ),
  ];
  let priorRank: string | undefined;
  for (const item of input.items) {
    const rank = rankBetween(priorRank, undefined);
    priorRank = rank;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO production_pack_items
        (id, workspace_id, project_id, production_pack_draft_id, object_id, file_version_id,
         revision_or_issue_id, section_type, title, include_file, permission_scope, sort_rank,
         version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, NULL, ?13, ?13)`,
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        id,
        item.objectId ?? null,
        item.fileVersionId ?? null,
        item.revisionOrIssueId ?? null,
        item.sectionType,
        item.title,
        item.includeFile ? 1 : 0,
        item.permissionScope,
        rank,
        now,
      ),
    );
  }
  statements.push(
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "production_pack.draft_created",
      objectType: "production_pack_draft",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { shootDayId: input.shootDayId ?? null, itemCount: input.items.length },
    }),
  );
  await context.env.DB.batch(statements);
  return ok(
    context,
    await requirePackDraftView(context.env.DB, actor.workspaceId, projectId, id),
    201,
  );
});

operationsRoutes.post("/production-packs/:draftId/issue", requireJson, async (context) => {
  const { actor, projectId } = await editableProjectContext(context);
  assertAllowed(actor, "artifact.issue");
  const draftId = requiredParam(context.req.param("draftId"), "draftId");
  const input = packIssueSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const draft = await requirePackDraft(context.env.DB, actor.workspaceId, projectId, draftId);
  if (draft.version !== expected)
    throw new HttpError(
      409,
      "version_conflict",
      "This production-pack draft changed before issue.",
      { expectedVersion: expected, currentVersion: draft.version },
    );
  if (input.supersedesIssueId)
    await requireSupersededPack(
      context.env.DB,
      actor.workspaceId,
      projectId,
      draftId,
      input.supersedesIssueId,
    );
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: `production_pack.issue:${draftId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef)
    return ok(
      context,
      await requirePackIssueView(context.env.DB, actor.workspaceId, projectId, lease.replayRef),
    );
  const rows = await context.env.DB.prepare(
    `SELECT ppi.id, ppi.object_id, ppi.file_version_id, ppi.revision_or_issue_id,
            ppi.section_type, ppi.title, ppi.include_file, ppi.permission_scope, ppi.sort_rank,
            fv.byte_size, fv.mime_type, fv.sha256, fv.safe_display_name
       FROM production_pack_items ppi
       LEFT JOIN file_versions fv ON fv.id = ppi.file_version_id AND fv.workspace_id = ppi.workspace_id AND fv.project_id = ppi.project_id
      WHERE ppi.production_pack_draft_id = ?1 AND ppi.workspace_id = ?2 AND ppi.project_id = ?3
        AND ppi.archived_at IS NULL ORDER BY ppi.sort_rank`,
  )
    .bind(draftId, actor.workspaceId, projectId)
    .all<Record<string, unknown>>();
  if (rows.results.length === 0) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw new HttpError(
      409,
      "pack_empty",
      "Add at least one pinned item before issuing the production pack.",
    );
  }
  const previous = await context.env.DB.prepare(
    "SELECT COALESCE(MAX(issue_number), 0) AS value FROM production_pack_issues WHERE production_pack_draft_id = ?1",
  )
    .bind(draftId)
    .first<{ value: number }>();
  const issueNumber = (previous?.value ?? 0) + 1;
  const issueId = createUuidV7();
  const now = Date.now();
  const usedPaths = new Set<string>();
  const entries: ProductionPackManifestEntry[] = rows.results.map((row, index) => {
    let path = safeRelativePath(
      stringValue(row.section_type),
      nullableString(row.safe_display_name) ?? stringValue(row.title),
      nullableString(row.file_version_id) ? "" : ".pdf",
    );
    if (usedPaths.has(path)) path = path.replace(/(\.[^.]+)?$/u, `-${index + 1}$1`);
    usedPaths.add(path);
    return {
      id: stringValue(row.id),
      sectionType: stringValue(row.section_type),
      title: stringValue(row.title),
      relativePath: path,
      sortRank: stringValue(row.sort_rank),
      objectId: nullableString(row.object_id),
      fileVersionId: nullableString(row.file_version_id),
      revisionOrIssueId: nullableString(row.revision_or_issue_id),
      byteSize: nullableNumber(row.byte_size),
      mimeType: nullableString(row.mime_type),
      sha256: nullableString(row.sha256),
    };
  });
  const built = await buildProductionPackManifest({
    issueId,
    issueNumber,
    projectId,
    draftId,
    createdAt: now,
    entries,
  });
  const guard = versionGuard(
    context.env.DB,
    "production_pack_drafts",
    draftId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const statements: D1PreparedStatement[] = [
    guard.insert,
    context.env.DB.prepare(
      "INSERT INTO production_pack_issues (id, workspace_id, project_id, production_pack_draft_id, issue_number, title, manifest_json, manifest_hash, r2_object_key, supersedes_issue_id, created_by_user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11)",
    ).bind(
      issueId,
      actor.workspaceId,
      projectId,
      draftId,
      issueNumber,
      `${draft.title} — issue ${issueNumber}`,
      built.json,
      built.hash,
      input.supersedesIssueId ?? null,
      actor.userId,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE production_pack_drafts SET status = 'issued', version = version + 1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
    ).bind(now, draftId, actor.workspaceId, projectId),
    registryStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "production_pack_issue",
      "production_pack_issues",
      issueId,
      `${draft.title} — issue ${issueNumber}`,
      now,
    ),
  ];
  for (const entry of entries)
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO production_pack_manifest_items (id, production_pack_issue_id, object_id, file_version_id, revision_or_issue_id, relative_path, byte_size, sha256, sort_rank, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      ).bind(
        createUuidV7(),
        issueId,
        entry.objectId,
        entry.fileVersionId,
        entry.revisionOrIssueId,
        entry.relativePath,
        entry.byteSize,
        entry.sha256,
        entry.sortRank,
        now,
      ),
    );
  statements.push(
    staleReadinessStatement(
      context.env.DB,
      actor.workspaceId,
      projectId,
      "production_pack_issue",
      issueId,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: input.supersedesIssueId
        ? "production_pack.correction_issued"
        : "production_pack.issued",
      objectType: "production_pack_issue",
      objectId: issueId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        draftId,
        issueNumber,
        supersedesIssueId: input.supersedesIssueId ?? null,
        manifestHash: built.hash,
        itemCount: entries.length,
        zipState: "not_configured",
      },
    }),
    completeIdempotentOperation(context.env.DB, lease.id, issueId, 201),
    guard.remove,
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    if (isConstraintError(error))
      throw new HttpError(
        409,
        "issue_conflict",
        "The production pack changed or was issued in another session.",
      );
    throw error;
  }
  return ok(
    context,
    await requirePackIssueView(context.env.DB, actor.workspaceId, projectId, issueId),
    201,
  );
});

operationsRoutes.get("/production-pack-issues/:issueId/manifest.json", async (context) => {
  const { actor, projectId } = await projectContext(context);
  const issueId = requiredParam(context.req.param("issueId"), "issueId");
  const issue = await context.env.DB.prepare(
    "SELECT title, manifest_json FROM production_pack_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
  )
    .bind(issueId, actor.workspaceId, projectId)
    .first<{ title: string; manifest_json: string }>();
  if (!issue) throw new HttpError(404, "not_found", "The production-pack issue was not found.");
  return new Response(issue.manifest_json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFileName(issue.title)}-manifest.json"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const operationsPrintRoutes = new Hono<AppEnv>();
operationsPrintRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

operationsPrintRoutes.get("/:artifactType/:artifactId", async (context) => {
  const actor = context.get("actor");
  const artifactType = z
    .enum(["schedule_revision", "call_sheet_issue", "production_pack_issue"])
    .parse(context.req.param("artifactType"));
  const artifactId = requiredParam(context.req.param("artifactId"), "artifactId");
  if (artifactType === "schedule_revision") {
    const revision = await context.env.DB.prepare(
      `SELECT sr.*, s.title AS schedule_title, p.paper_size, p.title AS project_title
         FROM schedule_revisions sr JOIN schedules s ON s.id = sr.schedule_id
         JOIN projects p ON p.id = sr.project_id
        WHERE sr.id = ?1 AND sr.workspace_id = ?2 LIMIT 1`,
    )
      .bind(artifactId, actor.workspaceId)
      .first<Record<string, unknown>>();
    if (!revision) throw new HttpError(404, "not_found", "The schedule revision was not found.");
    const projectId = stringValue(revision.project_id);
    await assertProjectAccess(context.env.DB, actor, projectId);
    const items = await loadScheduleItems(context.env.DB, actor.workspaceId, projectId, artifactId);
    const conflicts = await loadConflicts(context.env.DB, actor.workspaceId, projectId, artifactId);
    return ok(context, {
      title: stringValue(revision.schedule_title),
      subtitle: `${stringValue(revision.name)} · ${stringValue(revision.project_title)}`,
      issueLabel: `Schedule revision ${numberValue(revision.revision_number)}`,
      confidentiality: "Internal production plan",
      paperSize:
        stringValue(revision.paper_size) === "Letter" ? ("Letter" as const) : ("A4" as const),
      orientation: "landscape" as const,
      generatedAt: numberValue(revision.created_at),
      sections: [
        {
          id: "totals",
          heading: "Revision totals",
          html: totalsPrintHtml(parseObject(stringValue(revision.totals_json))),
          breakBefore: false,
        },
        { id: "strips", heading: "Stripboard", html: schedulePrintHtml(items), breakBefore: false },
        {
          id: "conflicts",
          heading: "Conflicts and resolutions",
          html: conflictsPrintHtml(conflicts),
          breakBefore: true,
        },
      ],
      footer: `Pinned revision ${artifactId} · ${stringValue(revision.content_hash)}`,
    });
  }
  if (artifactType === "call_sheet_issue") {
    const issue = await context.env.DB.prepare(
      `SELECT ci.*, csd.paper_size, p.title AS project_title
         FROM call_sheet_issues ci JOIN call_sheet_drafts csd ON csd.id = ci.call_sheet_draft_id
         JOIN projects p ON p.id = ci.project_id
        WHERE ci.id = ?1 AND ci.workspace_id = ?2 LIMIT 1`,
    )
      .bind(artifactId, actor.workspaceId)
      .first<Record<string, unknown>>();
    if (!issue) throw new HttpError(404, "not_found", "The call-sheet issue was not found.");
    await assertProjectAccess(context.env.DB, actor, stringValue(issue.project_id));
    const snapshot = parseObject(stringValue(issue.canonical_snapshot_json));
    return ok(context, {
      title: stringValue(issue.title),
      subtitle: stringValue(issue.project_title),
      issueLabel: `Call sheet · issue ${numberValue(issue.issue_number)}`,
      confidentiality: nullableString(issue.confidentiality_marking),
      paperSize: stringValue(issue.paper_size) === "Letter" ? ("Letter" as const) : ("A4" as const),
      orientation: "portrait" as const,
      generatedAt: numberValue(issue.created_at),
      sections: printSectionsFromSnapshot(snapshot),
      footer: `Immutable issue ${artifactId} · ${stringValue(issue.content_hash)}`,
    });
  }
  const issue = await context.env.DB.prepare(
    `SELECT ppi.*, ppd.paper_size, ppd.confidentiality_marking, p.title AS project_title
       FROM production_pack_issues ppi JOIN production_pack_drafts ppd ON ppd.id = ppi.production_pack_draft_id
       JOIN projects p ON p.id = ppi.project_id
      WHERE ppi.id = ?1 AND ppi.workspace_id = ?2 LIMIT 1`,
  )
    .bind(artifactId, actor.workspaceId)
    .first<Record<string, unknown>>();
  if (!issue) throw new HttpError(404, "not_found", "The production-pack issue was not found.");
  await assertProjectAccess(context.env.DB, actor, stringValue(issue.project_id));
  const manifest = parseObject(stringValue(issue.manifest_json));
  return ok(context, {
    title: stringValue(issue.title),
    subtitle: stringValue(issue.project_title),
    issueLabel: `Production pack · issue ${numberValue(issue.issue_number)}`,
    confidentiality: nullableString(issue.confidentiality_marking),
    paperSize: stringValue(issue.paper_size) === "Letter" ? ("Letter" as const) : ("A4" as const),
    orientation: "portrait" as const,
    generatedAt: numberValue(issue.created_at),
    sections: [
      {
        id: "manifest",
        heading: "Pinned manifest",
        html: manifestPrintHtml(manifest),
        breakBefore: false,
      },
    ],
    footer: `Immutable manifest ${artifactId} · ${stringValue(issue.manifest_hash)}`,
  });
});

type ScheduleItemInput = z.infer<typeof scheduleItemInputSchema>;
type RevisionInput = z.infer<typeof revisionInputSchema>;
type PackItemInput = z.infer<typeof packItemInputSchema>;

interface PreparedScheduleItem extends ScheduleItemRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly schedule_revision_id: string;
}

interface PreparedConflict {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly scheduleRevisionId: string;
  readonly conflictType:
    | "cast"
    | "crew"
    | "location"
    | "equipment"
    | "travel"
    | "turnaround"
    | "availability"
    | "legal_safety";
  readonly severity: "warning" | "blocker";
  readonly resourceType: string;
  readonly resourceId: string;
  readonly title: string;
  readonly evidenceJson: string;
  readonly fingerprint: string;
  readonly detectedAt: number;
}

interface PreparedRevision extends ScheduleRevisionRow {
  readonly items: readonly PreparedScheduleItem[];
  readonly conflicts: readonly PreparedConflict[];
  readonly revisionNumber: number;
}

async function projectContext(context: Context<AppEnv>) {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  return { actor, projectId };
}

async function editableProjectContext(context: Context<AppEnv>) {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  return { actor, projectId };
}

async function prepareRevision(
  workspaceId: string,
  projectId: string,
  scheduleId: string,
  revisionNumber: number,
  name: string,
  sourceScriptRevisionId: string | null,
  inputItems: readonly ScheduleItemInput[],
  availability: RevisionInput["availability"],
  travelDurations: RevisionInput["travelDurations"],
  authorUserId: string,
  now: number,
): Promise<PreparedRevision> {
  const revisionId = createUuidV7();
  let priorRank: string | undefined;
  const assignments: Array<{
    assignmentId: string;
    scheduleItemId: string;
    resourceType: "cast" | "crew" | "location" | "equipment" | "vehicle";
    resourceId: string;
    startMs: number;
    endMs: number;
    locationId?: string;
    unit: string;
    minimumTurnaroundMs: number;
  }> = [];
  const items: PreparedScheduleItem[] = inputItems.map((input) => {
    const id = createUuidV7();
    const rank = rankBetween(priorRank, undefined);
    priorRank = rank;
    for (const assignment of input.assignments) {
      assignments.push({
        assignmentId: createUuidV7(),
        scheduleItemId: id,
        resourceType: assignment.resourceType,
        resourceId: assignment.resourceId,
        startMs: assignment.startMs,
        endMs: assignment.endMs,
        ...(assignment.locationId ? { locationId: assignment.locationId } : {}),
        unit: assignment.unit,
        minimumTurnaroundMs: assignment.minimumTurnaroundMs,
      });
    }
    return {
      id,
      workspace_id: workspaceId,
      project_id: projectId,
      schedule_revision_id: revisionId,
      item_type: input.itemType,
      scene_id: input.sceneId ?? null,
      scene_segment_id: input.sceneSegmentId ?? null,
      title: input.title || null,
      shoot_date: input.shootDate ?? null,
      unit: input.unit,
      day_count: input.dayCount ?? null,
      general_call_local: input.generalCallLocal ?? null,
      estimated_start_local: input.estimatedStartLocal ?? null,
      estimated_wrap_local: input.estimatedWrapLocal ?? null,
      timezone: input.timezone,
      location_id: input.locationId ?? null,
      page_eighths: input.pageEighths,
      prep_duration_ms: input.prepDurationMs,
      setup_duration_ms: input.setupDurationMs,
      shoot_duration_ms: input.shootDurationMs,
      move_duration_ms: input.moveDurationMs,
      hard_constraints_json: JSON.stringify(input.hardConstraints),
      details_json: JSON.stringify({
        ...input.details,
        mealDurationMs: input.mealDurationMs,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        assignmentCount: input.assignments.length,
      }),
      sort_rank: rank,
      created_at: now,
    };
  });
  const totals = calculateRevisionTotals(items.map(scheduleArtifactFromRow));
  const detected = calculateRevisionConflicts({ assignments, availability, travelDurations });
  const conflicts: PreparedConflict[] = [];
  for (const conflict of detected)
    conflicts.push(await prepareConflict(workspaceId, projectId, revisionId, conflict, now));
  const encoded = canonicalJson({
    scheduleId,
    revisionNumber,
    name,
    sourceScriptRevisionId,
    totals,
    items: items.map(scheduleItemView),
    conflicts: conflicts.map((conflict) => ({
      type: conflict.conflictType,
      severity: conflict.severity,
      resourceType: conflict.resourceType,
      resourceId: conflict.resourceId,
      fingerprint: conflict.fingerprint,
    })),
  });
  const contentHash = await sha256(encoded);
  return {
    id: revisionId,
    workspace_id: workspaceId,
    project_id: projectId,
    schedule_id: scheduleId,
    revision_number: revisionNumber,
    revisionNumber,
    name,
    source_script_revision_id: sourceScriptRevisionId,
    status: "draft",
    content_hash: contentHash,
    totals_json: canonicalJson(totals),
    author_user_id: authorUserId,
    created_at: now,
    items,
    conflicts,
  };
}

async function prepareConflict(
  workspaceId: string,
  projectId: string,
  revisionId: string,
  conflict: ResourceConflict,
  now: number,
): Promise<PreparedConflict> {
  const conflictType =
    conflict.kind === "travel"
      ? "travel"
      : conflict.kind === "turnaround"
        ? "turnaround"
        : conflict.kind === "unavailable"
          ? "availability"
          : conflict.resourceType === "vehicle"
            ? "equipment"
            : conflict.resourceType;
  const title =
    conflict.kind === "overlap"
      ? `${titleCase(conflict.resourceType)} is double-booked`
      : conflict.kind === "unavailable"
        ? `${titleCase(conflict.resourceType)} is outside availability`
        : conflict.kind === "turnaround"
          ? `${titleCase(conflict.resourceType)} has insufficient turnaround`
          : `${titleCase(conflict.resourceType)} cannot complete the planned travel`;
  const evidence = {
    kind: conflict.kind,
    assignmentIds: conflict.assignmentIds,
    ...("overlapMs" in conflict ? { overlapMs: conflict.overlapMs } : {}),
    ...("actualGapMs" in conflict
      ? { actualGapMs: conflict.actualGapMs, requiredGapMs: conflict.requiredGapMs }
      : {}),
  };
  return {
    id: createUuidV7(),
    workspaceId,
    projectId,
    scheduleRevisionId: revisionId,
    conflictType,
    severity: conflict.severity,
    resourceType: conflict.resourceType,
    resourceId: conflict.resourceId,
    title,
    evidenceJson: canonicalJson(evidence),
    fingerprint: await sha256(canonicalJson({ revisionId, conflict })),
    detectedAt: now,
  };
}

function preparedStatements(db: D1Database, revision: PreparedRevision): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO schedule_revisions
        (id, workspace_id, project_id, schedule_id, revision_number, name, source_script_revision_id,
         status, content_hash, totals_json, author_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        revision.id,
        revision.workspace_id,
        revision.project_id,
        revision.schedule_id,
        revision.revision_number,
        revision.name,
        revision.source_script_revision_id,
        revision.status,
        revision.content_hash,
        revision.totals_json,
        revision.author_user_id,
        revision.created_at,
      ),
    ...revision.items.map((item) => scheduleItemInsert(db, item)),
    ...revision.conflicts.map((conflict) =>
      db
        .prepare(
          `INSERT INTO resource_conflicts
        (id, workspace_id, project_id, schedule_revision_id, shoot_day_id, conflict_type,
         severity, resource_type, resource_id, title, evidence_json, status, fingerprint,
         detected_at, version, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11, ?12, 1, ?12)`,
        )
        .bind(
          conflict.id,
          conflict.workspaceId,
          conflict.projectId,
          conflict.scheduleRevisionId,
          conflict.conflictType,
          conflict.severity,
          conflict.resourceType,
          conflict.resourceId,
          conflict.title,
          conflict.evidenceJson,
          conflict.fingerprint,
          conflict.detectedAt,
        ),
    ),
  ];
}

function scheduleItemInsert(db: D1Database, item: PreparedScheduleItem): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_items
      (id, workspace_id, project_id, schedule_revision_id, item_type, scene_id, scene_segment_id,
       title, shoot_date, unit, day_count, general_call_local, estimated_start_local,
       estimated_wrap_local, timezone, location_id, page_eighths, prep_duration_ms,
       setup_duration_ms, shoot_duration_ms, move_duration_ms, hard_constraints_json,
       details_json, sort_rank, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
             ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)`,
    )
    .bind(
      item.id,
      item.workspace_id,
      item.project_id,
      item.schedule_revision_id,
      item.item_type,
      item.scene_id,
      item.scene_segment_id,
      item.title,
      item.shoot_date,
      item.unit,
      item.day_count,
      item.general_call_local,
      item.estimated_start_local,
      item.estimated_wrap_local,
      item.timezone,
      item.location_id,
      item.page_eighths,
      item.prep_duration_ms,
      item.setup_duration_ms,
      item.shoot_duration_ms,
      item.move_duration_ms,
      item.hard_constraints_json,
      item.details_json,
      item.sort_rank,
      item.created_at,
    );
}

async function validateScheduleInput(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  input: RevisionInput,
): Promise<void> {
  const sceneIds = unique(input.items.flatMap((item) => (item.sceneId ? [item.sceneId] : [])));
  const segmentIds = unique(
    input.items.flatMap((item) => (item.sceneSegmentId ? [item.sceneSegmentId] : [])),
  );
  const locationIds = unique([
    ...input.items.flatMap((item) => (item.locationId ? [item.locationId] : [])),
    ...input.items.flatMap((item) =>
      item.assignments.flatMap((assignment) =>
        assignment.locationId ? [assignment.locationId] : [],
      ),
    ),
    ...input.travelDurations.flatMap((duration) => [
      duration.fromLocationId,
      duration.toLocationId,
    ]),
  ]);
  await Promise.all([
    validateScopedIds(db, "scenes", sceneIds, workspaceId, projectId),
    validateScopedIds(db, "scene_segments", segmentIds, workspaceId, projectId),
    validateScopedIds(db, "locations", locationIds, workspaceId, projectId),
  ]);
  const byResource = new Map<string, string[]>();
  for (const assignment of input.items.flatMap((item) => item.assignments)) {
    const table =
      assignment.resourceType === "cast" || assignment.resourceType === "crew"
        ? "people"
        : assignment.resourceType === "location"
          ? "locations"
          : "equipment_items";
    byResource.set(table, [...(byResource.get(table) ?? []), assignment.resourceId]);
  }
  for (const window of input.availability) {
    const table =
      window.resourceType === "cast" || window.resourceType === "crew"
        ? "people"
        : window.resourceType === "location"
          ? "locations"
          : "equipment_items";
    byResource.set(table, [...(byResource.get(table) ?? []), window.resourceId]);
  }
  for (const [table, values] of byResource)
    await validateScopedIds(
      db,
      table,
      unique(values),
      workspaceId,
      projectId,
      table === "people" || table === "equipment_items",
    );
  if (input.sourceScriptRevisionId) {
    const source = await db
      .prepare(
        "SELECT id FROM script_revisions WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
      )
      .bind(input.sourceScriptRevisionId, workspaceId, projectId)
      .first<{ id: string }>();
    if (!source)
      throw new HttpError(
        422,
        "invalid_source_revision",
        "The source script revision does not belong to this project.",
      );
  }
}

async function validateScopedIds(
  db: D1Database,
  table: string,
  ids: readonly string[],
  workspaceId: string,
  projectId: string,
  allowWorkspaceRecord = false,
): Promise<void> {
  if (ids.length === 0) return;
  const allowed = new Set(["scenes", "scene_segments", "locations", "people", "equipment_items"]);
  if (!allowed.has(table)) throw new Error("Unsafe validation table.");
  const placeholders = ids.map((_, index) => `?${index + 3}`).join(", ");
  const query = `SELECT id FROM ${table} WHERE workspace_id = ?1 AND ${allowWorkspaceRecord ? "(project_id = ?2 OR project_id IS NULL)" : "project_id = ?2"} AND id IN (${placeholders})`;
  const result = await db
    .prepare(query)
    .bind(workspaceId, projectId, ...ids)
    .all<{ id: string }>();
  const found = new Set(result.results.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new HttpError(
      422,
      "invalid_reference",
      "One or more selected production records are unavailable in this project.",
      { type: table, count: missing.length },
    );
}

async function requireSchedule(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  scheduleId: string,
) {
  const row = await db
    .prepare(
      "SELECT id, title, current_revision_id, approved_revision_id, version FROM schedules WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(scheduleId, workspaceId, projectId)
    .first<{
      id: string;
      title: string;
      current_revision_id: string | null;
      approved_revision_id: string | null;
      version: number;
    }>();
  if (!row) throw new HttpError(404, "not_found", "The schedule was not found.");
  return row;
}

async function requireRevision(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  revisionId: string,
): Promise<ScheduleRevisionRow> {
  const row = await db
    .prepare(
      "SELECT id, workspace_id, project_id, schedule_id, revision_number, name, source_script_revision_id, status, content_hash, totals_json, author_user_id, created_at FROM schedule_revisions WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
    )
    .bind(revisionId, workspaceId, projectId)
    .first<ScheduleRevisionRow>();
  if (!row) throw new HttpError(404, "not_found", "The schedule revision was not found.");
  return row;
}

async function loadScheduleItems(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  revisionId: string,
): Promise<ScheduleItemRow[]> {
  const rows = await db
    .prepare(
      "SELECT id, item_type, scene_id, scene_segment_id, title, shoot_date, unit, day_count, general_call_local, estimated_start_local, estimated_wrap_local, timezone, location_id, page_eighths, prep_duration_ms, setup_duration_ms, shoot_duration_ms, move_duration_ms, hard_constraints_json, details_json, sort_rank, created_at FROM schedule_items WHERE schedule_revision_id = ?1 AND workspace_id = ?2 AND project_id = ?3 ORDER BY sort_rank, id",
    )
    .bind(revisionId, workspaceId, projectId)
    .all<ScheduleItemRow>();
  return rows.results;
}

async function loadConflicts(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  revisionId: string,
) {
  const rows = await db
    .prepare(
      "SELECT id, conflict_type, severity, resource_type, resource_id, title, evidence_json, status, fingerprint, detected_at, version, updated_at FROM resource_conflicts WHERE schedule_revision_id = ?1 AND workspace_id = ?2 AND project_id = ?3 ORDER BY CASE severity WHEN 'blocker' THEN 0 ELSE 1 END, detected_at, id",
    )
    .bind(revisionId, workspaceId, projectId)
    .all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    id: stringValue(row.id),
    conflictType: stringValue(row.conflict_type),
    severity: stringValue(row.severity),
    resourceType: stringValue(row.resource_type),
    resourceId: stringValue(row.resource_id),
    title: stringValue(row.title),
    evidence: parseObject(stringValue(row.evidence_json)),
    status: stringValue(row.status),
    fingerprint: stringValue(row.fingerprint),
    detectedAt: numberValue(row.detected_at),
    version: numberValue(row.version),
    updatedAt: numberValue(row.updated_at),
  }));
}

async function loadScheduleView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  scheduleId: string,
) {
  const row = await db
    .prepare(
      `SELECT s.id, s.title, s.status, s.is_default, s.current_revision_id, s.approved_revision_id,
            s.version, s.archived_at, s.updated_at, sr.name AS revision_name,
            sr.revision_number, sr.status AS revision_status, sr.totals_json,
            (SELECT COUNT(*) FROM schedule_items si WHERE si.schedule_revision_id = sr.id) AS item_count,
            (SELECT COUNT(*) FROM resource_conflicts rc WHERE rc.schedule_revision_id = sr.id AND rc.status = 'open') AS open_conflicts,
            (SELECT si.id FROM schedule_items si WHERE si.schedule_revision_id = sr.id AND si.item_type = 'day_break' ORDER BY si.sort_rank LIMIT 1) AS day_break_item_id
       FROM schedules s LEFT JOIN schedule_revisions sr ON sr.id = s.current_revision_id
      WHERE s.id = ?1 AND s.workspace_id = ?2 AND s.project_id = ?3 LIMIT 1`,
    )
    .bind(scheduleId, workspaceId, projectId)
    .first<ScheduleRow>();
  if (!row) throw new HttpError(404, "not_found", "The schedule was not found.");
  return scheduleView(row);
}

function scheduleView(row: ScheduleRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    isDefault: Boolean(row.is_default),
    currentRevisionId: row.current_revision_id,
    approvedRevisionId: row.approved_revision_id,
    version: row.version,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
    revision: row.current_revision_id
      ? {
          id: row.current_revision_id,
          name: row.revision_name ?? "Untitled revision",
          revisionNumber: row.revision_number ?? 0,
          status: row.revision_status ?? "draft",
          totals: parseObject(row.totals_json),
          itemCount: row.item_count,
          openConflicts: row.open_conflicts,
          dayBreakItemId: row.day_break_item_id,
        }
      : null,
  };
}

function revisionView(row: ScheduleRevisionRow | PreparedRevision) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    revisionNumber: row.revision_number,
    name: row.name,
    sourceScriptRevisionId: row.source_script_revision_id,
    status: row.status,
    contentHash: row.content_hash,
    totals: parseObject(row.totals_json),
    authorUserId: row.author_user_id,
    createdAt: row.created_at,
  };
}

function scheduleItemView(item: ScheduleItemRow) {
  const details = parseObject(item.details_json);
  return {
    id: item.id,
    itemType: item.item_type,
    sceneId: item.scene_id,
    sceneSegmentId: item.scene_segment_id,
    title: item.title,
    shootDate: item.shoot_date,
    unit: item.unit ?? "Main",
    dayCount: item.day_count,
    generalCallLocal: item.general_call_local,
    estimatedStartLocal: item.estimated_start_local,
    estimatedWrapLocal: item.estimated_wrap_local,
    timezone: item.timezone ?? "Europe/Amsterdam",
    locationId: item.location_id,
    pageEighths: item.page_eighths,
    prepDurationMs: item.prep_duration_ms,
    setupDurationMs: item.setup_duration_ms,
    shootDurationMs: item.shoot_duration_ms,
    moveDurationMs: item.move_duration_ms,
    mealDurationMs: numericField(details.mealDurationMs),
    hardConstraints: parseStringArray(item.hard_constraints_json),
    details,
    sortRank: item.sort_rank,
    createdAt: item.created_at,
  };
}

function scheduleItemAsInput(item: ScheduleItemRow): ScheduleItemInput {
  const view = scheduleItemView(item);
  return scheduleItemInputSchema.parse({
    ...view,
    assignments: [],
    startAt: typeof view.details.startAt === "number" ? view.details.startAt : undefined,
    endAt: typeof view.details.endAt === "number" ? view.details.endAt : undefined,
  });
}

function scheduleArtifactFromRow(item: ScheduleItemRow): ScheduleArtifactItem {
  const details = parseObject(item.details_json);
  return {
    id: item.id,
    unit: item.unit ?? "Main",
    pageEighths: item.page_eighths,
    prepDurationMs: item.prep_duration_ms,
    setupDurationMs: item.setup_duration_ms,
    shootDurationMs: item.shoot_duration_ms,
    moveDurationMs: item.move_duration_ms,
    mealDurationMs: numericField(details.mealDurationMs),
    ...(typeof details.startAt === "number" ? { startAt: details.startAt } : {}),
    ...(typeof details.endAt === "number" ? { endAt: details.endAt } : {}),
  };
}

function preparedConflictView(conflict: PreparedConflict) {
  return {
    id: conflict.id,
    conflictType: conflict.conflictType,
    severity: conflict.severity,
    resourceType: conflict.resourceType,
    resourceId: conflict.resourceId,
    title: conflict.title,
    evidence: parseObject(conflict.evidenceJson),
    status: "open" as const,
    fingerprint: conflict.fingerprint,
    detectedAt: conflict.detectedAt,
    version: 1,
    updatedAt: conflict.detectedAt,
  };
}

interface ShootDayRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly schedule_revision_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly shoot_date: string | null;
  readonly unit: string;
  readonly day_count: number;
  readonly timezone: string;
  readonly general_call_at: number | null;
  readonly estimated_start_at: number | null;
  readonly estimated_wrap_at: number | null;
  readonly base_location_id: string | null;
  readonly primary_location_id: string | null;
  readonly hard_constraints_json: string;
  readonly readiness_state: string;
  readonly details_json: string;
  readonly version: number;
  readonly archived_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

async function requireShootDay(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
): Promise<ShootDayRow> {
  const row = await db
    .prepare(
      "SELECT * FROM shoot_days WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, workspaceId, projectId)
    .first<ShootDayRow>();
  if (!row) throw new HttpError(404, "not_found", "The shoot day was not found.");
  return row;
}

async function requireShootDayView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      `SELECT sd.*, sr.name AS revision_name, s.current_revision_id,
            (SELECT COUNT(*) FROM resource_conflicts rc WHERE rc.schedule_revision_id = sd.schedule_revision_id AND (rc.shoot_day_id IS NULL OR rc.shoot_day_id = sd.id) AND rc.status = 'open') AS open_conflicts,
            (SELECT COUNT(*) FROM call_sheet_drafts csd WHERE csd.shoot_day_id = sd.id AND csd.archived_at IS NULL) AS call_sheet_count
       FROM shoot_days sd LEFT JOIN schedule_revisions sr ON sr.id = sd.schedule_revision_id
       LEFT JOIN schedules s ON s.id = sr.schedule_id
      WHERE sd.id = ?1 AND sd.workspace_id = ?2 AND sd.project_id = ?3 LIMIT 1`,
    )
    .bind(id, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "The shoot day was not found.");
  return shootDayView(row);
}

function shootDayView(row: Record<string, unknown>) {
  const revisionId = nullableString(row.schedule_revision_id);
  const currentRevisionId = nullableString(row.current_revision_id);
  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    status: stringValue(row.status),
    summary: nullableString(row.summary),
    scheduleRevisionId: revisionId,
    revisionName: nullableString(row.revision_name),
    scheduleStale: Boolean(revisionId && currentRevisionId && revisionId !== currentRevisionId),
    shootDate: nullableString(row.shoot_date),
    unit: stringValue(row.unit),
    dayCount: numberValue(row.day_count),
    timezone: stringValue(row.timezone),
    generalCallAt: nullableNumber(row.general_call_at),
    estimatedStartAt: nullableNumber(row.estimated_start_at),
    estimatedWrapAt: nullableNumber(row.estimated_wrap_at),
    readinessState: stringValue(row.readiness_state),
    openConflicts: numberValue(row.open_conflicts),
    callSheetCount: numberValue(row.call_sheet_count),
    version: numberValue(row.version),
    archivedAt: nullableNumber(row.archived_at),
    updatedAt: numberValue(row.updated_at),
  };
}

interface CallSheetDraftRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly shoot_day_id: string | null;
  readonly source_schedule_revision_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly call_sheet_type: string;
  readonly issue_number_next: number;
  readonly timezone: string;
  readonly paper_size: "A4" | "Letter";
  readonly layout: "standard" | "compact";
  readonly manual_weather_json: string;
  readonly details_json: string;
  readonly version: number;
  readonly archived_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly shoot_date: string | null;
}

async function requireCallSheetDraft(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
): Promise<CallSheetDraftRow> {
  const row = await db
    .prepare(
      "SELECT csd.*, sd.shoot_date FROM call_sheet_drafts csd LEFT JOIN shoot_days sd ON sd.id = csd.shoot_day_id WHERE csd.id = ?1 AND csd.workspace_id = ?2 AND csd.project_id = ?3 AND csd.archived_at IS NULL LIMIT 1",
    )
    .bind(id, workspaceId, projectId)
    .first<CallSheetDraftRow>();
  if (!row) throw new HttpError(404, "not_found", "The call-sheet draft was not found.");
  return row;
}

async function requireCallSheetDraftView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      `SELECT csd.*, sd.shoot_date, sd.unit, sd.day_count,
            (SELECT COUNT(*) FROM call_sheet_recipients cr WHERE cr.call_sheet_draft_id = csd.id AND cr.archived_at IS NULL) AS recipient_count,
            (SELECT COUNT(*) FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id) AS issue_count,
            (SELECT ci.id FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id ORDER BY ci.issue_number DESC LIMIT 1) AS latest_issue_id,
            (SELECT ci.issue_number FROM call_sheet_issues ci WHERE ci.call_sheet_draft_id = csd.id ORDER BY ci.issue_number DESC LIMIT 1) AS latest_issue_number
       FROM call_sheet_drafts csd LEFT JOIN shoot_days sd ON sd.id = csd.shoot_day_id
      WHERE csd.id = ?1 AND csd.workspace_id = ?2 AND csd.project_id = ?3 LIMIT 1`,
    )
    .bind(id, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "The call-sheet draft was not found.");
  return callSheetDraftView(row);
}

function callSheetDraftView(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    status: stringValue(row.status),
    shootDayId: nullableString(row.shoot_day_id),
    sourceScheduleRevisionId: nullableString(row.source_schedule_revision_id),
    callSheetType: stringValue(row.call_sheet_type),
    nextIssueNumber: numberValue(row.issue_number_next),
    timezone: stringValue(row.timezone),
    paperSize: stringValue(row.paper_size),
    layout: stringValue(row.layout),
    manualWeather: parseObject(stringValue(row.manual_weather_json)),
    shootDate: nullableString(row.shoot_date),
    unit: nullableString(row.unit),
    dayCount: nullableNumber(row.day_count),
    recipientCount: numberValue(row.recipient_count),
    issueCount: numberValue(row.issue_count),
    latestIssueId: nullableString(row.latest_issue_id),
    latestIssueNumber: nullableNumber(row.latest_issue_number),
    version: numberValue(row.version),
    archivedAt: nullableNumber(row.archived_at),
    updatedAt: numberValue(row.updated_at),
  };
}

async function callSheetSectionsFromShootDay(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  shootDay: ShootDayRow,
  manualWeather: Record<string, unknown>,
) {
  const itemIds = parseStringArrayField(parseObject(shootDay.details_json).scheduleItemIds);
  let items: ScheduleItemRow[] = [];
  if (shootDay.schedule_revision_id) {
    const allItems = await loadScheduleItems(
      db,
      workspaceId,
      projectId,
      shootDay.schedule_revision_id,
    );
    items = itemIds.length
      ? allItems.filter((item) => itemIds.includes(item.id))
      : allItems.filter(
          (item) =>
            (item.unit ?? "Main") === shootDay.unit &&
            (item.day_count ?? shootDay.day_count) === shootDay.day_count,
        );
  }
  const location = shootDay.primary_location_id
    ? await db
        .prepare(
          "SELECT title, map_url FROM locations WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
        )
        .bind(shootDay.primary_location_id, workspaceId, projectId)
        .first<{ title: string; map_url: string | null }>()
    : null;
  const blockers = await db
    .prepare(
      "SELECT COUNT(*) AS value FROM requirements WHERE workspace_id = ?1 AND project_id = ?2 AND is_blocking = 1 AND status NOT IN ('complete', 'executed', 'approved') AND archived_at IS NULL",
    )
    .bind(workspaceId, projectId)
    .first<{ value: number }>();
  const scheduleBody =
    items
      .map(
        (item) =>
          `${item.general_call_local ?? "--:--"} · ${item.title ?? item.item_type.replaceAll("_", " ")}${item.scene_id ? ` · scene ${item.scene_id}` : ""}`,
      )
      .join("\n") || "No strips were found for this shoot day.";
  const weatherBody = Object.keys(manualWeather).length
    ? Object.entries(manualWeather)
        .map(([key, value]) => `${titleCase(key)}: ${displayValue(value)}`)
        .join("\n")
    : "Weather provider not configured. Enter and freeze a manual forecast before issue.";
  return [
    {
      sectionType: "overview",
      title: "Day overview",
      body: `${shootDay.title}\n${shootDay.shoot_date ?? "Date not set"} · ${shootDay.unit} · Day ${shootDay.day_count}\nGeneral call: ${shootDay.general_call_at ? new Date(shootDay.general_call_at).toISOString() : "Not set"}`,
      visible: true,
    },
    { sectionType: "schedule", title: "Schedule", body: scheduleBody, visible: true },
    {
      sectionType: "location",
      title: "Location and access",
      body: location
        ? `${location.title}${location.map_url ? `\nMap: ${location.map_url}` : ""}`
        : "Primary location not set.",
      visible: true,
    },
    { sectionType: "weather", title: "Manual weather", body: weatherBody, visible: true },
    {
      sectionType: "safety",
      title: "Safety and emergency",
      body:
        (blockers?.value ?? 0) > 0
          ? `${blockers?.value ?? 0} blocking legal or safety requirements remain. Resolve them in Legal & Safety before issue.`
          : "No unresolved blocking requirements were found. Reconfirm the emergency plan before issue.",
      visible: true,
    },
  ];
}

interface DraftRecipientRow {
  readonly id: string;
  readonly person_id: string;
  readonly person_name: string;
  readonly label: string | null;
  readonly private_note: string | null;
  readonly required_confirmation: number;
  readonly email: string | null;
  readonly phone: string | null;
  readonly calls: readonly {
    readonly call_type: string;
    readonly call_at: number;
    readonly timezone: string;
    readonly sort_rank: string;
  }[];
}

async function loadDraftRecipients(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  draftId: string,
): Promise<DraftRecipientRow[]> {
  const [recipients, calls] = await Promise.all([
    db
      .prepare(
        `SELECT cr.id, cr.person_id, p.title AS person_name, cr.label, cr.private_note, cr.required_confirmation,
              (SELECT cp.value FROM contact_points cp WHERE cp.person_id = p.id AND cp.type = 'email' AND cp.archived_at IS NULL ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS email,
              (SELECT cp.value FROM contact_points cp WHERE cp.person_id = p.id AND cp.type = 'phone' AND cp.archived_at IS NULL ORDER BY cp.is_primary DESC, cp.created_at LIMIT 1) AS phone
         FROM call_sheet_recipients cr JOIN people p ON p.id = cr.person_id
        WHERE cr.call_sheet_draft_id = ?1 AND cr.workspace_id = ?2 AND cr.project_id = ?3 AND cr.archived_at IS NULL
        ORDER BY json_extract(cr.recipient_projection_json, '$.sortRank'), p.title`,
      )
      .bind(draftId, workspaceId, projectId)
      .all<Omit<DraftRecipientRow, "calls">>(),
    db
      .prepare(
        "SELECT person_id, call_type, call_at, timezone, sort_rank FROM call_sheet_person_calls WHERE call_sheet_draft_id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL ORDER BY person_id, sort_rank",
      )
      .bind(draftId, workspaceId, projectId)
      .all<{
        person_id: string;
        call_type: string;
        call_at: number;
        timezone: string;
        sort_rank: string;
      }>(),
  ]);
  return recipients.results.map((recipient) => ({
    ...recipient,
    calls: calls.results.filter((call) => call.person_id === recipient.person_id),
  }));
}

async function validatePeople(
  db: D1Database,
  ids: readonly string[],
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await validateScopedIds(db, "people", unique(ids), workspaceId, projectId, true);
}

async function requireSupersededCallSheet(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  draftId: string,
  issueId: string,
): Promise<void> {
  const issue = await db
    .prepare(
      "SELECT id FROM call_sheet_issues WHERE id = ?1 AND call_sheet_draft_id = ?2 AND workspace_id = ?3 AND project_id = ?4 LIMIT 1",
    )
    .bind(issueId, draftId, workspaceId, projectId)
    .first<{ id: string }>();
  if (!issue)
    throw new HttpError(
      422,
      "invalid_superseded_issue",
      "The corrected issue must belong to this call-sheet draft.",
    );
}

async function requireRecipientIssue(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  recipientIssueId: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT id FROM call_sheet_recipient_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
    )
    .bind(recipientIssueId, workspaceId, projectId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "not_found", "The recipient call-sheet issue was not found.");
}

async function recipientIssueStatus(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  recipientIssueId: string,
) {
  const row = await db
    .prepare(
      `SELECT cri.id AS recipient_issue_id, cri.call_sheet_issue_id, p.title AS person_name,
            cr.label, cr.required_confirmation, sl.expires_at, sl.revoked_at,
            (SELECT MIN(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'viewed') AS viewed_at,
            (SELECT MAX(c.confirmed_at) FROM confirmations c WHERE c.call_sheet_recipient_issue_id = cri.id) AS confirmed_at,
            (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'provider_failed') AS failed_at,
            (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'not_configured') AS not_configured_at
       FROM call_sheet_recipient_issues cri JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id
       JOIN people p ON p.id = cr.person_id LEFT JOIN share_links sl ON sl.id = cri.share_link_id
      WHERE cri.id = ?1 AND cri.workspace_id = ?2 AND cri.project_id = ?3 LIMIT 1`,
    )
    .bind(recipientIssueId, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "The recipient call-sheet issue was not found.");
  return recipientIssueView(row);
}

function recipientIssueView(row: Record<string, unknown>) {
  const confirmedAt = nullableNumber(row.confirmed_at);
  const viewedAt = nullableNumber(row.viewed_at);
  const failedAt = nullableNumber(row.failed_at);
  const notConfiguredAt = nullableNumber(row.not_configured_at);
  return {
    recipientIssueId: stringValue(row.recipient_issue_id),
    callSheetIssueId: stringValue(row.call_sheet_issue_id),
    callSheetDraftId: nullableString(row.call_sheet_draft_id),
    issueNumber: nullableNumber(row.issue_number),
    personName: stringValue(row.person_name),
    label: nullableString(row.label),
    requiredConfirmation: Boolean(row.required_confirmation),
    shareLocator: nullableString(row.public_locator),
    linkExpiresAt: nullableNumber(row.expires_at),
    linkRevokedAt: nullableNumber(row.revoked_at),
    viewedAt,
    confirmedAt,
    deliveryState: confirmedAt
      ? "confirmed"
      : failedAt
        ? "failed"
        : viewedAt
          ? "viewed"
          : notConfiguredAt
            ? "not_configured"
            : "issued",
  };
}

async function requireCallSheetIssueView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  issueId: string,
) {
  const issue = await db
    .prepare(
      "SELECT id, call_sheet_draft_id, issue_number, title, confidentiality_marking, content_hash, supersedes_issue_id, source_schedule_revision_id, created_at FROM call_sheet_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
    )
    .bind(issueId, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!issue) throw new HttpError(404, "not_found", "The call-sheet issue was not found.");
  const recipients = await db
    .prepare(
      `SELECT cri.id AS recipient_issue_id, cri.call_sheet_issue_id, p.title AS person_name, cr.label,
            cr.required_confirmation, sl.public_locator, sl.expires_at, sl.revoked_at,
            (SELECT MIN(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'viewed') AS viewed_at,
            (SELECT MAX(c.confirmed_at) FROM confirmations c WHERE c.call_sheet_recipient_issue_id = cri.id) AS confirmed_at,
            (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'provider_failed') AS failed_at,
            (SELECT MAX(de.occurred_at) FROM delivery_events de WHERE de.call_sheet_recipient_issue_id = cri.id AND de.event_type = 'not_configured') AS not_configured_at
       FROM call_sheet_recipient_issues cri JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id
       JOIN people p ON p.id = cr.person_id LEFT JOIN share_links sl ON sl.id = cri.share_link_id
      WHERE cri.call_sheet_issue_id = ?1 ORDER BY p.title`,
    )
    .bind(issueId)
    .all<Record<string, unknown>>();
  return {
    id: stringValue(issue.id),
    draftId: stringValue(issue.call_sheet_draft_id),
    issueNumber: numberValue(issue.issue_number),
    title: stringValue(issue.title),
    confidentiality: nullableString(issue.confidentiality_marking),
    contentHash: stringValue(issue.content_hash),
    supersedesIssueId: nullableString(issue.supersedes_issue_id),
    sourceScheduleRevisionId: nullableString(issue.source_schedule_revision_id),
    createdAt: numberValue(issue.created_at),
    recipients: recipients.results.map(recipientIssueView),
    printHref: `/print/call_sheet_issue/${encodeURIComponent(issueId)}`,
  };
}

interface PackDraftRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly shoot_day_id: string | null;
  readonly paper_size: "A4" | "Letter";
  readonly confidentiality_marking: string | null;
  readonly details_json: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

async function validatePackItems(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  items: readonly PackItemInput[],
): Promise<void> {
  const objectIds = unique(items.flatMap((item) => (item.objectId ? [item.objectId] : [])));
  if (objectIds.length) {
    const placeholders = objectIds.map((_, index) => `?${index + 3}`).join(", ");
    const rows = await db
      .prepare(
        `SELECT id FROM object_registry WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL AND id IN (${placeholders})`,
      )
      .bind(workspaceId, projectId, ...objectIds)
      .all<{ id: string }>();
    if (new Set(rows.results.map((row) => row.id)).size !== objectIds.length)
      throw new HttpError(
        422,
        "invalid_pack_object",
        "A selected production-pack object is unavailable in this project.",
      );
  }
  const fileIds = unique(items.flatMap((item) => (item.fileVersionId ? [item.fileVersionId] : [])));
  if (fileIds.length) {
    const placeholders = fileIds.map((_, index) => `?${index + 3}`).join(", ");
    const rows = await db
      .prepare(
        `SELECT id, scan_state FROM file_versions WHERE workspace_id = ?1 AND project_id = ?2 AND id IN (${placeholders})`,
      )
      .bind(workspaceId, projectId, ...fileIds)
      .all<{ id: string; scan_state: string }>();
    if (
      rows.results.length !== fileIds.length ||
      rows.results.some((row) => ["pending", "quarantined", "failed"].includes(row.scan_state))
    )
      throw new HttpError(
        422,
        "invalid_pack_file",
        "A selected file version is unavailable or remains quarantined.",
      );
  }
  for (const referenceId of unique(
    items.flatMap((item) => (item.revisionOrIssueId ? [item.revisionOrIssueId] : [])),
  )) {
    const pinTables = [
      "script_revisions",
      "schedule_revisions",
      "call_sheet_issues",
      "sides_issues",
      "report_snapshots",
      "readiness_issues",
    ] as const;
    let found = false;
    for (const table of pinTables) {
      const row = await db
        .prepare(
          `SELECT id FROM ${table} WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
        )
        .bind(referenceId, workspaceId, projectId)
        .first<{ id: string }>();
      if (row) {
        found = true;
        break;
      }
    }
    if (!found)
      throw new HttpError(
        422,
        "invalid_pack_pin",
        "A selected revision or issued artifact is unavailable in this project.",
      );
  }
}

async function requirePackDraft(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
): Promise<PackDraftRow> {
  const row = await db
    .prepare(
      "SELECT id, title, status, summary, shoot_day_id, paper_size, confidentiality_marking, details_json, version, created_at, updated_at FROM production_pack_drafts WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(id, workspaceId, projectId)
    .first<PackDraftRow>();
  if (!row) throw new HttpError(404, "not_found", "The production-pack draft was not found.");
  return row;
}

async function requirePackDraftView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
) {
  const row = await db
    .prepare(
      `SELECT ppd.id, ppd.title, ppd.status, ppd.summary, ppd.shoot_day_id, ppd.paper_size,
            ppd.confidentiality_marking, ppd.version, ppd.updated_at,
            (SELECT COUNT(*) FROM production_pack_items ppi WHERE ppi.production_pack_draft_id = ppd.id AND ppi.archived_at IS NULL) AS item_count,
            (SELECT COUNT(*) FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id) AS issue_count,
            (SELECT ppi.id FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_issue_id,
            (SELECT ppi.issue_number FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_issue_number,
            (SELECT ppi.manifest_hash FROM production_pack_issues ppi WHERE ppi.production_pack_draft_id = ppd.id ORDER BY ppi.issue_number DESC LIMIT 1) AS latest_manifest_hash
       FROM production_pack_drafts ppd WHERE ppd.id = ?1 AND ppd.workspace_id = ?2 AND ppd.project_id = ?3 LIMIT 1`,
    )
    .bind(id, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "The production-pack draft was not found.");
  return packDraftView(row);
}

function packDraftView(row: Record<string, unknown>) {
  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    status: stringValue(row.status),
    summary: nullableString(row.summary),
    shootDayId: nullableString(row.shoot_day_id),
    paperSize: stringValue(row.paper_size),
    confidentiality: nullableString(row.confidentiality_marking),
    itemCount: numberValue(row.item_count),
    issueCount: numberValue(row.issue_count),
    latestIssueId: nullableString(row.latest_issue_id),
    latestIssueNumber: nullableNumber(row.latest_issue_number),
    latestManifestHash: nullableString(row.latest_manifest_hash),
    version: numberValue(row.version),
    updatedAt: numberValue(row.updated_at),
    zipState: "not_configured" as const,
  };
}

async function requireSupersededPack(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  draftId: string,
  issueId: string,
): Promise<void> {
  const issue = await db
    .prepare(
      "SELECT id FROM production_pack_issues WHERE id = ?1 AND production_pack_draft_id = ?2 AND workspace_id = ?3 AND project_id = ?4 LIMIT 1",
    )
    .bind(issueId, draftId, workspaceId, projectId)
    .first<{ id: string }>();
  if (!issue)
    throw new HttpError(
      422,
      "invalid_superseded_issue",
      "The corrected issue must belong to this production-pack draft.",
    );
}

async function requirePackIssueView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  issueId: string,
) {
  const row = await db
    .prepare(
      "SELECT id, production_pack_draft_id, issue_number, title, manifest_hash, r2_object_key, supersedes_issue_id, created_at, json_array_length(json_extract(manifest_json, '$.entries')) AS item_count FROM production_pack_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
    )
    .bind(issueId, workspaceId, projectId)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "not_found", "The production-pack issue was not found.");
  return {
    id: stringValue(row.id),
    draftId: stringValue(row.production_pack_draft_id),
    issueNumber: numberValue(row.issue_number),
    title: stringValue(row.title),
    manifestHash: stringValue(row.manifest_hash),
    itemCount: numberValue(row.item_count),
    supersedesIssueId: nullableString(row.supersedes_issue_id),
    createdAt: numberValue(row.created_at),
    printHref: `/print/production_pack_issue/${encodeURIComponent(issueId)}`,
    manifestHref: `/api/v1/app/projects/${encodeURIComponent(projectId)}/operations/production-pack-issues/${encodeURIComponent(issueId)}/manifest.json`,
    zipState: row.r2_object_key ? ("available" as const) : ("not_configured" as const),
  };
}

function registryStatement(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  objectType: string,
  domainTable: string,
  domainId: string,
  title: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO object_registry
      (id, workspace_id, project_id, object_type, domain_table, domain_id, title,
       version, archived_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, ?8)`,
    )
    .bind(createUuidV7(), workspaceId, projectId, objectType, domainTable, domainId, title, now);
}

function staleReadinessStatement(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  changedType: string,
  changedId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE projects SET readiness_state = 'stale', version = version + 1, updated_at = ?1
      WHERE id = ?2 AND workspace_id = ?3 AND readiness_state = 'ready'
        AND ?4 <> '' AND ?5 <> ''`,
    )
    .bind(now, projectId, workspaceId, changedType, changedId);
}

function csvResponse(lines: readonly (readonly string[])[], fileName: string): Response {
  const csv = lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
  return new Response(`\uFEFF${csv}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function safeFileName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 120) || "export"
  );
}

function printSectionsFromSnapshot(snapshot: Record<string, unknown>) {
  const values = Array.isArray(snapshot.publicSections)
    ? snapshot.publicSections
    : Array.isArray(snapshot.sections)
      ? snapshot.sections
      : [];
  const sections = values.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const heading =
      typeof value.title === "string"
        ? value.title
        : typeof value.heading === "string"
          ? value.heading
          : `Section ${index + 1}`;
    const body =
      typeof value.body === "string"
        ? value.body
        : typeof value.text === "string"
          ? value.text
          : "";
    return [
      {
        id: typeof value.key === "string" ? value.key : `section-${index + 1}`,
        heading,
        html: `<p>${escapeHtml(body).replaceAll("\n", "<br>")}</p>`,
        breakBefore: false,
      },
    ];
  });
  return sections.length
    ? sections
    : [
        {
          id: "summary",
          heading: "Issue summary",
          html: `<p>${escapeHtml(displayValue(snapshot))}</p>`,
          breakBefore: false,
        },
      ];
}

function schedulePrintHtml(items: readonly ScheduleItemRow[]): string {
  const body = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.item_type.replaceAll("_", " "))}</td><td>${escapeHtml(item.title ?? "")}</td><td>${escapeHtml(item.shoot_date ?? "")}</td><td>${escapeHtml(item.unit ?? "")}</td><td>${item.page_eighths}/8</td><td>${formatDuration(item.prep_duration_ms + item.setup_duration_ms + item.shoot_duration_ms + item.move_duration_ms + numericField(parseObject(item.details_json).mealDurationMs))}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Type</th><th>Strip</th><th>Date</th><th>Unit</th><th>Pages</th><th>Duration</th></tr></thead><tbody>${body}</tbody></table>`;
}

function totalsPrintHtml(totals: Record<string, unknown>): string {
  return `<dl><dt>Pages</dt><dd>${numberValue(totals.pageEighths)}/8</dd><dt>Prep</dt><dd>${formatDuration(numberValue(totals.prepMs))}</dd><dt>Setup</dt><dd>${formatDuration(numberValue(totals.setupMs))}</dd><dt>Shoot</dt><dd>${formatDuration(numberValue(totals.shootMs))}</dd><dt>Moves</dt><dd>${formatDuration(numberValue(totals.moveMs))}</dd><dt>Meals</dt><dd>${formatDuration(numberValue(totals.mealMs))}</dd><dt>Total</dt><dd>${formatDuration(numberValue(totals.totalMs))}</dd></dl>`;
}

function conflictsPrintHtml(
  conflicts: readonly {
    title: string;
    severity: string;
    status: string;
    evidence: Record<string, unknown>;
  }[],
): string {
  if (!conflicts.length) return "<p>No detected resource conflicts.</p>";
  return `<ul>${conflicts.map((conflict) => `<li><strong>${escapeHtml(conflict.title)}</strong> · ${escapeHtml(conflict.severity)} · ${escapeHtml(conflict.status)}<br>${escapeHtml(displayValue(conflict.evidence))}</li>`).join("")}</ul>`;
}

function manifestPrintHtml(manifest: Record<string, unknown>): string {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  if (!entries.length) return "<p>This legacy manifest does not expose ordered entries.</p>";
  const rows = entries
    .flatMap((entry) =>
      isRecord(entry)
        ? [
            `<tr><td>${escapeHtml(stringValue(entry.sectionType))}</td><td>${escapeHtml(stringValue(entry.title))}</td><td>${escapeHtml(stringValue(entry.relativePath))}</td><td>${escapeHtml(nullableString(entry.fileVersionId) ?? nullableString(entry.revisionOrIssueId) ?? nullableString(entry.objectId) ?? "—")}</td></tr>`,
          ]
        : [],
    )
    .join("");
  return `<table><thead><tr><th>Section</th><th>Title</th><th>Path</th><th>Pinned source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function formatDuration(value: number): string {
  const minutes = Math.floor(value / 60_000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatLocalTime(value: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(value);
  }
}

function bodyText(value: string): string {
  const parsed = parseObject(value);
  if (typeof parsed.text === "string") return parsed.text;
  if (Array.isArray(parsed.notes))
    return parsed.notes.filter((note): note is string => typeof note === "string").join("\n");
  return displayValue(parsed);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    return parseStringArrayField(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function parseStringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(", ");
  if (isRecord(value))
    return Object.entries(value)
      .map(([key, entry]) => `${titleCase(key)}: ${displayValue(entry)}`)
      .join("; ");
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function titleCase(value: string): string {
  const spaced = value.replaceAll("_", " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
  return spaced.charAt(0).toLocaleUpperCase("en-GB") + spaced.slice(1);
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(404, "route_not_found", `Missing route parameter: ${name}.`);
  return value;
}
function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL|UNIQUE/iu.test(error.message);
}
