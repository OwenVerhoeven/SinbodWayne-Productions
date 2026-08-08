import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";

export const appRoutes = new Hono<AppEnv>();
appRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

appRoutes.get("/notifications", async (context) => {
  const actor = context.get("actor");
  const limit = z.coerce.number().int().min(1).max(100).catch(50).parse(context.req.query("limit"));
  const [items, count] = await Promise.all([
    context.env.DB.prepare(
      `SELECT id, title, COALESCE(body, '') AS body, created_at, read_at
         FROM notifications
        WHERE workspace_id = ?1 AND recipient_user_id = ?2 AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ?3`,
    )
      .bind(actor.workspaceId, actor.userId, limit)
      .all<{
        id: string;
        title: string;
        body: string;
        created_at: number;
        read_at: number | null;
      }>(),
    context.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM notifications
        WHERE workspace_id = ?1 AND recipient_user_id = ?2 AND read_at IS NULL AND archived_at IS NULL`,
    )
      .bind(actor.workspaceId, actor.userId)
      .first<{ count: number }>(),
  ]);
  return ok(context, {
    items: items.results.map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      createdAt: item.created_at,
      readAt: item.read_at,
    })),
    unread: count?.count ?? 0,
  });
});

appRoutes.use("/notifications/read", requireJson);
appRoutes.post("/notifications/read", async (context) => {
  const actor = context.get("actor");
  const now = Date.now();
  const result = await context.env.DB.prepare(
    `UPDATE notifications SET read_at = ?1
      WHERE workspace_id = ?2 AND recipient_user_id = ?3 AND read_at IS NULL AND archived_at IS NULL`,
  )
    .bind(now, actor.workspaceId, actor.userId)
    .run();
  return ok(context, { updated: result.meta.changes });
});

appRoutes.get("/search", async (context) => {
  const actor = context.get("actor");
  const query = z
    .object({
      q: z.string().trim().min(2).max(160),
      projectId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).catch(20),
    })
    .parse(context.req.query());
  if (query.projectId) await assertProjectAccess(context.env.DB, actor, query.projectId);
  const search = `%${query.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await context.env.DB.prepare(
    `SELECT o.domain_id, o.object_type, COALESCE(o.title, o.object_type) AS title, o.project_id, p.code
       FROM object_registry o
       LEFT JOIN projects p ON p.id = o.project_id AND p.workspace_id = o.workspace_id
       LEFT JOIN project_memberships pm ON pm.project_id = o.project_id AND pm.user_id = ?1 AND pm.status = 'active'
      WHERE o.workspace_id = ?2 AND o.archived_at IS NULL
        AND (o.project_id IS NULL OR pm.id IS NOT NULL)
        AND (?3 IS NULL OR o.project_id = ?3)
        AND COALESCE(o.title, '') LIKE ?4 ESCAPE '\\'
      ORDER BY o.updated_at DESC, o.id DESC LIMIT ?5`,
  )
    .bind(actor.userId, actor.workspaceId, query.projectId ?? null, search, query.limit)
    .all<{
      domain_id: string;
      object_type: string;
      title: string;
      project_id: string | null;
      code: string | null;
    }>();
  return ok(context, {
    items: rows.results.map((row) => ({
      id: row.domain_id,
      objectType: row.object_type,
      title: row.title,
      subtitle: row.code,
      href: searchHref(row.object_type, row.project_id, row.domain_id),
    })),
  });
});

appRoutes.use("/sessions/:sessionId/revoke", requireJson);
appRoutes.post("/sessions/:sessionId/revoke", async (context) => {
  const actor = context.get("actor");
  const sessionId = context.req.param("sessionId");
  if (!sessionId) throw new HttpError(404, "not_found", "The session was not found.");
  if (sessionId === actor.sessionId)
    throw new HttpError(409, "current_session", "Use sign out to end the current session.");
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?1, revoked_by_user_id = ?2, revoke_reason = 'user_request' WHERE id = ?3 AND user_id = ?2 AND workspace_id = ?4 AND revoked_at IS NULL",
    ).bind(now, actor.userId, sessionId, actor.workspaceId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      actor,
      action: "auth.session_revoked",
      objectType: "session",
      objectId: sessionId,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(context, { revoked: true as const });
});

appRoutes.get("/projects/:projectId/collaboration", async (context) => {
  const actor = context.get("actor");
  const projectId = context.req.param("projectId");
  if (!projectId) throw new HttpError(404, "not_found", "The project was not found.");
  await assertProjectAccess(context.env.DB, actor, projectId);
  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(422, "websocket_required", "This route requires a WebSocket upgrade.");
  const id = context.env.PROJECT_COLLABORATION.idFromName(`${actor.workspaceId}:${projectId}`);
  const stub = context.env.PROJECT_COLLABORATION.get(id);
  const headers = new Headers(context.req.raw.headers);
  headers.set("X-SWP-Workspace-ID", actor.workspaceId);
  headers.set("X-SWP-Project-ID", projectId);
  headers.set("X-SWP-Actor-ID", actor.userId);
  headers.delete("Cookie");
  return stub.fetch(new Request(context.req.raw, { headers }));
});

function searchHref(objectType: string, projectId: string | null, objectId: string): string {
  if (!projectId) return "/projects";
  const moduleKey: Readonly<Record<string, string>> = {
    project: "overview",
    idea: "ideas",
    project_brief: "briefs",
    development_document: "development-docs",
    screenplay: "screenplay",
    scene: "scene-breakdown",
    scene_breakdown: "scene-breakdown",
    element: "elements",
    person: "people",
    casting_role: "casting",
    location: "locations",
    board: "boards",
    storyboard: "storyboards",
    shot: "shots",
    shot_list: "shots",
    budget: "budget",
    requirement: "legal-safety",
    equipment_item: "equipment",
    task_card: "tasks",
    calendar_event: "calendar",
    schedule: "schedules",
    shoot_day: "shoot-days",
    call_sheet_draft: "call-sheets",
    production_pack_draft: "production-packs",
    file: "files",
    export_snapshot: "exports-archive",
  };
  return `/projects/${encodeURIComponent(projectId)}/${moduleKey[objectType] ?? "overview"}?object=${encodeURIComponent(objectId)}`;
}
