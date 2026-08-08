import { Hono } from "hono";

import { assertProjectAccess } from "../auth/policy";
import { requireActor } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";

interface CountRow {
  readonly count: number;
}

interface ReadinessSummaryRow {
  readonly total: number;
  readonly passed: number;
  readonly blocking: number;
  readonly warnings: number;
}

interface PriorityRow {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly result: "blocker" | "warning" | "unavailable";
  readonly category: string;
  readonly resolution_object_id: string | null;
}

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use("*", requireActor, requireSameOrigin);

dashboardRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = context.req.param("projectId");
  if (!projectId) throw new HttpError(404, "not_found", "The project was not found.");
  await assertProjectAccess(context.env.DB, actor, projectId);

  const latestEvaluation = await context.env.DB.prepare(
    `SELECT id FROM readiness_evaluations
      WHERE workspace_id = ?1 AND project_id = ?2 AND shoot_day_id IS NULL AND state = 'complete'
      ORDER BY completed_at DESC, id DESC LIMIT 1`,
  )
    .bind(actor.workspaceId, projectId)
    .first<{ id: string }>();

  const evaluationId = latestEvaluation?.id ?? null;
  const now = Date.now();
  const [
    readiness,
    priorities,
    departments,
    script,
    syncCount,
    schedule,
    conflictCount,
    changes,
    announcements,
    overdueTasks,
    unconfirmed,
    budget,
    archive,
  ] = await Promise.all([
    context.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN rr.result = 'pass' OR EXISTS (
                SELECT 1 FROM readiness_overrides ro
                 WHERE ro.project_id = rr.project_id
                   AND ro.readiness_rule_id = rr.readiness_rule_id
                   AND ro.shoot_day_id IS NULL
                   AND ro.revoked_at IS NULL
                   AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
              ) THEN 1 ELSE 0 END), 0) AS passed,
              COALESCE(SUM(CASE WHEN rr.result IN ('blocker', 'unavailable') AND NOT EXISTS (
                SELECT 1 FROM readiness_overrides ro
                 WHERE ro.project_id = rr.project_id
                   AND ro.readiness_rule_id = rr.readiness_rule_id
                   AND ro.shoot_day_id IS NULL
                   AND ro.revoked_at IS NULL
                   AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
              ) THEN 1 ELSE 0 END), 0) AS blocking,
              COALESCE(SUM(CASE WHEN rr.result = 'warning' AND NOT EXISTS (
                SELECT 1 FROM readiness_overrides ro
                 WHERE ro.project_id = rr.project_id
                   AND ro.readiness_rule_id = rr.readiness_rule_id
                   AND ro.shoot_day_id IS NULL
                   AND ro.revoked_at IS NULL
                   AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
              ) THEN 1 ELSE 0 END), 0) AS warnings
         FROM readiness_results rr
        WHERE rr.readiness_evaluation_id = ?1`,
    )
      .bind(evaluationId, now)
      .first<ReadinessSummaryRow>(),
    context.env.DB.prepare(
      `SELECT rr.id, r.title, rr.explanation, rr.result, r.category, rr.resolution_object_id
         FROM readiness_results rr
         JOIN readiness_rules r ON r.id = rr.readiness_rule_id
        WHERE rr.readiness_evaluation_id = ?1
          AND rr.result IN ('blocker', 'warning', 'unavailable')
          AND NOT EXISTS (
            SELECT 1 FROM readiness_overrides ro
             WHERE ro.project_id = rr.project_id
               AND ro.readiness_rule_id = rr.readiness_rule_id
               AND ro.shoot_day_id IS NULL
               AND ro.revoked_at IS NULL
               AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
          )
        ORDER BY CASE rr.result WHEN 'blocker' THEN 0 WHEN 'unavailable' THEN 1 ELSE 2 END, r.sort_rank, rr.id
        LIMIT 8`,
    )
      .bind(evaluationId, now)
      .all<PriorityRow>(),
    context.env.DB.prepare(
      `SELECT r.category AS name,
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN rr.result = 'pass' OR EXISTS (
                SELECT 1 FROM readiness_overrides ro
                 WHERE ro.project_id = rr.project_id
                   AND ro.readiness_rule_id = rr.readiness_rule_id
                   AND ro.shoot_day_id IS NULL
                   AND ro.revoked_at IS NULL
                   AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
              ) THEN 1 ELSE 0 END), 0) AS ready,
              COALESCE(SUM(CASE WHEN rr.result IN ('blocker', 'unavailable') AND NOT EXISTS (
                SELECT 1 FROM readiness_overrides ro
                 WHERE ro.project_id = rr.project_id
                   AND ro.readiness_rule_id = rr.readiness_rule_id
                   AND ro.shoot_day_id IS NULL
                   AND ro.revoked_at IS NULL
                   AND (ro.expires_at IS NULL OR ro.expires_at > ?2)
              ) THEN 1 ELSE 0 END), 0) AS blockers
         FROM readiness_results rr JOIN readiness_rules r ON r.id = rr.readiness_rule_id
        WHERE rr.readiness_evaluation_id = ?1
        GROUP BY r.category ORDER BY r.category LIMIT 20`,
    )
      .bind(evaluationId, now)
      .all<{ name: string; total: number; ready: number; blockers: number }>(),
    context.env.DB.prepare(
      `SELECT sr.id, sr.name, sr.created_at, s.approved_revision_id
         FROM screenplays s LEFT JOIN script_revisions sr ON sr.id = s.current_revision_id
        WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.archived_at IS NULL
        ORDER BY s.updated_at DESC LIMIT 1`,
    )
      .bind(actor.workspaceId, projectId)
      .first<{
        id: string | null;
        name: string | null;
        created_at: number | null;
        approved_revision_id: string | null;
      }>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM scene_mappings sm
        JOIN script_syncs ss ON ss.id = sm.script_sync_id
        WHERE ss.workspace_id = ?1 AND ss.project_id = ?2
          AND ss.status IN ('preview', 'needs_resolution', 'ready')
          AND (sm.mapping_kind IN ('ambiguous', 'removed') AND sm.resolution IS NULL)`,
    )
      .bind(actor.workspaceId, projectId)
      .first<CountRow>(),
    context.env.DB.prepare(
      `SELECT sr.name, sd.shoot_date
         FROM schedules s
         LEFT JOIN schedule_revisions sr ON sr.id = COALESCE(s.approved_revision_id, s.current_revision_id)
         LEFT JOIN shoot_days sd ON sd.schedule_revision_id = sr.id AND sd.archived_at IS NULL
        WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.archived_at IS NULL
        ORDER BY s.is_default DESC, s.updated_at DESC, sd.shoot_date ASC LIMIT 1`,
    )
      .bind(actor.workspaceId, projectId)
      .first<{ name: string | null; shoot_date: string | null }>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM resource_conflicts
        WHERE workspace_id = ?1 AND project_id = ?2 AND status = 'open'`,
    )
      .bind(actor.workspaceId, projectId)
      .first<CountRow>(),
    context.env.DB.prepare(
      `SELECT a.id, COALESCE(u.display_name, 'System') AS actor, a.action,
              COALESCE(o.title, replace(a.object_type, '_', ' ')) AS object_title, a.created_at
         FROM audit_events a
         LEFT JOIN user_identities u ON u.id = a.actor_id AND a.actor_type = 'user'
         LEFT JOIN object_registry o ON o.workspace_id = a.workspace_id
           AND o.project_id = a.project_id AND o.domain_id = a.object_id
        WHERE a.workspace_id = ?1 AND a.project_id = ?2
        ORDER BY a.created_at DESC, a.id DESC LIMIT 12`,
    )
      .bind(actor.workspaceId, projectId)
      .all<{
        id: string;
        actor: string;
        action: string;
        object_title: string;
        created_at: number;
      }>(),
    context.env.DB.prepare(
      `SELECT a.id, a.title, a.body, u.display_name AS author, a.created_at
         FROM announcements a JOIN user_identities u ON u.id = a.author_user_id
        WHERE a.workspace_id = ?1 AND a.project_id = ?2 AND a.archived_at IS NULL
          AND a.status = 'published' AND (a.expires_at IS NULL OR a.expires_at > ?3)
        ORDER BY a.created_at DESC, a.id DESC LIMIT 4`,
    )
      .bind(actor.workspaceId, projectId, now)
      .all<{ id: string; title: string; body: string; author: string; created_at: number }>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_cards
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
          AND due_at IS NOT NULL AND due_at < ?3 AND status NOT IN ('done', 'complete', 'archived')`,
    )
      .bind(actor.workspaceId, projectId, now)
      .first<CountRow>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM call_sheet_recipient_issues cri
        JOIN call_sheet_issues ci ON ci.id = cri.call_sheet_issue_id
        LEFT JOIN confirmations c ON c.call_sheet_recipient_issue_id = cri.id
        WHERE ci.workspace_id = ?1 AND ci.project_id = ?2 AND c.id IS NULL`,
    )
      .bind(actor.workspaceId, projectId)
      .first<CountRow>(),
    context.env.DB.prepare(
      `SELECT p.currency,
              COALESCE(SUM(bv.total_actual_minor - bv.total_approved_minor), 0) AS variance
         FROM projects p
         LEFT JOIN budgets b ON b.project_id = p.id AND b.archived_at IS NULL
         LEFT JOIN budget_versions bv ON bv.id = b.working_version_id
        WHERE p.workspace_id = ?1 AND p.id = ?2 GROUP BY p.currency`,
    )
      .bind(actor.workspaceId, projectId)
      .first<{ currency: string; variance: number }>(),
    context.env.DB.prepare(
      `SELECT status FROM archive_jobs WHERE workspace_id = ?1 AND project_id = ?2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(actor.workspaceId, projectId)
      .first<{ status: "requested" | "running" | "verifying" | "verified" | "failed" }>(),
  ]);

  const total = readiness?.total ?? 0;
  const passed = readiness?.passed ?? 0;
  return ok(context, {
    readiness: {
      score: total > 0 ? Math.round((passed / total) * 100) : 0,
      blocking: readiness?.blocking ?? 0,
      warnings: readiness?.warnings ?? 0,
      passed,
      total,
    },
    script: {
      revisionName: script?.name ?? null,
      approved: Boolean(script?.id && script.approved_revision_id === script.id),
      unresolvedMappings: syncCount?.count ?? 0,
      updatedAt: script?.created_at ?? null,
    },
    schedule: {
      revisionName: schedule?.name ?? null,
      shootDate: parseShootDate(schedule?.shoot_date),
      conflicts: conflictCount?.count ?? 0,
    },
    priorities: priorities.results.map((row) => ({
      id: row.id,
      title: row.title,
      detail: row.explanation,
      tone: row.result === "blocker" || row.result === "unavailable" ? "danger" : "warning",
      href: readinessHref(projectId, row.category, row.resolution_object_id),
    })),
    departments: departments.results.map((row) => ({
      name: humanise(row.name),
      ready: row.ready,
      total: row.total,
      blockers: row.blockers,
      href: `/projects/${encodeURIComponent(projectId)}/readiness?category=${encodeURIComponent(row.name)}`,
    })),
    changes: changes.results.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: humanise(row.action),
      objectTitle: row.object_title,
      occurredAt: row.created_at,
    })),
    announcements: announcements.results.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      author: row.author,
      createdAt: row.created_at,
    })),
    overdueTasks: overdueTasks?.count ?? 0,
    unconfirmedRecipients: unconfirmed?.count ?? 0,
    budgetVarianceMinor: budget?.variance ?? 0,
    currency: budget?.currency ?? "EUR",
    archiveHealth: archiveState(archive?.status),
  });
});

function humanise(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function parseShootDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function readinessHref(projectId: string, category: string, objectId: string | null): string {
  const params = new URLSearchParams({ category });
  if (objectId) params.set("object", objectId);
  return `/projects/${encodeURIComponent(projectId)}/readiness?${params.toString()}`;
}

function archiveState(
  value: "requested" | "running" | "verifying" | "verified" | "failed" | undefined,
): "healthy" | "requested" | "running" | "failed" | "not_requested" {
  if (value === "verified") return "healthy";
  if (value === "requested") return "requested";
  if (value === "running" || value === "verifying") return "running";
  if (value === "failed") return "failed";
  return "not_requested";
}
