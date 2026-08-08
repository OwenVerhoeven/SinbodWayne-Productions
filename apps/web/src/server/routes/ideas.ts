import { createUuidV7, rankBetween } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertAllowed } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
} from "../idempotency";
import { parseIfMatch, versionGuard } from "../records/version";

const productionTypes = [
  "short_film",
  "narrative_video",
  "music_video",
  "youtube",
  "commercial",
  "episodic",
] as const;
const ideaCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    summary: z.string().trim().max(1_000).default(""),
    type: z.enum(productionTypes),
    source: z.string().trim().max(500).default(""),
    tags: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
    notes: z.string().trim().max(8_000).default(""),
    links: z.array(z.string().url().max(2_000)).max(20).default([]),
  })
  .strict();
const promoteSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[A-Za-z0-9-]+$/u),
    type: z.enum(productionTypes),
  })
  .strict();
const ideaPatchSchema = ideaCreateSchema
  .partial()
  .extend({ status: z.enum(["inbox", "developing", "parked", "promoted"]).optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");

interface IdeaRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly type: string | null;
  readonly source: string | null;
  readonly status: string;
  readonly summary: string | null;
  readonly details_json: string;
  readonly promoted_at: number | null;
  readonly version: number;
  readonly archived_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export const ideaRoutes = new Hono<AppEnv>();
ideaRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

ideaRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const query = z
    .object({
      q: z.string().trim().max(160).catch(""),
      state: z.enum(["active", "archived", "all"]).catch("active"),
      limit: z.coerce.number().int().min(1).max(100).catch(50),
    })
    .parse(context.req.query());
  const archiveClause =
    query.state === "active"
      ? "AND archived_at IS NULL"
      : query.state === "archived"
        ? "AND archived_at IS NOT NULL"
        : "";
  const search = `%${escapeLike(query.q)}%`;
  const rows = await context.env.DB.prepare(
    `SELECT id, project_id, title, type, source, status, summary, details_json, promoted_at, version, archived_at, created_at, updated_at FROM ideas WHERE workspace_id = ?1 ${archiveClause} AND (?2 = '' OR title LIKE ?3 ESCAPE '\\' OR COALESCE(summary, '') LIKE ?3 ESCAPE '\\') ORDER BY updated_at DESC, id DESC LIMIT ?4`,
  )
    .bind(actor.workspaceId, query.q, search, query.limit)
    .all<IdeaRow>();
  return ok(context, { items: rows.results.map(ideaView) });
});

ideaRoutes.use("/", requireJson);
ideaRoutes.post("/", async (context) => {
  const actor = context.get("actor");
  const input = ideaCreateSchema.parse(await context.req.json());
  const id = createUuidV7();
  const now = Date.now();
  const details = JSON.stringify({ notes: input.notes, links: input.links, tags: input.tags });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO ideas (id, workspace_id, project_id, title, type, source, status, summary, owner_user_id, sort_rank, details_json, promoted_at, version, archived_at, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, 'inbox', ?6, ?7, 'a0', ?8, NULL, 1, NULL, ?9, ?9)",
    ).bind(
      id,
      actor.workspaceId,
      input.title,
      input.type,
      input.source || null,
      input.summary || null,
      actor.userId,
      details,
      now,
    ),
    context.env.DB.prepare(
      "INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at) VALUES (?1, ?2, NULL, 'idea', 'ideas', ?3, ?4, 1, NULL, ?5, ?5)",
    ).bind(createUuidV7(), actor.workspaceId, id, input.title, now),
    context.env.DB.prepare(
      "INSERT INTO idea_history (id, workspace_id, idea_id, actor_user_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'captured', ?5, ?6)",
    ).bind(
      createUuidV7(),
      actor.workspaceId,
      id,
      actor.userId,
      JSON.stringify({ type: input.type, tags: input.tags }),
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      actor,
      action: "idea.captured",
      objectType: "idea",
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, ideaView(await requireIdea(context.env.DB, actor.workspaceId, id)), 201);
});

ideaRoutes.use("/:ideaId", requireJson);
ideaRoutes.patch("/:ideaId", async (context) => {
  const actor = context.get("actor");
  const ideaId = requiredParam(context.req.param("ideaId"));
  const input = ideaPatchSchema.parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const current = await requireIdea(context.env.DB, actor.workspaceId, ideaId);
  if (current.archived_at)
    throw new HttpError(409, "idea_archived", "Restore the idea before editing it.");
  const currentDetails = parseJson(current.details_json);
  const details = JSON.stringify({
    ...currentDetails,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.links === undefined ? {} : { links: input.links }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  });
  const guard = versionGuard(
    context.env.DB,
    "ideas",
    ideaId,
    actor.workspaceId,
    undefined,
    expected,
  );
  const now = Date.now();
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        "UPDATE ideas SET title = ?1, type = ?2, source = ?3, status = ?4, summary = ?5, details_json = ?6, updated_at = ?7, version = version + 1 WHERE id = ?8 AND workspace_id = ?9",
      ).bind(
        input.title ?? current.title,
        input.type ?? current.type,
        input.source === undefined ? current.source : input.source || null,
        input.status ?? current.status,
        input.summary === undefined ? current.summary : input.summary || null,
        details,
        now,
        ideaId,
        actor.workspaceId,
      ),
      context.env.DB.prepare(
        "UPDATE object_registry SET title = ?1, version = version + 1, updated_at = ?2 WHERE workspace_id = ?3 AND domain_table = 'ideas' AND domain_id = ?4",
      ).bind(input.title ?? current.title, now, actor.workspaceId, ideaId),
      context.env.DB.prepare(
        "INSERT INTO idea_history (id, workspace_id, idea_id, actor_user_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'updated', ?5, ?6)",
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        ideaId,
        actor.userId,
        JSON.stringify({ fields: Object.keys(input) }),
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        ...(current.project_id ? { projectId: current.project_id } : {}),
        actor,
        action: "idea.updated",
        objectType: "idea",
        objectId: ideaId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { fields: Object.keys(input) },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(409, "version_conflict", "The idea changed in another session.", {
        expectedVersion: expected,
        current: ideaView(await requireIdea(context.env.DB, actor.workspaceId, ideaId)),
      });
    throw error;
  }
  return ok(context, ideaView(await requireIdea(context.env.DB, actor.workspaceId, ideaId)));
});

ideaRoutes.use("/:ideaId/archive", requireJson);
ideaRoutes.use("/:ideaId/restore", requireJson);
for (const action of ["archive", "restore"] as const) {
  ideaRoutes.post(`/:ideaId/${action}`, async (context) => {
    const actor = context.get("actor");
    const ideaId = requiredParam(context.req.param("ideaId"));
    const expected = parseIfMatch(context.req.header("If-Match"));
    const current = await requireIdea(context.env.DB, actor.workspaceId, ideaId);
    if ((action === "archive") === (current.archived_at !== null))
      throw new HttpError(
        409,
        "lifecycle_conflict",
        `The idea is already ${action === "archive" ? "archived" : "active"}.`,
      );
    const guard = versionGuard(
      context.env.DB,
      "ideas",
      ideaId,
      actor.workspaceId,
      undefined,
      expected,
    );
    const now = Date.now();
    try {
      await context.env.DB.batch([
        guard.insert,
        context.env.DB.prepare(
          "UPDATE ideas SET archived_at = ?1, updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4",
        ).bind(action === "archive" ? now : null, now, ideaId, actor.workspaceId),
        context.env.DB.prepare(
          "UPDATE object_registry SET archived_at = ?1, updated_at = ?2, version = version + 1 WHERE workspace_id = ?3 AND domain_table = 'ideas' AND domain_id = ?4",
        ).bind(action === "archive" ? now : null, now, actor.workspaceId, ideaId),
        context.env.DB.prepare(
          "INSERT INTO idea_history (id, workspace_id, idea_id, actor_user_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6)",
        ).bind(
          createUuidV7(),
          actor.workspaceId,
          ideaId,
          actor.userId,
          action === "archive" ? "archived" : "restored",
          now,
        ),
        auditStatement(context.env.DB, {
          workspaceId: actor.workspaceId,
          ...(current.project_id ? { projectId: current.project_id } : {}),
          actor,
          action: `idea.${action}d`,
          objectType: "idea",
          objectId: ideaId,
          requestId: context.get("requestId"),
          occurredAt: now,
        }),
        guard.remove,
      ]);
    } catch (error) {
      if (isConstraintError(error))
        throw new HttpError(409, "version_conflict", "The idea changed in another session.", {
          expectedVersion: expected,
        });
      throw error;
    }
    return ok(context, ideaView(await requireIdea(context.env.DB, actor.workspaceId, ideaId)));
  });
}

ideaRoutes.use("/:ideaId/promote", requireJson);
ideaRoutes.post("/:ideaId/promote", async (context) => {
  const actor = context.get("actor");
  assertAllowed(actor, "project.create");
  const ideaId = requiredParam(context.req.param("ideaId"));
  const input = promoteSchema.parse(await context.req.json());
  const idea = await requireIdea(context.env.DB, actor.workspaceId, ideaId);
  const expected = parseIfMatch(context.req.header("If-Match"));
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: "idea.promote",
    key: context.req.header("Idempotency-Key"),
    requestBody: { ideaId, ...input },
  });
  if (lease.replayRef)
    return ok(context, {
      projectId: lease.replayRef,
      idea: ideaView(await requireIdea(context.env.DB, actor.workspaceId, ideaId)),
    });
  if (idea.project_id || idea.promoted_at) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw new HttpError(
      409,
      "idea_already_promoted",
      "This idea is already connected to a project.",
      { projectId: idea.project_id },
    );
  }

  const projectId = createUuidV7();
  const screenplayId = createUuidV7();
  const draftId = createUuidV7();
  const now = Date.now();
  const code = input.code.toUpperCase();
  const guard = versionGuard(
    context.env.DB,
    "ideas",
    ideaId,
    actor.workspaceId,
    undefined,
    expected,
  );
  const workspaceUsers = await context.env.DB.prepare(
    "SELECT id FROM user_identities WHERE workspace_id = ?1 AND status = 'active' ORDER BY id",
  )
    .bind(actor.workspaceId)
    .all<{ id: string }>();
  const statements: D1PreparedStatement[] = [
    guard.insert,
    context.env.DB.prepare(
      "INSERT INTO projects (id, workspace_id, code, title, working_title, type, phase, status, company, owner_user_id, logline, aspect_ratio, frame_rate_numerator, frame_rate_denominator, drop_frame, timezone, locale, currency, unit_system, paper_size, enabled_modules_json, readiness_state, readiness_score, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'idea', 'active', 'Sinbod Wayne', ?6, ?7, '16:9', 24, 1, 0, 'Europe/Amsterdam', 'en-GB', 'EUR', 'metric', 'A4', '[]', 'blocked', 0, 1, NULL, ?8, ?8)",
    ).bind(
      projectId,
      actor.workspaceId,
      code,
      idea.title,
      input.type,
      actor.userId,
      idea.summary,
      now,
    ),
    context.env.DB.prepare(
      "INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, 'project', 'projects', ?3, ?4, 1, NULL, ?5, ?5)",
    ).bind(createUuidV7(), actor.workspaceId, projectId, idea.title, now),
    context.env.DB.prepare(
      "INSERT INTO screenplays (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, current_draft_id, current_revision_id, approved_revision_id, numbering_locked, frame_rate_numerator, frame_rate_denominator, paper_size, details_json, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'draft', NULL, ?5, 'a0', ?6, NULL, NULL, 0, 24, 1, 'A4', '{}', 1, NULL, ?7, ?7)",
    ).bind(
      screenplayId,
      actor.workspaceId,
      projectId,
      `${idea.title} Screenplay`,
      actor.userId,
      draftId,
      now,
    ),
    context.env.DB.prepare(
      "INSERT INTO script_drafts (id, workspace_id, project_id, screenplay_id, title, autosave_state, base_revision_id, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'Working Draft', 'saved', NULL, 1, ?5, ?5)",
    ).bind(draftId, actor.workspaceId, projectId, screenplayId, now),
    context.env.DB.prepare(
      "INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, 'screenplay', 'screenplays', ?4, ?5, 1, NULL, ?6, ?6)",
    ).bind(
      createUuidV7(),
      actor.workspaceId,
      projectId,
      screenplayId,
      `${idea.title} Screenplay`,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE ideas SET project_id = ?1, status = 'promoted', promoted_at = ?2, updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4",
    ).bind(projectId, now, ideaId, actor.workspaceId),
    context.env.DB.prepare(
      "UPDATE object_registry SET project_id = ?1, version = version + 1, updated_at = ?2 WHERE workspace_id = ?3 AND domain_table = 'ideas' AND domain_id = ?4",
    ).bind(projectId, now, actor.workspaceId, ideaId),
    context.env.DB.prepare(
      "INSERT INTO idea_history (id, workspace_id, idea_id, actor_user_id, event_type, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, 'promoted', ?5, ?6)",
    ).bind(
      createUuidV7(),
      actor.workspaceId,
      ideaId,
      actor.userId,
      JSON.stringify({ projectId, code, type: input.type }),
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "idea.promoted",
      objectType: "idea",
      objectId: ideaId,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { projectId, code },
    }),
    completeIdempotentOperation(context.env.DB, lease.id, projectId, 201),
    guard.remove,
  ];
  for (const member of workspaceUsers.results)
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO project_memberships (id, workspace_id, project_id, user_id, role, status, version, created_at, updated_at, archived_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', 1, ?6, ?6, NULL)",
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        member.id,
        member.id === actor.userId ? "owner" : "producer",
        now,
      ),
    );
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
  let previousRank: string | undefined;
  for (const [title, logicalCode] of folders) {
    const rank = rankBetween(previousRank, undefined);
    previousRank = rank;
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO folders (id, workspace_id, project_id, parent_folder_id, title, logical_code, sort_rank, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 1, NULL, ?7, ?7)",
      ).bind(createUuidV7(), actor.workspaceId, projectId, title, logicalCode, rank, now),
    );
  }
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    if (isConstraintError(error))
      throw new HttpError(
        409,
        "promotion_conflict",
        "The idea or project code changed before promotion could finish.",
      );
    throw error;
  }
  return ok(
    context,
    { projectId, idea: ideaView(await requireIdea(context.env.DB, actor.workspaceId, ideaId)) },
    201,
  );
});

async function requireIdea(db: D1Database, workspaceId: string, ideaId: string): Promise<IdeaRow> {
  const row = await db
    .prepare(
      "SELECT id, project_id, title, type, source, status, summary, details_json, promoted_at, version, archived_at, created_at, updated_at FROM ideas WHERE id = ?1 AND workspace_id = ?2 LIMIT 1",
    )
    .bind(ideaId, workspaceId)
    .first<IdeaRow>();
  if (!row) throw new HttpError(404, "idea_not_found", "The idea was not found.");
  return row;
}

function ideaView(row: IdeaRow) {
  const details = parseJson(row.details_json);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    type: row.type ?? "short_film",
    source: row.source,
    status: row.status,
    summary: row.summary,
    notes: typeof details.notes === "string" ? details.notes : "",
    links: stringArray(details.links),
    tags: stringArray(details.tags),
    promotedAt: row.promoted_at,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
function requiredParam(value: string | undefined): string {
  if (!value) throw new HttpError(404, "route_not_found", "A required route parameter is missing.");
  return value;
}
function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL|UNIQUE/iu.test(error.message);
}
