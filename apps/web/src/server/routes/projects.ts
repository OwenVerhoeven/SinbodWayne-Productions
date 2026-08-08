import { createUuidV7, rankBetween } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertAllowed, assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import { parseIfMatch, versionGuard } from "../records/version";

const projectCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    code: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[A-Za-z0-9-]+$/u),
    type: z.enum([
      "short_film",
      "narrative_video",
      "music_video",
      "youtube",
      "commercial",
      "episodic",
    ]),
  })
  .strict();

const projectPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(160).optional(),
    code: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[A-Za-z0-9-]+$/u)
      .optional(),
    phase: z
      .enum([
        "idea",
        "development",
        "writing",
        "planning",
        "ready_to_shoot",
        "shooting",
        "post",
        "complete",
        "archived",
      ])
      .optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(16).optional(),
    currency: z.string().length(3).optional(),
    unitSystem: z.enum(["metric", "imperial"]).optional(),
    paperSize: z.enum(["A4", "Letter"]).optional(),
    aspectRatio: z.string().max(24).optional(),
  })
  .strict();

interface ProjectRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly working_title: string | null;
  readonly type: string;
  readonly phase: string;
  readonly status: string;
  readonly readiness_state: string;
  readonly readiness_score: number;
  readonly timezone: string;
  readonly updated_at: number;
  readonly version: number;
  readonly archived_at: number | null;
}

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use("*", requireActor);
projectRoutes.use("*", requireSameOrigin);
projectRoutes.use("*", requireCsrf);

projectRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const query = z
    .object({
      q: z.string().max(160).catch(""),
      limit: z.coerce.number().int().min(1).max(100).catch(50),
      cursor: z.string().optional(),
      state: z.enum(["active", "archived", "all"]).catch("active"),
    })
    .parse(context.req.query());
  const search = `%${query.q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const archiveClause =
    query.state === "active"
      ? "AND p.archived_at IS NULL"
      : query.state === "archived"
        ? "AND p.archived_at IS NOT NULL"
        : "";
  const result = await context.env.DB.prepare(
    `SELECT p.id, p.code, p.title, p.working_title, p.type, p.phase, p.status,
            p.readiness_state, p.readiness_score, p.timezone, p.updated_at, p.version, p.archived_at
       FROM projects p
       JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?1 AND pm.status = 'active'
      WHERE p.workspace_id = ?2
        AND (?3 = '' OR p.title LIKE ?4 ESCAPE '\\' OR p.code LIKE ?4 ESCAPE '\\')
        ${archiveClause}
        AND (?5 IS NULL OR (p.updated_at < CAST(substr(?5, 1, instr(?5, ':') - 1) AS INTEGER) OR (p.updated_at = CAST(substr(?5, 1, instr(?5, ':') - 1) AS INTEGER) AND p.id < substr(?5, instr(?5, ':') + 1))))
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT ?6`,
  )
    .bind(actor.userId, actor.workspaceId, query.q, search, query.cursor ?? null, query.limit + 1)
    .all<ProjectRow>();
  const rows = result.results;
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit).map(projectView);
  const last = items.at(-1);
  return ok(context, {
    items,
    nextCursor: hasMore && last ? `${last.updatedAt}:${last.id}` : null,
  });
});

projectRoutes.use("/", requireJson);
projectRoutes.post("/", async (context) => {
  const actor = context.get("actor");
  assertAllowed(actor, "project.create");
  const input = projectCreateSchema.parse(await context.req.json());
  const id = createUuidV7();
  const screenplayId = createUuidV7();
  const draftId = createUuidV7();
  const now = Date.now();
  const code = input.code.toUpperCase();
  const workspaceUsers = await context.env.DB.prepare(
    "SELECT id FROM user_identities WHERE workspace_id = ?1 AND status = 'active' ORDER BY id",
  )
    .bind(actor.workspaceId)
    .all<{ id: string }>();
  const folders = [
    ["00 Project & Development", "00-project-development"],
    ["01 Story & Writing", "01-story-writing"],
    ["02 Breakdown", "02-breakdown"],
    ["03 Visual Planning", "03-visual-planning"],
    ["04 Cast & Crew", "04-cast-crew"],
    ["05 Locations", "05-locations"],
    ["06 Budget", "06-budget"],
    ["07 Legal & Safety", "07-legal-safety"],
    ["08 Equipment & Logistics", "08-equipment-logistics"],
    ["09 Schedule", "09-schedule"],
    ["10 Call Sheets & Production Packs", "10-call-sheets-production-packs"],
    ["11 Exports & Archive", "11-exports-archive"],
  ] as const;
  const statements = [
    context.env.DB.prepare(
      `INSERT INTO projects
        (id, workspace_id, code, title, working_title, type, phase, status, owner_user_id, readiness_state, readiness_score, timezone, locale, currency, unit_system, paper_size, frame_rate_numerator, frame_rate_denominator, aspect_ratio, created_at, updated_at, version, archived_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'idea', 'active', ?6, 'blocked', 0, 'Europe/Amsterdam', 'en-GB', 'EUR', 'metric', 'A4', 24, 1, '16:9', ?7, ?7, 1, NULL)`,
    ).bind(id, actor.workspaceId, code, input.title, input.type, actor.userId, now),
    context.env.DB.prepare(
      `INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'project', 'projects', ?3, ?4, 1, NULL, ?5, ?5)`,
    ).bind(createUuidV7(), actor.workspaceId, id, input.title, now),
    context.env.DB.prepare(
      `INSERT INTO screenplays
        (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, current_draft_id, current_revision_id, approved_revision_id, numbering_locked, frame_rate_numerator, frame_rate_denominator, paper_size, details_json, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'draft', NULL, ?5, 'a0', ?6, NULL, NULL, 0, 24, 1, 'A4', '{}', 1, NULL, ?7, ?7)`,
    ).bind(
      screenplayId,
      actor.workspaceId,
      id,
      `${input.title} Screenplay`,
      actor.userId,
      draftId,
      now,
    ),
    context.env.DB.prepare(
      `INSERT INTO script_drafts
        (id, workspace_id, project_id, screenplay_id, title, autosave_state, base_revision_id, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'Working Draft', 'saved', NULL, 1, ?5, ?5)`,
    ).bind(draftId, actor.workspaceId, id, screenplayId, now),
    context.env.DB.prepare(
      `INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'screenplay', 'screenplays', ?4, ?5, 1, NULL, ?6, ?6)`,
    ).bind(createUuidV7(), actor.workspaceId, id, screenplayId, `${input.title} Screenplay`, now),
  ];
  for (const member of workspaceUsers.results) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO project_memberships (id, workspace_id, project_id, user_id, role, status, version, created_at, updated_at, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6, NULL)`,
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        id,
        member.id,
        member.id === actor.userId ? "owner" : "producer",
        now,
      ),
    );
  }
  let previousRank: string | undefined;
  for (const [title, slug] of folders) {
    const folderId = createUuidV7();
    const rank = rankBetween(previousRank, undefined);
    previousRank = rank;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO folders (id, workspace_id, project_id, parent_folder_id, title, logical_code, sort_rank, version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 1, NULL, ?7, ?7)`,
      ).bind(folderId, actor.workspaceId, id, title, slug, rank, now),
    );
  }
  statements.push(
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId: id,
      actor,
      action: "project.created",
      objectType: "project",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { code, type: input.type },
    }),
  );
  await context.env.DB.batch(statements);
  const row = await getProject(context.env.DB, actor.userId, actor.workspaceId, id);
  if (!row)
    throw new HttpError(
      500,
      "project_create_failed",
      "The project could not be read after creation.",
    );
  return ok(context, projectView(row), 201);
});

projectRoutes.get("/:projectId/settings", async (context) => {
  const actor = context.get("actor");
  const projectId = context.req.param("projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const project = await context.env.DB.prepare(
    `SELECT p.*, EXISTS(SELECT 1 FROM legal_holds lh WHERE lh.project_id = p.id AND lh.released_at IS NULL) AS legal_hold
       FROM projects p WHERE p.id = ?1 AND p.workspace_id = ?2 LIMIT 1`,
  )
    .bind(projectId, actor.workspaceId)
    .first<Record<string, unknown>>();
  if (!project) throw new HttpError(404, "not_found", "The requested project was not found.");
  const sessionRows = await context.env.DB.prepare(
    `SELECT id, created_at, last_seen_at, absolute_expires_at, device_label FROM sessions
      WHERE user_id = ?1 AND workspace_id = ?2 AND revoked_at IS NULL AND absolute_expires_at > ?3
      ORDER BY last_seen_at DESC`,
  )
    .bind(actor.userId, actor.workspaceId, Date.now())
    .all<{
      id: string;
      created_at: number;
      last_seen_at: number;
      absolute_expires_at: number;
      device_label: string;
    }>();
  return ok(context, {
    project: {
      ...projectViewFromUnknown(project),
      locale: project.locale,
      currency: project.currency,
      unitSystem: project.unit_system,
      paperSize: project.paper_size,
      frameRateNumerator: project.frame_rate_numerator,
      frameRateDenominator: project.frame_rate_denominator,
      aspectRatio: project.aspect_ratio,
      confidentiality: project.confidentiality ?? "internal",
      enabledModules: parseStringArray(project.enabled_modules_json),
      legalHold: Boolean(project.legal_hold),
    },
    sessions: sessionRows.results.map((session) => ({
      id: session.id,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      current: session.id === actor.sessionId,
      deviceLabel: session.device_label,
      expiresAt: session.absolute_expires_at,
    })),
    providers: [
      {
        key: "email",
        label: "Email delivery",
        state: "not_configured",
        fallback: "Copy secure link, download/print, and log manual status.",
      },
      {
        key: "sms",
        label: "SMS delivery",
        state: "not_configured",
        fallback: "Copy the recipient link and record manual confirmation.",
      },
      {
        key: "weather",
        label: "Weather",
        state: "not_configured",
        fallback: "Enter and freeze manual weather and contingency notes.",
      },
      {
        key: "signature",
        label: "External signature",
        state: "not_configured",
        fallback: "Upload a signed file and track execution evidence.",
      },
      {
        key: "malware_scan",
        label: "Malware scanning",
        state: "not_configured",
        fallback: "Uploads remain quarantined pending manual review policy.",
      },
    ],
  });
});

projectRoutes.use("/:projectId", requireJson);
projectRoutes.patch("/:projectId", async (context) => {
  const actor = context.get("actor");
  const projectId = context.req.param("projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = projectPatchSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const guard = versionGuard(
    context.env.DB,
    "projects",
    projectId,
    actor.workspaceId,
    undefined,
    expected,
  );
  const now = Date.now();
  const current = await context.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND workspace_id = ?2",
  )
    .bind(projectId, actor.workspaceId)
    .first<Record<string, unknown>>();
  if (!current) throw new HttpError(404, "not_found", "The requested project was not found.");
  const next = { ...current, ...snakeProjectPatch(input) };
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        `UPDATE projects SET title = ?1, code = ?2, phase = ?3, timezone = ?4, locale = ?5, currency = ?6, unit_system = ?7, paper_size = ?8, aspect_ratio = ?9, updated_at = ?10, version = version + 1 WHERE id = ?11 AND workspace_id = ?12`,
      ).bind(
        next.title,
        next.code,
        next.phase,
        next.timezone,
        next.locale,
        next.currency,
        next.unit_system,
        next.paper_size,
        next.aspect_ratio,
        now,
        projectId,
        actor.workspaceId,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "project.updated",
        objectType: "project",
        objectId: projectId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { fields: Object.keys(input) },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw await projectConflict(
        context.env.DB,
        actor.userId,
        actor.workspaceId,
        projectId,
        expected,
      );
    throw error;
  }
  const row = await getProject(context.env.DB, actor.userId, actor.workspaceId, projectId);
  if (!row) throw new HttpError(404, "not_found", "The requested project was not found.");
  return ok(context, projectView(row));
});

for (const action of ["archive", "restore"] as const) {
  projectRoutes.post(`/:projectId/${action}`, async (context) => {
    const actor = context.get("actor");
    const projectId = context.req.param("projectId");
    if (!projectId) throw new HttpError(404, "not_found", "The project was not found.");
    await assertProjectAccess(
      context.env.DB,
      actor,
      projectId,
      action === "archive" ? "edit" : "view",
    );
    const expected = parseIfMatch(context.req.header("If-Match"));
    const current = await context.env.DB.prepare(
      "SELECT archived_at FROM projects WHERE id = ?1 AND workspace_id = ?2 LIMIT 1",
    )
      .bind(projectId, actor.workspaceId)
      .first<{ archived_at: number | null }>();
    if (!current) throw new HttpError(404, "not_found", "The project was not found.");
    if ((action === "archive") === (current.archived_at !== null)) {
      throw new HttpError(
        409,
        "lifecycle_conflict",
        `The project is already ${action === "archive" ? "archived" : "active"}.`,
      );
    }
    const guard = versionGuard(
      context.env.DB,
      "projects",
      projectId,
      actor.workspaceId,
      undefined,
      expected,
    );
    const now = Date.now();
    try {
      await context.env.DB.batch([
        guard.insert,
        action === "archive"
          ? context.env.DB.prepare(
              "UPDATE projects SET phase = 'archived', status = 'archived', archived_at = ?1, version = version + 1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3",
            ).bind(now, projectId, actor.workspaceId)
          : context.env.DB.prepare(
              `UPDATE projects SET phase = CASE
                   WHEN EXISTS (SELECT 1 FROM script_revisions sr WHERE sr.project_id = projects.id) THEN 'planning'
                   WHEN EXISTS (SELECT 1 FROM project_briefs pb WHERE pb.project_id = projects.id) THEN 'development'
                   ELSE 'idea' END,
                 status = 'active', archived_at = NULL, version = version + 1, updated_at = ?1
                 WHERE id = ?2 AND workspace_id = ?3`,
            ).bind(now, projectId, actor.workspaceId),
        context.env.DB.prepare(
          "UPDATE object_registry SET archived_at = ?1, version = version + 1, updated_at = ?2 WHERE domain_table = 'projects' AND domain_id = ?3 AND workspace_id = ?4",
        ).bind(action === "archive" ? now : null, now, projectId, actor.workspaceId),
        auditStatement(context.env.DB, {
          workspaceId: actor.workspaceId,
          projectId,
          actor,
          action: `project.${action}d`,
          objectType: "project",
          objectId: projectId,
          requestId: context.get("requestId"),
          occurredAt: now,
        }),
        guard.remove,
      ]);
    } catch (error) {
      if (isConstraintError(error)) {
        throw await projectConflict(
          context.env.DB,
          actor.userId,
          actor.workspaceId,
          projectId,
          expected,
        );
      }
      throw error;
    }
    const row = await getProject(context.env.DB, actor.userId, actor.workspaceId, projectId);
    if (!row) throw new HttpError(404, "not_found", "The project was not found.");
    return ok(context, projectView(row));
  });
}

async function getProject(
  db: D1Database,
  userId: string,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.code, p.title, p.working_title, p.type, p.phase, p.status, p.readiness_state, p.readiness_score, p.timezone, p.updated_at, p.version, p.archived_at
       FROM projects p JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?1 AND pm.status = 'active'
      WHERE p.id = ?2 AND p.workspace_id = ?3 LIMIT 1`,
    )
    .bind(userId, projectId, workspaceId)
    .first<ProjectRow>();
}

function projectView(row: ProjectRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    workingTitle: row.working_title,
    type: row.type,
    phase: row.phase,
    status: row.status,
    readinessState: row.readiness_state,
    readinessScore: row.readiness_score,
    timezone: row.timezone,
    updatedAt: row.updated_at,
    version: row.version,
    archivedAt: row.archived_at,
  };
}

function projectViewFromUnknown(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    code: String(row.code),
    title: String(row.title),
    workingTitle: typeof row.working_title === "string" ? row.working_title : null,
    type: String(row.type),
    phase: String(row.phase),
    status: String(row.status),
    readinessState: String(row.readiness_state),
    readinessScore: Number(row.readiness_score),
    timezone: String(row.timezone),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
    archivedAt: typeof row.archived_at === "number" ? row.archived_at : null,
  };
}

function snakeProjectPatch(input: z.infer<typeof projectPatchSchema>): Record<string, unknown> {
  return {
    ...(input.title ? { title: input.title } : {}),
    ...(input.code ? { code: input.code.toUpperCase() } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
    ...(input.unitSystem ? { unit_system: input.unitSystem } : {}),
    ...(input.paperSize ? { paper_size: input.paperSize } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL/iu.test(error.message);
}

async function projectConflict(
  db: D1Database,
  userId: string,
  workspaceId: string,
  projectId: string,
  expected: number,
): Promise<HttpError> {
  const current = await getProject(db, userId, workspaceId, projectId);
  return new HttpError(409, "version_conflict", "This project was changed in another session.", {
    expectedVersion: expected,
    current: current ? projectView(current) : null,
  });
}
