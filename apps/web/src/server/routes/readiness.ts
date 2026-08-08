import {
  createReadinessIssue,
  createUuidV7,
  evaluateReadiness,
  hashCanonicalJson,
  opaqueIdSchema,
  type JsonValue,
  type ReadinessOverride,
  type ReadinessResult as DomainReadinessResult,
  type SnapshotPin,
} from "@swp/domain";
import { Hono, type Context } from "hono";
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
} from "../idempotency";
import {
  DEFAULT_READINESS_RULES,
  activeOverrideForRule,
  compareSourceFingerprints,
  effectiveResult,
  isOwnerOnlyReadinessCode,
  resultFromObservation,
  summarizeReadiness,
  toDomainResult,
  type OverrideRuntime,
  type RuleRuntime,
  type SourceFingerprint,
  type SourceObservation,
  type StaleReason,
  type StoredResultKind,
  type ViewResult,
} from "../readiness/engine";
import { loadReadinessSources } from "../readiness/sources";

const scopeQuerySchema = z.object({ shootDayId: z.string().min(1).max(64).optional() }).strict();
const overrideSchema = z
  .object({
    resultId: z.string().min(1).max(80),
    reason: z.string().trim().min(12).max(5_000),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();
const issueSchema = z.object({ evaluationId: z.string().min(1).max(80) }).strict();
const ruleDefinitionSchema = z
  .object({
    categoryLabel: z.string().min(1).max(100),
    resolutionSegment: z.string().min(1).max(100),
  })
  .passthrough();
const jsonValueSchema = z.json();
const evidenceSchema = z
  .object({
    sourceLabel: z.string().nullable(),
    evidence: z.string().nullable(),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    resolutionHref: z.string(),
    present: z.boolean(),
    snapshot: jsonValueSchema,
  })
  .strict();
const issueResultSnapshotSchema = z
  .object({
    ruleId: z.string(),
    title: z.string(),
    overrideId: z.string().nullable(),
  })
  .passthrough();

interface ProjectMeta {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly owner_user_id: string;
  readonly version: number;
  readonly registry_id: string;
}

interface ProfileRow {
  readonly id: string;
  readonly current_version_id: string;
}

interface RuleRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly category: string;
  readonly scope: string;
  readonly evaluation_type: string;
  readonly severity: string;
  readonly required: number;
  readonly owner_only_override: number;
  readonly rule_definition_json: string;
  readonly sort_rank: string;
}

interface EvaluationHeaderRow {
  readonly id: string;
  readonly readiness_profile_version_id: string;
  readonly shoot_day_id: string | null;
  readonly started_at: number;
  readonly completed_at: number;
}

interface EvaluationResultRow {
  readonly id: string;
  readonly rule_id: string;
  readonly code: string;
  readonly title: string;
  readonly category: string;
  readonly scope: string;
  readonly evaluation_type: string;
  readonly severity: string;
  readonly required: number;
  readonly owner_only_override: number;
  readonly rule_definition_json: string;
  readonly sort_rank: string;
  readonly result: StoredResultKind;
  readonly owner_user_id: string | null;
  readonly owner_name: string | null;
  readonly due_at: number | null;
  readonly explanation: string;
  readonly evidence_json: string;
  readonly source_hash: string;
}

interface OverrideRow {
  readonly id: string;
  readonly readiness_rule_id: string;
  readonly scope: "project" | "shoot_day";
  readonly actor_user_id: string;
  readonly actor_role: "workspace_owner" | "producer";
  readonly reason: string;
  readonly expires_at: number | null;
  readonly created_at: number;
  readonly revoked_at: number | null;
}

interface ApprovalSnapshotRow {
  readonly id: string;
  readonly object_id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly owner_user_id: string | null;
  readonly approver_user_id: string | null;
  readonly pinned_version_id: string | null;
  readonly requested_at: number;
  readonly due_at: number | null;
  readonly self_approval_allowed: number;
  readonly version: number;
  readonly updated_at: number;
  readonly decision_id: string | null;
  readonly decision: string | null;
  readonly decision_actor_user_id: string | null;
  readonly decision_share_link_id: string | null;
  readonly decision_actor_label: string | null;
  readonly decision_comment: string | null;
  readonly decision_pinned_version_id: string | null;
  readonly decision_created_at: number | null;
}

interface ApprovalDecisionSnapshotRow {
  readonly id: string;
  readonly approval_id: string;
  readonly decision: string;
  readonly actor_user_id: string | null;
  readonly share_link_id: string | null;
  readonly actor_label: string | null;
  readonly comment: string | null;
  readonly pinned_version_id: string | null;
  readonly created_at: number;
}

interface LatestIssueRow {
  readonly id: string;
  readonly readiness_evaluation_id: string;
  readonly shoot_day_id: string | null;
  readonly issue_number: number;
  readonly issued_at: number;
  readonly actor: string;
  readonly manifest_hash: string;
  readonly state: "ready" | "stale" | "superseded";
  readonly stale_at: number | null;
}

interface ReadinessResponse {
  readonly evaluationId: string;
  readonly evaluatedAt: number;
  readonly score: number;
  readonly state: "blocked" | "ready" | "stale";
  readonly staleReasons: readonly string[];
  readonly summary: {
    readonly blocking: number;
    readonly warnings: number;
    readonly passed: number;
    readonly notApplicable: number;
    readonly total: number;
  };
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly passed: number;
    readonly total: number;
    readonly results: {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly status: "passed" | "warning" | "blocking" | "not_applicable" | "overridden";
      readonly owner: string | null;
      readonly dueAt: number | null;
      readonly sourceLabel: string | null;
      readonly resolutionHref: string | null;
      readonly overrideAllowed: boolean;
      readonly ownerOnly: boolean;
      readonly evidence: string | null;
    }[];
  }[];
  readonly latestIssue: {
    readonly id: string;
    readonly issueNumber: number;
    readonly issuedAt: number;
    readonly actor: string;
    readonly manifestHash: string;
    readonly staleAt: number | null;
  } | null;
}

interface EvaluationBundle {
  readonly header: EvaluationHeaderRow;
  readonly rows: readonly EvaluationResultRow[];
  readonly rules: readonly RuleRuntime[];
  readonly results: readonly ViewResult[];
  readonly priorSources: readonly SourceFingerprint[];
  readonly overrides: readonly OverrideRow[];
}

export const readinessRoutes = new Hono<AppEnv>();
readinessRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

readinessRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  const scope = scopeQuerySchema.parse(context.req.query());
  await assertProjectAccess(context.env.DB, actor, projectId);
  const project = await requireProjectMeta(context.env.DB, actor.workspaceId, projectId);
  await assertShootDay(context.env.DB, actor.workspaceId, projectId, scope.shootDayId ?? null);

  const profile = await findProfile(context.env.DB, actor.workspaceId, projectId);
  if (!profile) {
    return ok(context, unevaluatedView(projectId, actor, Date.now()));
  }
  let rules: readonly RuleRuntime[];
  try {
    rules = await loadRules(context.env.DB, profile.current_version_id, projectId);
  } catch (error) {
    if (!isProfileConfigurationError(error)) throw error;
    return ok(context, unevaluatedView(projectId, actor, Date.now()));
  }
  const header = await latestEvaluation(
    context.env.DB,
    actor.workspaceId,
    projectId,
    scope.shootDayId ?? null,
  );
  if (!header) {
    return ok(context, unevaluatedView(projectId, actor, Date.now(), rules));
  }

  const [bundle, currentSources, latestIssue] = await Promise.all([
    loadEvaluationBundle(context.env.DB, actor.workspaceId, projectId, header, actor, Date.now()),
    loadReadinessSources(
      {
        db: context.env.DB,
        workspaceId: actor.workspaceId,
        projectId,
        shootDayId: scope.shootDayId ?? null,
        projectOwnerId: project.owner_user_id,
        now: Date.now(),
      },
      rules,
    ),
    loadLatestIssue(context.env.DB, actor.workspaceId, projectId, scope.shootDayId ?? null),
  ]);
  const staleReasons = compareEvaluationSources(bundle, currentSources);
  const issueStaleReasons = latestIssue
    ? await detectAndPersistIssueStaleness(
        context,
        project,
        latestIssue,
        rules,
        currentSources,
        bundle,
      )
    : [];
  const refreshedIssue = latestIssue
    ? await loadLatestIssue(context.env.DB, actor.workspaceId, projectId, scope.shootDayId ?? null)
    : null;
  return ok(
    context,
    responseView(
      bundle,
      actor,
      [
        ...new Set([
          ...staleReasons.map((reason) => reason.reason),
          ...(latestIssue?.readiness_evaluation_id === bundle.header.id ? issueStaleReasons : []),
        ]),
      ],
      refreshedIssue,
    ),
  );
});

readinessRoutes.post("/evaluate", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  const scope = scopeQuerySchema.parse(context.req.query());
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const project = await requireProjectMeta(context.env.DB, actor.workspaceId, projectId);
  const shootDayId = scope.shootDayId ?? null;
  await assertShootDay(context.env.DB, actor.workspaceId, projectId, shootDayId);
  const operationBody = { projectId, shootDayId };
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: "readiness.evaluate",
    key: context.req.header("Idempotency-Key"),
    requestBody: operationBody,
  });
  if (lease.replayRef) {
    const replay = await requireEvaluationHeader(
      context.env.DB,
      actor.workspaceId,
      projectId,
      lease.replayRef,
    );
    const bundle = await loadEvaluationBundle(
      context.env.DB,
      actor.workspaceId,
      projectId,
      replay,
      actor,
      Date.now(),
    );
    return ok(
      context,
      responseView(
        bundle,
        actor,
        [],
        await loadLatestIssue(context.env.DB, actor.workspaceId, projectId, shootDayId),
      ),
    );
  }

  try {
    const profile = await ensureDefaultProfile(
      context.env.DB,
      actor,
      project,
      context.get("requestId"),
      Date.now(),
    );
    const rules = await loadRules(context.env.DB, profile.current_version_id, projectId);
    const now = Date.now();
    const [sources, overrides] = await Promise.all([
      loadReadinessSources(
        {
          db: context.env.DB,
          workspaceId: actor.workspaceId,
          projectId,
          shootDayId,
          projectOwnerId: project.owner_user_id,
          now,
        },
        rules,
      ),
      loadOverrides(context.env.DB, actor.workspaceId, projectId, shootDayId),
    ]);
    const evaluationId = createUuidV7();
    const resultIds = new Map(rules.map((rule) => [rule.id, createUuidV7()]));
    const scopeId = opaqueIdSchema.parse(shootDayId ?? projectId);
    const domainEvaluation = evaluateReadiness({
      rules: rules.map((rule) => ({
        id: opaqueIdSchema.parse(rule.id),
        key: rule.code,
        category: rule.category,
        required: rule.required,
        severity: rule.severity,
        automatic: rule.automatic,
        ownerOnlyOverride: rule.ownerOnlyOverride,
      })),
      sources: Object.fromEntries(
        rules.map((rule) => {
          const source = requireSource(sources, rule.id);
          return [
            rule.id,
            {
              loaded: source.loaded,
              satisfied: source.satisfied && source.present,
              message: source.description,
              ownerId: opaqueIdSchema.parse(source.ownerId ?? project.owner_user_id),
              ...(source.dueAt === null ? {} : { dueAt: source.dueAt }),
              evidence: [sourcePin(project.registry_id, rule.id, source.sourceHash)],
            },
          ];
        }),
      ),
      overrides: overrides.map((override) => domainOverride(override, projectId, shootDayId)),
      scopeId,
      now,
    });
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO readiness_evaluations
            (id, workspace_id, project_id, shoot_day_id, readiness_profile_version_id, state,
             source_watermark, started_by_user_id, started_at, completed_at, error_code)
           VALUES (?1, ?2, ?3, ?4, ?5, 'complete', ?6, ?7, ?8, ?8, NULL)`,
      ).bind(
        evaluationId,
        actor.workspaceId,
        projectId,
        shootDayId,
        profile.current_version_id,
        now,
        actor.userId,
        now,
      ),
    ];
    for (const rule of rules) {
      const source = requireSource(sources, rule.id);
      const resultId = requireMapValue(resultIds, rule.id);
      const stored = resultFromObservation(rule, source);
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO readiness_results
              (id, workspace_id, project_id, readiness_evaluation_id, readiness_rule_id, result,
               owner_user_id, due_at, explanation, evidence_json, resolution_object_id, evaluated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)`,
        ).bind(
          resultId,
          actor.workspaceId,
          projectId,
          evaluationId,
          rule.id,
          stored,
          source.ownerId,
          source.dueAt,
          source.description,
          JSON.stringify({
            sourceLabel: source.sourceLabel,
            evidence: source.evidence,
            sourceHash: source.sourceHash,
            resolutionHref: rule.resolutionHref,
            present: source.present,
            snapshot: source.snapshot,
          }),
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO readiness_sources
              (id, readiness_result_id, object_id, revision_or_version_id, source_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(createUuidV7(), resultId, project.registry_id, rule.id, source.sourceHash, now),
      );
    }
    statements.push(
      shootDayId
        ? context.env.DB.prepare(
            `UPDATE projects SET version = version + 1, updated_at = ?1
                WHERE id = ?2 AND workspace_id = ?3`,
          ).bind(now, projectId, actor.workspaceId)
        : context.env.DB.prepare(
            `UPDATE projects SET readiness_state = ?1, readiness_score = ?2,
                 version = version + 1, updated_at = ?3 WHERE id = ?4 AND workspace_id = ?5`,
          ).bind(
            domainEvaluation.ready ? "ready" : "blocked",
            domainEvaluation.scorePercent,
            now,
            projectId,
            actor.workspaceId,
          ),
      ...(shootDayId
        ? [
            context.env.DB.prepare(
              `UPDATE shoot_days SET readiness_state = ?1, version = version + 1, updated_at = ?2
                  WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5`,
            ).bind(
              domainEvaluation.ready ? "ready" : "blocked",
              now,
              shootDayId,
              actor.workspaceId,
              projectId,
            ),
          ]
        : []),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "readiness.evaluated",
        objectType: "readiness_evaluation",
        objectId: evaluationId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: {
          shootDayId,
          blockingCount: domainEvaluation.blockingCount,
          warningCount: domainEvaluation.warningCount,
          score: domainEvaluation.scorePercent,
        },
      }),
      completeIdempotentOperation(context.env.DB, lease.id, evaluationId, 201),
    );
    await context.env.DB.batch(statements);
    const header = await requireEvaluationHeader(
      context.env.DB,
      actor.workspaceId,
      projectId,
      evaluationId,
    );
    const bundle = await loadEvaluationBundle(
      context.env.DB,
      actor.workspaceId,
      projectId,
      header,
      actor,
      now,
    );
    return ok(
      context,
      responseView(
        bundle,
        actor,
        [],
        await loadLatestIssue(context.env.DB, actor.workspaceId, projectId, shootDayId),
      ),
      201,
    );
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
});

readinessRoutes.post("/overrides", requireJson, async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = overrideSchema.parse(await context.req.json());
  const now = Date.now();
  if (input.expiresAt !== undefined && input.expiresAt <= now) {
    throw new HttpError(422, "override_expiry_invalid", "Override expiry must be in the future.");
  }
  const target = await context.env.DB.prepare(
    `SELECT rr.id, rr.result, rr.readiness_rule_id, rr.readiness_evaluation_id,
              re.shoot_day_id, re.completed_at, r.code, r.owner_only_override
         FROM readiness_results rr
         JOIN readiness_evaluations re ON re.id = rr.readiness_evaluation_id
         JOIN readiness_rules r ON r.id = rr.readiness_rule_id
        WHERE rr.id = ?1 AND rr.workspace_id = ?2 AND rr.project_id = ?3
          AND re.state = 'complete' LIMIT 1`,
  )
    .bind(input.resultId, actor.workspaceId, projectId)
    .first<{
      id: string;
      result: StoredResultKind;
      readiness_rule_id: string;
      readiness_evaluation_id: string;
      shoot_day_id: string | null;
      completed_at: number;
      code: string;
      owner_only_override: number;
    }>();
  if (!target)
    throw new HttpError(404, "readiness_result_not_found", "The readiness result was not found.");
  const currentEvaluation = await latestEvaluation(
    context.env.DB,
    actor.workspaceId,
    projectId,
    target.shoot_day_id,
  );
  if (currentEvaluation?.id !== target.readiness_evaluation_id) {
    throw new HttpError(
      409,
      "readiness_evaluation_superseded",
      "Re-evaluate and override the current readiness result instead.",
    );
  }
  if (target.result === "pass") {
    throw new HttpError(
      409,
      "readiness_already_satisfied",
      "A satisfied rule does not need an override.",
    );
  }
  const ownerOnly = isOwnerOnlyReadinessCode(target.code);
  if (ownerOnly) assertAllowed(actor, "readiness.override_owner_only");
  const project = await requireProjectMeta(context.env.DB, actor.workspaceId, projectId);
  const profile = await requireProfile(context.env.DB, actor.workspaceId, projectId);
  const rules = await loadRules(context.env.DB, profile.current_version_id, projectId);
  const currentSources = await loadReadinessSources(
    {
      db: context.env.DB,
      workspaceId: actor.workspaceId,
      projectId,
      shootDayId: target.shoot_day_id,
      projectOwnerId: project.owner_user_id,
      now,
    },
    rules,
  );
  const bundle = await loadEvaluationBundle(
    context.env.DB,
    actor.workspaceId,
    projectId,
    await requireEvaluationHeader(
      context.env.DB,
      actor.workspaceId,
      projectId,
      target.readiness_evaluation_id,
    ),
    actor,
    now,
  );
  if (compareEvaluationSources(bundle, currentSources).length > 0) {
    throw new HttpError(409, "readiness_stale", "Re-evaluate before recording an override.");
  }
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: "readiness.override",
    key: context.req.header("Idempotency-Key"),
    requestBody: { projectId, ...input },
  });
  if (lease.replayRef) return ok(context, { overrideId: lease.replayRef });
  const overrideId = createUuidV7();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO readiness_overrides
            (id, workspace_id, project_id, shoot_day_id, readiness_rule_id, scope, reason,
             actor_user_id, expires_at, evidence_object_id, created_at, revoked_at,
             revoked_by_user_id, revoke_reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, NULL, NULL, NULL)`,
      ).bind(
        overrideId,
        actor.workspaceId,
        projectId,
        target.shoot_day_id,
        target.readiness_rule_id,
        target.shoot_day_id ? "shoot_day" : "project",
        input.reason,
        actor.userId,
        input.expiresAt ?? null,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "readiness.override_created",
        objectType: "readiness_override",
        objectId: overrideId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: {
          ruleCode: target.code,
          ownerOnly,
          expiresAt: input.expiresAt ?? null,
          scope: target.shoot_day_id ? "shoot_day" : "project",
        },
      }),
      completeIdempotentOperation(context.env.DB, lease.id, overrideId, 201),
    ]);
    return ok(context, { overrideId }, 201);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
});

readinessRoutes.post("/issues", requireJson, async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  assertAllowed(actor, "artifact.issue");
  const input = issueSchema.parse(await context.req.json());
  const project = await requireProjectMeta(context.env.DB, actor.workspaceId, projectId);
  const header = await requireEvaluationHeader(
    context.env.DB,
    actor.workspaceId,
    projectId,
    input.evaluationId,
  );
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: "readiness.issue",
    key: context.req.header("Idempotency-Key"),
    requestBody: { projectId, evaluationId: input.evaluationId },
  });
  if (lease.replayRef) {
    const replay = await context.env.DB.prepare(
      "SELECT id, issue_number FROM readiness_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3",
    )
      .bind(lease.replayRef, actor.workspaceId, projectId)
      .first<{ id: string; issue_number: number }>();
    if (!replay)
      throw new HttpError(
        409,
        "idempotency_replay_missing",
        "The prior issue cannot be replayed safely.",
      );
    return ok(context, { issueId: replay.id, issueNumber: replay.issue_number });
  }

  try {
    const latest = await latestEvaluation(
      context.env.DB,
      actor.workspaceId,
      projectId,
      header.shoot_day_id,
    );
    if (latest?.id !== header.id) {
      throw new HttpError(
        409,
        "readiness_evaluation_superseded",
        "Issue from the latest evaluation instead.",
      );
    }
    const now = Date.now();
    const profile = await requireProfile(context.env.DB, actor.workspaceId, projectId);
    const rules = await loadRules(context.env.DB, profile.current_version_id, projectId);
    const currentSources = await loadReadinessSources(
      {
        db: context.env.DB,
        workspaceId: actor.workspaceId,
        projectId,
        shootDayId: header.shoot_day_id,
        projectOwnerId: project.owner_user_id,
        now,
      },
      rules,
    );
    const bundle = await loadEvaluationBundle(
      context.env.DB,
      actor.workspaceId,
      projectId,
      header,
      actor,
      now,
    );
    const stale = compareEvaluationSources(bundle, currentSources);
    if (stale.length > 0) {
      throw new HttpError(
        409,
        "readiness_stale",
        "Re-evaluate changed source data before issuing.",
        { reasons: stale.map((reason) => reason.reason) },
      );
    }
    const summary = summarizeReadiness(bundle.results);
    if (!summary.ready) {
      throw new HttpError(
        409,
        "readiness_blocked",
        "A Ready to Shoot issue cannot be frozen while blockers remain.",
        { blocking: summary.blocking },
      );
    }
    const priorIssue = await loadLatestIssue(
      context.env.DB,
      actor.workspaceId,
      projectId,
      header.shoot_day_id,
    );
    const numberRow = await context.env.DB.prepare(
      `SELECT COALESCE(MAX(issue_number), 0) AS value FROM readiness_issues
          WHERE workspace_id = ?1 AND project_id = ?2
            AND ((?3 IS NULL AND shoot_day_id IS NULL) OR shoot_day_id = ?3)`,
    )
      .bind(actor.workspaceId, projectId, header.shoot_day_id)
      .first<{ value: number }>();
    const [approvalRows, approvalDecisionRows] = await Promise.all([
      loadApprovalSnapshots(context.env.DB, actor.workspaceId, projectId),
      loadApprovalDecisionSnapshots(context.env.DB, actor.workspaceId, projectId),
    ]);
    const issueNumber = (numberRow?.value ?? 0) + 1;
    const issueId = createUuidV7();
    const pins = bundle.rows.map((row) =>
      sourcePin(project.registry_id, row.rule_id, row.source_hash),
    );
    const domainResults = bundle.results.map((result, index): DomainReadinessResult => ({
      ...toDomainResult(result),
      evidence: [requireArrayValue(pins, index)],
    }));
    const domainIssue = await createReadinessIssue({
      id: issueId,
      issueNumber,
      issuedAt: now,
      actorId: opaqueIdSchema.parse(actor.userId),
      scopeId: opaqueIdSchema.parse(header.shoot_day_id ?? projectId),
      results: domainResults,
      sourcePins: pins,
      ...(priorIssue ? { supersedesId: opaqueIdSchema.parse(priorIssue.id) } : {}),
    });
    const resultSnapshots = bundle.results.map((result, index): JsonValue => ({
      ruleId: result.rule.id,
      code: result.rule.code,
      title: result.rule.title,
      category: result.rule.category,
      required: result.rule.required,
      severity: result.rule.severity,
      result: result.effective,
      explanation: result.description,
      owner: result.owner,
      dueAt: result.dueAt,
      sourceLabel: result.sourceLabel,
      evidence: result.evidence,
      overrideId: result.overrideId,
      sourcePin: requireArrayValue(pins, index),
      sourceSnapshot: parseEvidence(requireArrayValue(bundle.rows, index).evidence_json).snapshot,
    }));
    const activeOverrideIds = new Set(
      bundle.results.flatMap((result) => (result.overrideId ? [result.overrideId] : [])),
    );
    const frozenOverrides = bundle.overrides
      .filter((override) => activeOverrideIds.has(override.id))
      .map((override): JsonValue => ({
        id: override.id,
        ruleId: override.readiness_rule_id,
        actorUserId: override.actor_user_id,
        actorRole: override.actor_role,
        scope: override.scope,
        reason: override.reason,
        createdAt: override.created_at,
        expiresAt: override.expires_at,
      }));
    const manifest: JsonValue = {
      schemaVersion: "1",
      issueId,
      issueNumber,
      issuedAt: now,
      actorId: actor.userId,
      workspaceId: actor.workspaceId,
      projectId,
      shootDayId: header.shoot_day_id,
      evaluationId: header.id,
      readinessProfileVersionId: header.readiness_profile_version_id,
      supersedesIssueId: priorIssue?.id ?? null,
      domainManifestHash: domainIssue.manifestHash,
      results: resultSnapshots,
      approvals: approvalRows.map(approvalSnapshot),
      approvalDecisions: approvalDecisionRows.map(approvalDecisionSnapshot),
      overrides: frozenOverrides,
    };
    const manifestHash = await hashCanonicalJson(manifest);
    const guardId = createUuidV7();
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO optimistic_mutation_guards
            (id, expected_version, actual_version, created_at)
           VALUES (?1, ?2,
             COALESCE((SELECT version FROM projects WHERE id = ?3 AND workspace_id = ?4), -1), ?5)`,
      ).bind(guardId, project.version, projectId, actor.workspaceId, now),
      context.env.DB.prepare(
        `INSERT INTO readiness_issues
            (id, workspace_id, project_id, shoot_day_id, readiness_evaluation_id, issue_number,
             title, state, manifest_json, manifest_hash, issued_by_user_id, issued_at, supersedes_issue_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ready', ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        issueId,
        actor.workspaceId,
        projectId,
        header.shoot_day_id,
        header.id,
        issueNumber,
        header.shoot_day_id
          ? `${project.title} — Shoot-day Ready to Shoot ${issueNumber}`
          : `${project.title} — Ready to Shoot ${issueNumber}`,
        JSON.stringify(manifest),
        manifestHash,
        actor.userId,
        now,
        priorIssue?.id ?? null,
      ),
    ];
    for (const [index, result] of bundle.results.entries()) {
      const pin = requireArrayValue(pins, index);
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO readiness_issue_results
              (id, readiness_issue_id, readiness_rule_id, result, snapshot_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(
          createUuidV7(),
          issueId,
          result.rule.id,
          domainResultToIssueValue(requireArrayValue(domainResults, index)),
          JSON.stringify(requireArrayValue(resultSnapshots, index)),
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO readiness_issue_sources
              (id, readiness_issue_id, object_id, revision_or_version_id, source_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(createUuidV7(), issueId, project.registry_id, result.rule.id, pin.contentHash, now),
      );
    }
    if (priorIssue) {
      statements.push(
        context.env.DB.prepare(
          "UPDATE readiness_issues SET state = 'superseded' WHERE id = ?1 AND state IN ('ready', 'stale')",
        ).bind(priorIssue.id),
      );
    }
    statements.push(
      header.shoot_day_id
        ? context.env.DB.prepare(
            `UPDATE projects SET version = version + 1, updated_at = ?1
                WHERE id = ?2 AND workspace_id = ?3 AND version = ?4`,
          ).bind(now, projectId, actor.workspaceId, project.version)
        : context.env.DB.prepare(
            `UPDATE projects SET phase = 'ready_to_shoot', readiness_state = 'ready',
                 readiness_score = ?1, version = version + 1, updated_at = ?2
                WHERE id = ?3 AND workspace_id = ?4 AND version = ?5`,
          ).bind(summary.score, now, projectId, actor.workspaceId, project.version),
      ...(header.shoot_day_id
        ? [
            context.env.DB.prepare(
              `UPDATE shoot_days SET readiness_state = 'ready', version = version + 1, updated_at = ?1
                  WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4`,
            ).bind(now, header.shoot_day_id, actor.workspaceId, projectId),
          ]
        : []),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "readiness.issue_created",
        objectType: "readiness_issue",
        objectId: issueId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: {
          issueNumber,
          shootDayId: header.shoot_day_id,
          supersedesIssueId: priorIssue?.id ?? null,
          manifestHash,
        },
      }),
      completeIdempotentOperation(context.env.DB, lease.id, issueId, 201),
      context.env.DB.prepare("DELETE FROM optimistic_mutation_guards WHERE id = ?1").bind(guardId),
    );
    await context.env.DB.batch(statements);
    return ok(context, { issueId, issueNumber }, 201);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    if (isConstraintError(error)) {
      throw new HttpError(
        409,
        "readiness_issue_conflict",
        "Readiness changed while the issue was being frozen. Re-evaluate and retry.",
      );
    }
    throw error;
  }
});

async function findProfile(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<ProfileRow | null> {
  return db
    .prepare(
      `SELECT id, current_version_id FROM readiness_profiles
        WHERE workspace_id = ?1 AND project_id = ?2 AND status = 'active'
          AND archived_at IS NULL AND current_version_id IS NOT NULL
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId)
    .first<ProfileRow>();
}

async function requireProfile(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<ProfileRow> {
  const profile = await findProfile(db, workspaceId, projectId);
  if (!profile)
    throw new HttpError(409, "readiness_not_evaluated", "Run a readiness evaluation first.");
  return profile;
}

async function ensureDefaultProfile(
  db: D1Database,
  actor: ActorContext,
  project: ProjectMeta,
  requestId: string,
  now: number,
): Promise<ProfileRow> {
  const existing = await findProfile(db, actor.workspaceId, project.id);
  if (existing) {
    try {
      await loadRules(db, existing.current_version_id, project.id);
      return existing;
    } catch (error) {
      if (!isProfileConfigurationError(error)) throw error;
    }
  }
  const profileId = createUuidV7();
  const profileVersionId = createUuidV7();
  const configuration: JsonValue = {
    schemaVersion: "1",
    projectType: project.type,
    rules: DEFAULT_READINESS_RULES.map((rule) => ({
      code: rule.code,
      title: rule.title,
      category: rule.category,
      categoryLabel: rule.categoryLabel,
      scope: rule.scope,
      severity: rule.severity,
      required: rule.required,
      ownerOnlyOverride: rule.ownerOnlyOverride,
      resolutionSegment: rule.resolutionSegment,
    })),
  };
  const contentHash = await hashCanonicalJson(configuration);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE readiness_profiles SET status = 'superseded', version = version + 1,
             updated_at = ?1
          WHERE workspace_id = ?2 AND project_id = ?3 AND status = 'active'
            AND archived_at IS NULL`,
      )
      .bind(now, actor.workspaceId, project.id),
    db
      .prepare(
        `INSERT INTO readiness_profiles
          (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank,
           project_type, current_version_id, details_json, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Ready to Shoot', 'active', ?4, ?5, 'a0', ?6, ?7,
                 '{}', 1, NULL, ?8, ?8)`,
      )
      .bind(
        profileId,
        actor.workspaceId,
        project.id,
        "Default complete pre-production readiness profile",
        project.owner_user_id,
        project.type,
        profileVersionId,
        now,
      ),
    db
      .prepare(
        `INSERT INTO readiness_profile_versions
          (id, workspace_id, project_id, readiness_profile_id, version_number, name,
           configuration_json, content_hash, author_user_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, 'Launch readiness profile', ?5, ?6, ?7, ?8)`,
      )
      .bind(
        profileVersionId,
        actor.workspaceId,
        project.id,
        profileId,
        JSON.stringify(configuration),
        contentHash,
        actor.userId,
        now,
      ),
  ];
  for (const [index, rule] of DEFAULT_READINESS_RULES.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO readiness_rules
            (id, workspace_id, project_id, readiness_profile_version_id, code, title, category,
             scope, evaluation_type, severity, required, owner_only_override,
             rule_definition_json, sort_rank, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'automatic', ?9, ?10, ?11, ?12, ?13, ?14)`,
        )
        .bind(
          createUuidV7(),
          actor.workspaceId,
          project.id,
          profileVersionId,
          rule.code,
          rule.title,
          rule.category,
          rule.scope,
          rule.severity,
          rule.required ? 1 : 0,
          rule.ownerOnlyOverride ? 1 : 0,
          JSON.stringify({
            categoryLabel: rule.categoryLabel,
            resolutionSegment: rule.resolutionSegment,
          }),
          `a${String(index).padStart(3, "0")}`,
          now,
        ),
    );
  }
  statements.push(
    auditStatement(db, {
      workspaceId: actor.workspaceId,
      projectId: project.id,
      actor,
      action: "readiness.profile_provisioned",
      objectType: "readiness_profile",
      objectId: profileId,
      requestId,
      occurredAt: now,
      details: {
        supersededProfileId: existing?.id ?? null,
        profileVersionId,
        contentHash,
        ruleCount: DEFAULT_READINESS_RULES.length,
      },
    }),
  );
  await db.batch(statements);
  return requireProfile(db, actor.workspaceId, project.id);
}

async function loadRules(
  db: D1Database,
  profileVersionId: string,
  projectId: string,
): Promise<readonly RuleRuntime[]> {
  const result = await db
    .prepare(
      `SELECT id, code, title, category, scope, evaluation_type, severity, required,
              owner_only_override, rule_definition_json, sort_rank
         FROM readiness_rules WHERE readiness_profile_version_id = ?1
        ORDER BY sort_rank, id`,
    )
    .bind(profileVersionId)
    .all<RuleRow>();
  if (result.results.length === 0) {
    throw new HttpError(
      503,
      "readiness_profile_empty",
      "The active readiness profile has no rules.",
    );
  }
  const configuredCodes = new Set(result.results.map((row) => row.code));
  const missingDefaultCodes = DEFAULT_READINESS_RULES.map((rule) => rule.code).filter(
    (code) => !configuredCodes.has(code),
  );
  if (missingDefaultCodes.length > 0) {
    throw new HttpError(
      503,
      "readiness_profile_incomplete",
      "The active readiness profile omits mandatory launch gates.",
      { missingRuleCodes: missingDefaultCodes },
    );
  }
  const rules = result.results.map((row): RuleRuntime => {
    const definition = parseRuleDefinition(row.rule_definition_json);
    const severity = row.severity === "warning" ? "warning" : "blocker";
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      category: row.category,
      categoryLabel: definition.categoryLabel,
      severity,
      scope: row.scope === "shoot_day" ? "shoot_day" : "project",
      required: row.required === 1,
      automatic: row.evaluation_type === "automatic",
      // The server policy is intentionally independent from editable profile metadata.
      ownerOnlyOverride: isOwnerOnlyReadinessCode(row.code),
      resolutionHref: `/projects/${encodeURIComponent(projectId)}/${definition.resolutionSegment}`,
      sortRank: row.sort_rank,
    };
  });
  if (!rules.some((rule) => rule.required)) {
    throw new HttpError(
      503,
      "readiness_profile_invalid",
      "A readiness profile must contain at least one required gate.",
    );
  }
  return rules;
}

async function latestEvaluation(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  shootDayId: string | null,
): Promise<EvaluationHeaderRow | null> {
  return db
    .prepare(
      `SELECT id, readiness_profile_version_id, shoot_day_id, started_at, completed_at
         FROM readiness_evaluations
        WHERE workspace_id = ?1 AND project_id = ?2 AND state = 'complete'
          AND ((?3 IS NULL AND shoot_day_id IS NULL) OR shoot_day_id = ?3)
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId, shootDayId)
    .first<EvaluationHeaderRow>();
}

async function requireEvaluationHeader(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  evaluationId: string,
): Promise<EvaluationHeaderRow> {
  const row = await db
    .prepare(
      `SELECT id, readiness_profile_version_id, shoot_day_id, started_at, completed_at
         FROM readiness_evaluations
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND state = 'complete' LIMIT 1`,
    )
    .bind(evaluationId, workspaceId, projectId)
    .first<EvaluationHeaderRow>();
  if (!row)
    throw new HttpError(
      404,
      "readiness_evaluation_not_found",
      "The readiness evaluation was not found.",
    );
  return row;
}

async function loadEvaluationBundle(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  header: EvaluationHeaderRow,
  actor: ActorContext,
  now: number,
): Promise<EvaluationBundle> {
  const [rows, overrides] = await Promise.all([
    db
      .prepare(
        `SELECT rr.id, rr.readiness_rule_id AS rule_id, r.code, r.title, r.category,
                r.scope, r.evaluation_type, r.severity, r.required, r.owner_only_override,
                r.rule_definition_json, r.sort_rank, rr.result, rr.owner_user_id,
                u.display_name AS owner_name, rr.due_at, rr.explanation, rr.evidence_json,
                rs.source_hash
           FROM readiness_results rr
           JOIN readiness_rules r ON r.id = rr.readiness_rule_id
           LEFT JOIN user_identities u ON u.id = rr.owner_user_id
           JOIN readiness_sources rs ON rs.readiness_result_id = rr.id
          WHERE rr.workspace_id = ?1 AND rr.project_id = ?2 AND rr.readiness_evaluation_id = ?3
          ORDER BY r.sort_rank, r.id`,
      )
      .bind(workspaceId, projectId, header.id)
      .all<EvaluationResultRow>(),
    loadOverrides(db, workspaceId, projectId, header.shoot_day_id),
  ]);
  const rules = rows.results.map((row): RuleRuntime => {
    const definition = parseRuleDefinition(row.rule_definition_json);
    return {
      id: row.rule_id,
      code: row.code,
      title: row.title,
      category: row.category,
      categoryLabel: definition.categoryLabel,
      scope: row.scope === "shoot_day" ? "shoot_day" : "project",
      severity: row.severity === "warning" ? "warning" : "blocker",
      required: row.required === 1,
      automatic: row.evaluation_type === "automatic",
      ownerOnlyOverride: isOwnerOnlyReadinessCode(row.code),
      resolutionHref: `/projects/${encodeURIComponent(projectId)}/${definition.resolutionSegment}`,
      sortRank: row.sort_rank,
    };
  });
  const runtimeOverrides: OverrideRuntime[] = overrides.map((override) => ({
    id: override.id,
    ruleId: override.readiness_rule_id,
    expiresAt: override.expires_at,
    revokedAt: override.revoked_at,
  }));
  const results = rows.results.map((row, index): ViewResult => {
    const rule = requireArrayValue(rules, index);
    const override = activeOverrideForRule(rule.id, runtimeOverrides, now);
    const stored = normalizeStoredResult(row.result);
    const evidence = parseEvidence(row.evidence_json);
    return {
      id: row.id,
      rule,
      stored,
      effective: effectiveResult(stored, override),
      description: row.explanation,
      owner: row.owner_name,
      dueAt: row.due_at,
      sourceLabel: evidence.sourceLabel,
      evidence: evidence.evidence,
      overrideId: override?.id ?? null,
    };
  });
  if (rows.results.length === 0) {
    throw new HttpError(
      503,
      "readiness_evaluation_empty",
      "The saved readiness evaluation has no results.",
    );
  }
  // actor is deliberately consumed here: response policy is applied later without re-reading auth.
  void actor;
  return {
    header,
    rows: rows.results,
    rules,
    results,
    priorSources: rows.results.map((row) => ({ ruleId: row.rule_id, sourceHash: row.source_hash })),
    overrides,
  };
}

async function loadOverrides(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  shootDayId: string | null,
): Promise<readonly OverrideRow[]> {
  const result = await db
    .prepare(
      `SELECT ro.id, ro.readiness_rule_id, ro.scope, ro.actor_user_id,
              u.role AS actor_role, ro.reason, ro.expires_at, ro.created_at, ro.revoked_at
         FROM readiness_overrides ro JOIN user_identities u ON u.id = ro.actor_user_id
        WHERE ro.workspace_id = ?1 AND ro.project_id = ?2
          AND ((?3 IS NULL AND ro.shoot_day_id IS NULL) OR ro.shoot_day_id = ?3)
        ORDER BY ro.created_at, ro.id`,
    )
    .bind(workspaceId, projectId, shootDayId)
    .all<OverrideRow>();
  return result.results;
}

async function loadApprovalSnapshots(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<readonly ApprovalSnapshotRow[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.object_id, a.title, a.status, a.summary, a.owner_user_id,
              a.approver_user_id, a.pinned_version_id, a.requested_at, a.due_at,
              a.self_approval_allowed, a.version, a.updated_at,
              ad.id AS decision_id, ad.decision, ad.actor_user_id AS decision_actor_user_id,
              ad.share_link_id AS decision_share_link_id,
              ad.actor_label AS decision_actor_label, ad.comment AS decision_comment,
              ad.pinned_version_id AS decision_pinned_version_id,
              ad.created_at AS decision_created_at
         FROM approvals a
         LEFT JOIN approval_decisions ad ON ad.id = (
           SELECT candidate.id FROM approval_decisions candidate
            WHERE candidate.approval_id = a.id
            ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
         )
        WHERE a.workspace_id = ?1 AND a.project_id = ?2 AND a.archived_at IS NULL
        ORDER BY a.updated_at, a.id`,
    )
    .bind(workspaceId, projectId)
    .all<ApprovalSnapshotRow>();
  return result.results;
}

function approvalSnapshot(row: ApprovalSnapshotRow): JsonValue {
  return {
    id: row.id,
    objectId: row.object_id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    ownerUserId: row.owner_user_id,
    approverUserId: row.approver_user_id,
    pinnedVersionId: row.pinned_version_id,
    requestedAt: row.requested_at,
    dueAt: row.due_at,
    selfApprovalAllowed: row.self_approval_allowed === 1,
    version: row.version,
    updatedAt: row.updated_at,
    latestDecision:
      row.decision_id === null
        ? null
        : {
            id: row.decision_id,
            decision: row.decision,
            actorUserId: row.decision_actor_user_id,
            shareLinkId: row.decision_share_link_id,
            actorLabel: row.decision_actor_label,
            comment: row.decision_comment,
            pinnedVersionId: row.decision_pinned_version_id,
            createdAt: row.decision_created_at,
          },
  };
}

async function loadApprovalDecisionSnapshots(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<readonly ApprovalDecisionSnapshotRow[]> {
  const result = await db
    .prepare(
      `SELECT ad.id, ad.approval_id, ad.decision, ad.actor_user_id, ad.share_link_id,
              ad.actor_label, ad.comment, ad.pinned_version_id, ad.created_at
         FROM approval_decisions ad
         JOIN approvals a ON a.id = ad.approval_id
        WHERE ad.workspace_id = ?1 AND ad.project_id = ?2
          AND a.workspace_id = ?1 AND a.project_id = ?2 AND a.archived_at IS NULL
        ORDER BY ad.created_at, ad.id`,
    )
    .bind(workspaceId, projectId)
    .all<ApprovalDecisionSnapshotRow>();
  return result.results;
}

function approvalDecisionSnapshot(row: ApprovalDecisionSnapshotRow): JsonValue {
  return {
    id: row.id,
    approvalId: row.approval_id,
    decision: row.decision,
    actorUserId: row.actor_user_id,
    shareLinkId: row.share_link_id,
    actorLabel: row.actor_label,
    comment: row.comment,
    pinnedVersionId: row.pinned_version_id,
    createdAt: row.created_at,
  };
}

async function requireProjectMeta(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<ProjectMeta> {
  const row = await db
    .prepare(
      `SELECT p.id, p.title, p.type, p.owner_user_id, p.version, o.id AS registry_id
         FROM projects p JOIN object_registry o
           ON o.workspace_id = p.workspace_id AND o.domain_table = 'projects' AND o.domain_id = p.id
        WHERE p.id = ?1 AND p.workspace_id = ?2 LIMIT 1`,
    )
    .bind(projectId, workspaceId)
    .first<ProjectMeta>();
  if (!row) {
    throw new HttpError(
      503,
      "readiness_project_source_missing",
      "The project readiness source is not registered.",
    );
  }
  return row;
}

async function assertShootDay(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  shootDayId: string | null,
): Promise<void> {
  if (!shootDayId) return;
  const row = await db
    .prepare(
      `SELECT id FROM shoot_days WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3
        AND archived_at IS NULL LIMIT 1`,
    )
    .bind(shootDayId, workspaceId, projectId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "shoot_day_not_found", "The shoot day was not found.");
}

async function loadLatestIssue(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  shootDayId: string | null,
): Promise<LatestIssueRow | null> {
  return db
    .prepare(
      `SELECT ri.id, ri.readiness_evaluation_id, ri.shoot_day_id, ri.issue_number, ri.issued_at,
              u.display_name AS actor,
              ri.manifest_hash, ri.state,
              (SELECT MIN(rse.detected_at) FROM readiness_stale_events rse
                WHERE rse.readiness_issue_id = ri.id) AS stale_at
         FROM readiness_issues ri JOIN user_identities u ON u.id = ri.issued_by_user_id
        WHERE ri.workspace_id = ?1 AND ri.project_id = ?2
          AND ((?3 IS NULL AND ri.shoot_day_id IS NULL) OR ri.shoot_day_id = ?3)
        ORDER BY ri.issue_number DESC, ri.issued_at DESC, ri.id DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId, shootDayId)
    .first<LatestIssueRow>();
}

async function detectAndPersistIssueStaleness(
  context: Context<AppEnv>,
  project: ProjectMeta,
  issue: LatestIssueRow,
  rules: readonly RuleRuntime[],
  currentSources: ReadonlyMap<string, SourceObservation>,
  bundle: EvaluationBundle,
): Promise<readonly string[]> {
  if (issue.state === "superseded") return [];
  const [prior, frozenResults] = await Promise.all([
    context.env.DB.prepare(
      `SELECT ris.revision_or_version_id AS rule_id, ris.source_hash, r.title
         FROM readiness_issue_sources ris
         LEFT JOIN readiness_rules r ON r.id = ris.revision_or_version_id
        WHERE ris.readiness_issue_id = ?1`,
    )
      .bind(issue.id)
      .all<{ rule_id: string; source_hash: string; title: string | null }>(),
    context.env.DB.prepare(
      `SELECT readiness_rule_id, snapshot_json FROM readiness_issue_results
        WHERE readiness_issue_id = ?1 ORDER BY readiness_rule_id`,
    )
      .bind(issue.id)
      .all<{ readiness_rule_id: string; snapshot_json: string }>(),
  ]);
  const labels = new Map([
    ...prior.results.map((row) => [row.rule_id, row.title ?? "Readiness source"] as const),
    ...rules.map((rule) => [rule.id, rule.title] as const),
  ]);
  const current = new Map(
    [...currentSources.entries()].map(([ruleId, source]) => [ruleId, source.sourceHash]),
  );
  const reasons: StaleReason[] = [
    ...compareSourceFingerprints({
      prior: prior.results.map((row) => ({ ruleId: row.rule_id, sourceHash: row.source_hash })),
      current,
      ruleLabels: labels,
    }),
  ];
  if (prior.results.length === 0 || frozenResults.results.length === 0) {
    reasons.push({
      ruleId: issue.id,
      priorHash: issue.manifest_hash,
      currentHash: null,
      reason: "Readiness issue integrity: pinned source or result evidence is missing.",
    });
  }
  const activeOverrideIds = new Map(
    bundle.results.map((result) => [result.rule.id, result.overrideId] as const),
  );
  for (const frozenRow of frozenResults.results) {
    const parsed = issueResultSnapshotSchema.safeParse(JSON.parse(frozenRow.snapshot_json));
    if (!parsed.success) {
      reasons.push({
        ruleId: frozenRow.readiness_rule_id,
        priorHash: issue.manifest_hash,
        currentHash: null,
        reason: "Readiness issue integrity: a frozen result snapshot is invalid.",
      });
      continue;
    }
    if (
      parsed.data.overrideId === null ||
      activeOverrideIds.get(frozenRow.readiness_rule_id) === parsed.data.overrideId
    ) {
      continue;
    }
    const currentOverrideId = activeOverrideIds.get(frozenRow.readiness_rule_id) ?? null;
    reasons.push({
      ruleId: frozenRow.readiness_rule_id,
      priorHash: await hashCanonicalJson({ overrideId: parsed.data.overrideId }),
      currentHash: await hashCanonicalJson({ overrideId: currentOverrideId }),
      reason: `${parsed.data.title}: readiness override expired, was revoked or was superseded.`,
    });
  }
  const distinctReasons = [...new Map(reasons.map((reason) => [reason.reason, reason])).values()];
  if (distinctReasons.length === 0) return [];
  const existing = await context.env.DB.prepare(
    `SELECT reason FROM readiness_stale_events WHERE readiness_issue_id = ?1`,
  )
    .bind(issue.id)
    .all<{ reason: string }>();
  const known = new Set(existing.results.map((row) => row.reason));
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const reason of distinctReasons) {
    if (known.has(reason.reason)) continue;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO readiness_stale_events
            (id, workspace_id, project_id, readiness_issue_id, changed_object_id,
             prior_revision_or_version_id, current_revision_or_version_id, reason, detected_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        createUuidV7(),
        context.get("actor").workspaceId,
        project.id,
        issue.id,
        project.registry_id,
        reason.priorHash,
        reason.currentHash,
        reason.reason,
        now,
      ),
    );
  }
  if (statements.length === 0 && issue.state === "stale") {
    return distinctReasons.map((reason) => reason.reason);
  }
  statements.push(
    context.env.DB.prepare(
      "UPDATE readiness_issues SET state = 'stale' WHERE id = ?1 AND state = 'ready'",
    ).bind(issue.id),
    issue.shoot_day_id
      ? context.env.DB.prepare(
          `UPDATE shoot_days SET readiness_state = 'stale', version = version + 1, updated_at = ?1
              WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4
                AND readiness_state <> 'stale'`,
        ).bind(now, issue.shoot_day_id, context.get("actor").workspaceId, project.id)
      : context.env.DB.prepare(
          `UPDATE projects SET readiness_state = 'stale', version = version + 1, updated_at = ?1
              WHERE id = ?2 AND workspace_id = ?3 AND readiness_state <> 'stale'`,
        ).bind(now, project.id, context.get("actor").workspaceId),
    auditStatement(context.env.DB, {
      workspaceId: context.get("actor").workspaceId,
      projectId: project.id,
      action: "readiness.issue_stale_detected",
      objectType: "readiness_issue",
      objectId: issue.id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { reasons: distinctReasons.map((reason) => reason.reason) },
    }),
  );
  await context.env.DB.batch(statements);
  return distinctReasons.map((reason) => reason.reason);
}

function compareEvaluationSources(
  bundle: EvaluationBundle,
  currentSources: ReadonlyMap<string, SourceObservation>,
) {
  return compareSourceFingerprints({
    prior: bundle.priorSources,
    current: new Map(
      [...currentSources.entries()].map(([ruleId, source]) => [ruleId, source.sourceHash]),
    ),
    ruleLabels: new Map(bundle.rules.map((rule) => [rule.id, rule.title])),
  });
}

function responseView(
  bundle: EvaluationBundle,
  actor: ActorContext,
  staleReasons: readonly string[],
  issue: LatestIssueRow | null,
  allowOverrides = true,
): ReadinessResponse {
  const summary = summarizeReadiness(bundle.results);
  const groups = new Map<
    string,
    { label: string; results: ReadinessResponse["groups"][number]["results"] }
  >();
  for (const result of bundle.results) {
    const group = groups.get(result.rule.category) ?? {
      label: result.rule.categoryLabel,
      results: [],
    };
    group.results.push({
      id: result.id,
      label: result.rule.title,
      description: result.description,
      status: uiStatus(result),
      owner: result.owner,
      dueAt: result.dueAt,
      sourceLabel: result.sourceLabel,
      resolutionHref: result.rule.resolutionHref,
      overrideAllowed:
        allowOverrides &&
        result.rule.required &&
        result.effective !== "pass" &&
        result.effective !== "overridden" &&
        (!result.rule.ownerOnlyOverride || actor.role === "workspace_owner"),
      ownerOnly: result.rule.ownerOnlyOverride,
      evidence: result.evidence,
    });
    groups.set(result.rule.category, group);
  }
  return {
    evaluationId: bundle.header.id,
    evaluatedAt: bundle.header.completed_at,
    score: summary.score,
    state: staleReasons.length > 0 ? "stale" : summary.ready ? "ready" : "blocked",
    staleReasons,
    summary: {
      blocking: summary.blocking,
      warnings: summary.warnings,
      passed: summary.passed,
      notApplicable: summary.notApplicable,
      total: summary.total,
    },
    groups: [...groups.entries()].map(([key, group]) => ({
      key,
      label: group.label,
      passed: group.results.filter(
        (result) => result.status === "passed" || result.status === "overridden",
      ).length,
      total: group.results.length,
      results: group.results,
    })),
    latestIssue: issue
      ? {
          id: issue.id,
          issueNumber: issue.issue_number,
          issuedAt: issue.issued_at,
          actor: issue.actor,
          manifestHash: issue.manifest_hash,
          staleAt: issue.stale_at,
        }
      : null,
  };
}

function unevaluatedView(
  projectId: string,
  actor: ActorContext,
  now: number,
  rules?: readonly RuleRuntime[],
): ReadinessResponse {
  const runtime =
    rules ??
    DEFAULT_READINESS_RULES.map((rule, index): RuleRuntime => ({
      id: `unevaluated:${rule.code}`,
      code: rule.code,
      title: rule.title,
      category: rule.category,
      categoryLabel: rule.categoryLabel,
      scope: rule.scope,
      severity: rule.severity,
      required: rule.required,
      automatic: true,
      ownerOnlyOverride: rule.ownerOnlyOverride,
      resolutionHref: `/projects/${encodeURIComponent(projectId)}/${rule.resolutionSegment}`,
      sortRank: `a${String(index).padStart(3, "0")}`,
    }));
  const results: ViewResult[] = runtime.map((rule) => ({
    id: `unevaluated:${rule.code}`,
    rule,
    stored: "unavailable",
    effective: "unavailable",
    description: "Run readiness evaluation to load and freeze this source state.",
    owner: null,
    dueAt: null,
    sourceLabel: null,
    evidence: null,
    overrideId: null,
  }));
  const synthetic: EvaluationBundle = {
    header: {
      id: `unevaluated:${projectId}`,
      readiness_profile_version_id: `unevaluated:${projectId}`,
      shoot_day_id: null,
      started_at: now,
      completed_at: now,
    },
    rows: [],
    rules: runtime,
    results,
    priorSources: [],
    overrides: [],
  };
  return responseView(synthetic, actor, ["No persisted readiness evaluation exists."], null, false);
}

function domainOverride(
  row: OverrideRow,
  projectId: string,
  shootDayId: string | null,
): ReadinessOverride {
  return {
    id: opaqueIdSchema.parse(row.id),
    ruleId: opaqueIdSchema.parse(row.readiness_rule_id),
    actorId: opaqueIdSchema.parse(row.actor_user_id),
    actorRole: row.actor_role,
    scope: row.scope,
    scopeId: opaqueIdSchema.parse(shootDayId ?? projectId),
    reason: row.reason,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function sourcePin(objectId: string, ruleId: string, sourceHash: string): SnapshotPin {
  return {
    objectType: "readiness_source",
    objectId: opaqueIdSchema.parse(objectId),
    versionId: opaqueIdSchema.parse(ruleId),
    contentHash: sourceHash,
  };
}

function uiStatus(
  result: ViewResult,
): "passed" | "warning" | "blocking" | "not_applicable" | "overridden" {
  if (!result.rule.required) return "not_applicable";
  if (result.effective === "pass") return "passed";
  if (result.effective === "overridden") return "overridden";
  if (result.effective === "warning") return "warning";
  return "blocking";
}

function domainResultToIssueValue(
  result: DomainReadinessResult,
): "pass" | "warning" | "blocker" | "unavailable" | "overridden" {
  if (result.status === "satisfied") return "pass";
  if (result.status === "overridden") return "overridden";
  if (result.status === "warning") return "warning";
  if (result.status === "missing" || result.status === "unloaded") return "unavailable";
  return "blocker";
}

function normalizeStoredResult(value: string): StoredResultKind {
  if (value === "pass" || value === "warning" || value === "blocker" || value === "unavailable") {
    return value;
  }
  throw new HttpError(503, "readiness_result_invalid", "A stored readiness result is invalid.");
}

function parseRuleDefinition(value: string) {
  try {
    return ruleDefinitionSchema.parse(JSON.parse(value));
  } catch {
    throw new HttpError(503, "readiness_rule_invalid", "A readiness rule definition is invalid.");
  }
}

function parseEvidence(value: string) {
  try {
    return evidenceSchema.parse(JSON.parse(value));
  } catch {
    throw new HttpError(503, "readiness_evidence_invalid", "Stored readiness evidence is invalid.");
  }
}

function isProfileConfigurationError(error: unknown): error is HttpError {
  return (
    error instanceof HttpError &&
    [
      "readiness_profile_empty",
      "readiness_profile_incomplete",
      "readiness_profile_invalid",
      "readiness_rule_invalid",
    ].includes(error.code)
  );
}

function requireSource(
  sources: ReadonlyMap<string, SourceObservation>,
  ruleId: string,
): SourceObservation {
  const source = sources.get(ruleId);
  if (!source)
    throw new HttpError(503, "readiness_source_unavailable", "A readiness source was not loaded.");
  return source;
}

function requireMapValue<T>(map: ReadonlyMap<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing internal map value for ${key}.`);
  return value;
}

function requireArrayValue<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing internal array value at ${index}.`);
  return value;
}

function requiredProjectId(value: string | undefined): string {
  if (!value) throw new HttpError(404, "not_found", "The project was not found.");
  return value;
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && /constraint|CHECK|UNIQUE|optimistic_mutation/iu.test(error.message)
  );
}
