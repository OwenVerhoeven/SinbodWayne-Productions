import { createUuidV7, rankBetween } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import { getRecordTable } from "../records/catalog";
import { parseIfMatch, versionGuard } from "../records/version";

const createSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    status: z
      .string()
      .trim()
      .min(1)
      .max(48)
      .regex(/^[a-z][a-z0-9_]*$/u),
    summary: z.string().trim().max(4_000).catch(""),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const patchSchema = createSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required.");
const listSchema = z.object({
  q: z.string().max(240).catch(""),
  state: z.enum(["active", "archived", "all"]).catch("active"),
  status: z.string().max(48).optional(),
  cursor: z
    .string()
    .regex(/^\d+:[0-9a-f-]+$/u)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).catch(50),
});

interface RecordRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly owner_display_name: string | null;
  readonly sort_rank: string;
  readonly details_json: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly version: number;
  readonly archived_at: number | null;
}

export const recordRoutes = new Hono<AppEnv>();
recordRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

recordRoutes.get("/:recordType", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const definition = requireDefinition(
    requiredParam(context.req.param("recordType"), "recordType"),
  );
  const query = listSchema.parse(context.req.query());
  await assertProjectAccess(context.env.DB, actor, projectId);
  const search = `%${escapeLike(query.q)}%`;
  const archiveClause =
    query.state === "active"
      ? "AND r.archived_at IS NULL"
      : query.state === "archived"
        ? "AND r.archived_at IS NOT NULL"
        : "";
  const result = await context.env.DB.prepare(
    `SELECT r.id, r.title, r.status, r.summary, u.display_name AS owner_display_name,
            r.sort_rank, r.details_json, r.created_at, r.updated_at, r.version, r.archived_at
       FROM ${definition.table} r
       LEFT JOIN user_identities u ON u.id = r.owner_user_id AND u.workspace_id = r.workspace_id
      WHERE r.workspace_id = ?1 AND r.project_id = ?2
        AND (?3 = '' OR r.title LIKE ?4 ESCAPE '\\' OR COALESCE(r.summary, '') LIKE ?4 ESCAPE '\\')
        ${archiveClause}
        AND (?5 IS NULL OR (r.updated_at < CAST(substr(?5, 1, instr(?5, ':') - 1) AS INTEGER) OR (r.updated_at = CAST(substr(?5, 1, instr(?5, ':') - 1) AS INTEGER) AND r.id < substr(?5, instr(?5, ':') + 1))))
        AND (?7 IS NULL OR r.status = ?7)
      ORDER BY r.updated_at DESC, r.id DESC
      LIMIT ?6`,
  )
    .bind(
      actor.workspaceId,
      projectId,
      query.q,
      search,
      query.cursor ?? null,
      query.limit + 1,
      query.status ?? null,
    )
    .all<RecordRow>();
  const rows = result.results;
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit).map((row) => recordView(row, definition.objectType));
  const last = items.at(-1);
  return ok(context, {
    items,
    nextCursor: hasMore && last ? `${last.updatedAt}:${last.id}` : null,
    total: await recordCount(
      context.env.DB,
      definition.table,
      actor.workspaceId,
      projectId,
      query.state,
      query.q,
      query.status,
    ),
  });
});

recordRoutes.get("/:recordType/export.csv", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const definition = requireDefinition(
    requiredParam(context.req.param("recordType"), "recordType"),
  );
  const query = listSchema.pick({ state: true, status: true }).parse(context.req.query());
  await assertProjectAccess(context.env.DB, actor, projectId);
  const archiveClause =
    query.state === "active"
      ? "AND r.archived_at IS NULL"
      : query.state === "archived"
        ? "AND r.archived_at IS NOT NULL"
        : "";
  const result = await context.env.DB.prepare(
    `SELECT r.id, r.title, r.status, r.summary, u.display_name AS owner_display_name, r.sort_rank, r.details_json, r.created_at, r.updated_at, r.version, r.archived_at
       FROM ${definition.table} r LEFT JOIN user_identities u ON u.id = r.owner_user_id
      WHERE r.workspace_id = ?1 AND r.project_id = ?2 ${archiveClause} AND (?3 IS NULL OR r.status = ?3)
      ORDER BY r.sort_rank, r.id LIMIT 10000`,
  )
    .bind(actor.workspaceId, projectId, query.status ?? null)
    .all<RecordRow>();
  const detailKeys = [
    ...new Set(result.results.flatMap((row) => Object.keys(parseDetails(row.details_json)))),
  ]
    .sort()
    .slice(0, 100);
  const lines = [
    [
      "ID",
      "Title",
      "Status",
      "Summary",
      "Owner",
      "Updated UTC",
      "Archived UTC",
      ...detailKeys.map((key) => `Detail: ${key}`),
    ],
    ...result.results.map((row) => {
      const details = parseDetails(row.details_json);
      return [
        row.id,
        row.title,
        row.status,
        row.summary ?? "",
        row.owner_display_name ?? "",
        new Date(row.updated_at).toISOString(),
        row.archived_at ? new Date(row.archived_at).toISOString() : "",
        ...detailKeys.map((key) => csvDetail(details[key])),
      ];
    }),
  ];
  const csv = lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
  return new Response(`\uFEFF${csv}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${definition.objectType.replaceAll("_", "-")}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

recordRoutes.use("/:recordType", requireJson);
recordRoutes.post("/:recordType", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const definition = requireDefinition(
    requiredParam(context.req.param("recordType"), "recordType"),
  );
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = createSchema.parse(await context.req.json());
  const details = boundedDetails(input.details ?? {});
  const last = await context.env.DB.prepare(
    `SELECT sort_rank FROM ${definition.table} WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1`,
  )
    .bind(actor.workspaceId, projectId)
    .first<{ sort_rank: string }>();
  const id = createUuidV7();
  const now = Date.now();
  const rank = rankBetween(last?.sort_rank, undefined);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO ${definition.table}
        (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank, details_json, created_by, created_at, updated_at, version, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7, ?10, ?10, 1, NULL)`,
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      input.title,
      input.status,
      input.summary || null,
      actor.userId,
      rank,
      details,
      now,
    ),
    context.env.DB.prepare(
      "INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, ?8)",
    ).bind(
      createUuidV7(),
      actor.workspaceId,
      projectId,
      definition.objectType,
      definition.table,
      id,
      input.title,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: `${definition.objectType}.created`,
      objectType: definition.objectType,
      objectId: id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  return ok(
    context,
    recordView(
      await requireRecord(
        context.env.DB,
        definition.table,
        definition.objectType,
        actor.workspaceId,
        projectId,
        id,
      ),
      definition.objectType,
    ),
    201,
  );
});

recordRoutes.use("/:recordType/:recordId", requireJson);
recordRoutes.patch("/:recordType/:recordId", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const recordId = requiredParam(context.req.param("recordId"), "recordId");
  const definition = requireDefinition(
    requiredParam(context.req.param("recordType"), "recordType"),
  );
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = patchSchema.parse(await context.req.json());
  const current = await requireRecord(
    context.env.DB,
    definition.table,
    definition.objectType,
    actor.workspaceId,
    projectId,
    recordId,
  );
  const guard = versionGuard(
    context.env.DB,
    definition.table,
    recordId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  const details = input.details ? boundedDetails(input.details) : current.details_json;
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        `UPDATE ${definition.table}
            SET title = ?1, status = ?2, summary = ?3, details_json = ?4, updated_at = ?5, version = version + 1
          WHERE id = ?6 AND workspace_id = ?7 AND project_id = ?8`,
      ).bind(
        input.title ?? current.title,
        input.status ?? current.status,
        input.summary === undefined ? current.summary : input.summary || null,
        details,
        now,
        recordId,
        actor.workspaceId,
        projectId,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: `${definition.objectType}.updated`,
        objectType: definition.objectType,
        objectId: recordId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { fields: Object.keys(input) },
      }),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw await recordConflict(
        context.env.DB,
        definition.table,
        definition.objectType,
        actor.workspaceId,
        projectId,
        recordId,
        expected,
      );
    throw error;
  }
  return ok(
    context,
    recordView(
      await requireRecord(
        context.env.DB,
        definition.table,
        definition.objectType,
        actor.workspaceId,
        projectId,
        recordId,
      ),
      definition.objectType,
    ),
  );
});

for (const action of ["archive", "restore"] as const) {
  recordRoutes.post(`/:recordType/:recordId/${action}`, async (context) => {
    const actor = context.get("actor");
    const projectId = requiredParam(context.req.param("projectId"), "projectId");
    const recordId = requiredParam(context.req.param("recordId"), "recordId");
    const definition = requireDefinition(
      requiredParam(context.req.param("recordType"), "recordType"),
    );
    await assertProjectAccess(context.env.DB, actor, projectId, "edit");
    const expected = parseIfMatch(context.req.header("If-Match"));
    const guard = versionGuard(
      context.env.DB,
      definition.table,
      recordId,
      actor.workspaceId,
      projectId,
      expected,
    );
    const now = Date.now();
    try {
      await context.env.DB.batch([
        guard.insert,
        context.env.DB.prepare(
          `UPDATE ${definition.table} SET archived_at = ?1, updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5`,
        ).bind(action === "archive" ? now : null, now, recordId, actor.workspaceId, projectId),
        auditStatement(context.env.DB, {
          workspaceId: actor.workspaceId,
          projectId,
          actor,
          action: `${definition.objectType}.${action}d`,
          objectType: definition.objectType,
          objectId: recordId,
          requestId: context.get("requestId"),
          occurredAt: now,
        }),
        guard.remove,
      ]);
    } catch (error) {
      if (isConstraintError(error))
        throw await recordConflict(
          context.env.DB,
          definition.table,
          definition.objectType,
          actor.workspaceId,
          projectId,
          recordId,
          expected,
        );
      throw error;
    }
    return ok(context, { changed: true as const });
  });
}

function requireDefinition(recordType: string) {
  const definition = getRecordTable(recordType);
  if (!definition)
    throw new HttpError(
      404,
      "record_type_not_found",
      "The requested record type is not available.",
    );
  return definition;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(404, "route_not_found", `Missing route parameter: ${name}.`);
  return value;
}

async function requireRecord(
  db: D1Database,
  table: string,
  objectType: string,
  workspaceId: string,
  projectId: string,
  recordId: string,
): Promise<RecordRow> {
  const row = await db
    .prepare(
      `SELECT r.id, r.title, r.status, r.summary, u.display_name AS owner_display_name, r.sort_rank, r.details_json, r.created_at, r.updated_at, r.version, r.archived_at FROM ${table} r LEFT JOIN user_identities u ON u.id = r.owner_user_id WHERE r.id = ?1 AND r.workspace_id = ?2 AND r.project_id = ?3 LIMIT 1`,
    )
    .bind(recordId, workspaceId, projectId)
    .first<RecordRow>();
  if (!row)
    throw new HttpError(
      404,
      "not_found",
      `The requested ${objectType.replaceAll("_", " ")} was not found.`,
    );
  return row;
}

function recordView(row: RecordRow, recordType: string) {
  return {
    id: row.id,
    recordType,
    title: row.title,
    status: row.status,
    summary: row.summary,
    ownerDisplayName: row.owner_display_name,
    sortRank: row.sort_rank,
    details: parseDetails(row.details_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    archivedAt: row.archived_at,
  };
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function boundedDetails(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 32_768)
    throw new HttpError(422, "details_too_large", "Structured details exceed the allowed size.");
  return encoded;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function recordCount(
  db: D1Database,
  table: string,
  workspaceId: string,
  projectId: string,
  state: "active" | "archived" | "all",
  query: string,
  status?: string,
): Promise<number> {
  const archiveClause =
    state === "active"
      ? "AND archived_at IS NULL"
      : state === "archived"
        ? "AND archived_at IS NOT NULL"
        : "";
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?1 AND project_id = ?2 ${archiveClause} AND (?3 = '' OR title LIKE ?4 ESCAPE '\\' OR COALESCE(summary, '') LIKE ?4 ESCAPE '\\') AND (?5 IS NULL OR status = ?5)`,
    )
    .bind(workspaceId, projectId, query, `%${escapeLike(query)}%`, status ?? null)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvDetail(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL/iu.test(error.message);
}

async function recordConflict(
  db: D1Database,
  table: string,
  objectType: string,
  workspaceId: string,
  projectId: string,
  recordId: string,
  expectedVersion: number,
): Promise<HttpError> {
  let current: ReturnType<typeof recordView> | null = null;
  try {
    current = recordView(
      await requireRecord(db, table, objectType, workspaceId, projectId, recordId),
      objectType,
    );
  } catch {
    // A concurrent delete is represented by the initial null value.
  }
  return new HttpError(409, "version_conflict", "This record was changed in another session.", {
    expectedVersion,
    current,
  });
}
