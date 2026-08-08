import { createUuidV7, safeRelativeArchivePath } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { archiveManifestDigest } from "../archive/manifest";
import type { ArchiveManifestItemContract } from "../archive/types";
import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { hexToArrayBuffer, safeDisplayName } from "../files/policy";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  sha256,
} from "../idempotency";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv, ApplicationBindings } from "../http/types";
import { PRIVATE_OBJECT_MAX_BYTES, type PrivateObjectStore } from "../storage/private-object-store";

const EXPORT_SCHEMA_VERSION = "1.0";
const MAX_EXPORT_BYTES = PRIVATE_OBJECT_MAX_BYTES;
const TABLE_PAGE_SIZE = 1_000;

const requestSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    fileVersionScope: z.enum(["current", "all"]).default("all"),
  })
  .strict();

interface ProjectRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly code: string;
  readonly series_id: string | null;
  readonly season_id: string | null;
}

interface FileVersionRow {
  readonly logical_file_id: string;
  readonly file_version_id: string;
  readonly version_number: number;
  readonly safe_display_name: string;
  readonly object_key: string;
  readonly byte_size: number;
  readonly mime_type: string;
  readonly sha256: string;
  readonly folder_title: string | null;
  readonly folder_code: string | null;
}

interface ArchiveJobRow {
  readonly id: string;
  readonly export_snapshot_id: string;
  readonly status: "requested" | "running" | "verifying" | "verified" | "failed";
  readonly attempt_count: number;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
  readonly last_error_retryable: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly verified_at: number | null;
  readonly title: string;
  readonly manifest_hash: string | null;
}

interface ExportItem {
  readonly id: string;
  readonly logicalFileId: string | null;
  readonly fileVersionId: string | null;
  readonly sourceRevisionId: string | null;
  readonly relativePath: string;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
}

const EXCLUDED_PROJECT_TABLES = new Set([
  "archive_acknowledgements",
  "archive_attempts",
  "archive_jobs",
  "archive_leases",
  "archive_manifest_items",
  "export_manifest_items",
  "export_snapshot_objects",
  "export_snapshots",
  "idempotency_records",
  "public_share_sessions",
  "rate_limit_counters",
  "service_credentials",
  "sessions",
  "share_links",
  "upload_parts",
  "upload_sessions",
  "version_guards",
]);

export const projectArchiveRoutes = new Hono<AppEnv>();
projectArchiveRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

projectArchiveRoutes.get("/jobs", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const rows = await context.env.DB.prepare(
    `SELECT aj.id, aj.export_snapshot_id, aj.status, aj.attempt_count,
              aj.last_error_code, aj.last_error_message, aj.last_error_retryable,
              aj.created_at, aj.updated_at, aj.verified_at,
              es.title, es.manifest_hash
         FROM archive_jobs aj
         JOIN export_snapshots es ON es.id = aj.export_snapshot_id
        WHERE aj.workspace_id = ?1 AND aj.project_id = ?2
        ORDER BY aj.created_at DESC, aj.id DESC
        LIMIT 100`,
  )
    .bind(actor.workspaceId, projectId)
    .all<ArchiveJobRow>();
  return ok(context, { items: rows.results.map(jobView) });
});

projectArchiveRoutes.use("/jobs", requireJson);
projectArchiveRoutes.post("/jobs", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = requestSchema.parse(await context.req.json());
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: `project.archive.request:${projectId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef) {
    return ok(
      context,
      jobView(await requireJob(context.env.DB, actor.workspaceId, projectId, lease.replayRef)),
    );
  }

  const project = await context.env.DB.prepare(
    "SELECT id, workspace_id, title, code, series_id, season_id FROM projects WHERE id = ?1 AND workspace_id = ?2 LIMIT 1",
  )
    .bind(projectId, actor.workspaceId)
    .first<ProjectRow>();
  if (!project) throw new HttpError(404, "not_found", "The requested project was not found.");

  const now = Date.now();
  const snapshotId = createUuidV7(() => now);
  const jobId = createUuidV7(() => now + 1);
  const exportPrefix = `private/${keyPart(actor.workspaceId)}/${keyPart(projectId)}/exports/${keyPart(snapshotId)}`;
  try {
    await context.env.DB.prepare(
      `INSERT INTO export_snapshots
          (id, workspace_id, project_id, snapshot_type, schema_version, state, title, summary,
           manifest_object_key, manifest_hash, body_object_key, content_hash,
           requested_by_user_id, idempotency_key, created_at, completed_at)
         VALUES (?1, ?2, ?3, 'full_project', ?4, 'building', ?5, ?6,
                 NULL, NULL, NULL, NULL, ?7, ?8, ?9, NULL)`,
    )
      .bind(
        snapshotId,
        actor.workspaceId,
        projectId,
        EXPORT_SCHEMA_VERSION,
        input.title ?? `${project.title} complete pre-production export`,
        "Immutable complete-project JSON and pinned file-version manifest for outbound NAS archival.",
        actor.userId,
        context.req.header("Idempotency-Key") ?? null,
        now,
      )
      .run();

    const data = await buildProjectData(context.env.DB, project, now);
    const dataJson = canonicalJson(data);
    const dataBytes = new TextEncoder().encode(`${dataJson}\n`);
    if (dataBytes.byteLength > MAX_EXPORT_BYTES) {
      throw new HttpError(
        413,
        "export_too_large",
        "The structured project export exceeds the current safe Worker limit.",
      );
    }
    const dataHash = await sha256(dataBytes.buffer);
    const projectRoot = safeRelativeArchivePath(
      `${archiveSlug(project.code)}-${archiveSlug(project.title)}`,
    );
    const generated = await generatedItems({
      bucket: context.env.FILES,
      prefix: exportPrefix,
      project,
      projectRoot,
      snapshotId,
      createdAt: now,
      dataBytes,
      dataHash,
    });
    const fileItems = await loadFileItems(
      context.env.DB,
      actor.workspaceId,
      projectId,
      projectRoot,
      input.fileVersionScope,
    );
    const allItems = [...generated.beforeManifest, ...fileItems];
    const projectManifest = await createProjectManifest({
      bucket: context.env.FILES,
      prefix: exportPrefix,
      project,
      projectRoot,
      snapshotId,
      createdAt: now,
      items: allItems,
    });
    const checksumItem = await createChecksumItem({
      bucket: context.env.FILES,
      prefix: exportPrefix,
      projectRoot,
      items: [...allItems, projectManifest],
    });
    const items = [...allItems, projectManifest, checksumItem].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, "en-GB"),
    );
    const manifestHash = await archiveManifestDigest({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      projectId,
      exportSnapshotId: snapshotId,
      items: items.map(contractItem),
    });

    await insertManifestItems(context.env.DB, snapshotId, items, now);
    await insertSnapshotObjects(context.env.DB, snapshotId, data.tables, now);
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE export_snapshots
              SET state = 'complete', manifest_object_key = ?1, manifest_hash = ?2,
                  body_object_key = ?3, content_hash = ?4, completed_at = ?5
            WHERE id = ?6 AND workspace_id = ?7 AND project_id = ?8 AND state = 'building'`,
      ).bind(
        projectManifest.objectKey,
        manifestHash,
        generated.dataObjectKey,
        dataHash,
        now,
        snapshotId,
        actor.workspaceId,
        projectId,
      ),
      context.env.DB.prepare(
        `INSERT INTO archive_jobs
            (id, workspace_id, project_id, export_snapshot_id, status, attempt_count,
             last_error_code, last_error_message, last_error_retryable,
             requested_by_user_id, idempotency_key, created_at, updated_at, verified_at)
           VALUES (?1, ?2, ?3, ?4, 'requested', 0, NULL, NULL, NULL, ?5, ?6, ?7, ?7, NULL)`,
      ).bind(
        jobId,
        actor.workspaceId,
        projectId,
        snapshotId,
        actor.userId,
        context.req.header("Idempotency-Key"),
        now,
      ),
      context.env.DB.prepare(
        `INSERT INTO archive_manifest_items
            (id, workspace_id, project_id, archive_job_id, logical_file_id, file_version_id,
             source_revision_id, relative_path, object_key, byte_size, mime_type, sha256,
             sort_rank, state, created_at)
           SELECT id, ?1, ?2, ?3, logical_file_id, file_version_id, source_revision_id,
                  relative_path, object_key, byte_size, mime_type, sha256, sort_rank, 'pending', ?4
             FROM export_manifest_items WHERE export_snapshot_id = ?5`,
      ).bind(actor.workspaceId, projectId, jobId, now, snapshotId),
      completeIdempotentOperation(context.env.DB, lease.id, jobId, 201),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "archive.requested",
        objectType: "archive_job",
        objectId: jobId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: {
          snapshotId,
          manifestHash,
          itemCount: items.length,
          fileVersionScope: input.fileVersionScope,
        },
      }),
    ]);

    context.executionCtx.waitUntil(
      startArchiveWorkflow(context.env, jobId, context.env.DB, actor.workspaceId, projectId),
    );
    return ok(
      context,
      jobView(await requireJob(context.env.DB, actor.workspaceId, projectId, jobId)),
      201,
    );
  } catch (error) {
    await Promise.allSettled([
      failIdempotentOperation(context.env.DB, lease.id),
      context.env.DB.prepare(
        "UPDATE export_snapshots SET state = 'failed', completed_at = ?1 WHERE id = ?2 AND state = 'building'",
      )
        .bind(Date.now(), snapshotId)
        .run(),
    ]);
    throw error;
  }
});

projectArchiveRoutes.get("/snapshots/:snapshotId/body", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  const snapshotId = requiredParam(context.req.param("snapshotId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const snapshot = await requireSnapshot(context.env.DB, actor.workspaceId, projectId, snapshotId);
  if (!snapshot.body_object_key)
    throw new HttpError(409, "snapshot_incomplete", "The export body is not complete.");
  return streamExportObject(
    context.env.FILES,
    snapshot.body_object_key,
    `${snapshotId}-project-data.json`,
    "application/json",
  );
});

projectArchiveRoutes.get("/snapshots/:snapshotId/manifest", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  const snapshotId = requiredParam(context.req.param("snapshotId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const snapshot = await requireSnapshot(context.env.DB, actor.workspaceId, projectId, snapshotId);
  if (!snapshot.manifest_object_key)
    throw new HttpError(409, "snapshot_incomplete", "The export manifest is not complete.");
  return streamExportObject(
    context.env.FILES,
    snapshot.manifest_object_key,
    `${snapshotId}-project-manifest.json`,
    "application/json",
  );
});

async function startArchiveWorkflow(
  env: ApplicationBindings,
  jobId: string,
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  try {
    await env.ARCHIVE_WORKFLOW.create({ id: `archive-${jobId}`, params: { archiveJobId: jobId } });
  } catch {
    await db
      .prepare(
        `UPDATE archive_jobs
            SET last_error_code = 'WORKFLOW_START_FAILED',
                last_error_message = 'Durable workflow start failed; the prepared job remains available to the outbound archive agent.',
                last_error_retryable = 1, updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4 AND status = 'requested'`,
      )
      .bind(Date.now(), jobId, workspaceId, projectId)
      .run();
  }
}

async function buildProjectData(db: D1Database, project: ProjectRow, capturedAt: number) {
  const schemaTables = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string }>();
  const tableNames: string[] = [];
  for (const row of schemaTables.results) {
    if (!safeIdentifier(row.name) || EXCLUDED_PROJECT_TABLES.has(row.name)) continue;
    const columns = await tableColumns(db, row.name);
    if (columns.includes("project_id")) tableNames.push(row.name);
  }

  const tables: Record<string, readonly Record<string, unknown>[]> = {};
  for (const tableName of tableNames) {
    tables[tableName] = await loadTableRows(db, tableName, project.workspace_id, project.id);
  }
  const contextRows = await loadProjectContext(db, project);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    product: "Sinbod Wayne Productions",
    boundary: "pre-production-through-ready-to-shoot",
    capturedAt,
    projectId: project.id,
    workspaceId: project.workspace_id,
    project: contextRows.project,
    context: contextRows.context,
    tables,
  } as const;
}

async function loadProjectContext(db: D1Database, project: ProjectRow) {
  const projectRow = await db
    .prepare("SELECT * FROM projects WHERE id = ?1 AND workspace_id = ?2")
    .bind(project.id, project.workspace_id)
    .first<Record<string, unknown>>();
  const ideas = await db
    .prepare(
      "SELECT * FROM ideas WHERE workspace_id = ?1 AND promoted_project_id = ?2 ORDER BY created_at, id",
    )
    .bind(project.workspace_id, project.id)
    .all<Record<string, unknown>>();
  const series = project.series_id
    ? await db
        .prepare("SELECT * FROM series WHERE id = ?1 AND workspace_id = ?2")
        .bind(project.series_id, project.workspace_id)
        .first<Record<string, unknown>>()
    : null;
  const season = project.season_id
    ? await db
        .prepare("SELECT * FROM seasons WHERE id = ?1 AND workspace_id = ?2")
        .bind(project.season_id, project.workspace_id)
        .first<Record<string, unknown>>()
    : null;
  return { project: projectRow ?? {}, context: { ideas: sortRows(ideas.results), series, season } };
}

async function loadTableRows(
  db: D1Database,
  tableName: string,
  workspaceId: string,
  projectId: string,
) {
  const columns = await tableColumns(db, tableName);
  const workspaceClause = columns.includes("workspace_id") ? " AND workspace_id = ?2" : "";
  const orderColumns = columns.includes("id") ? ["id"] : columns.slice(0, 3);
  const order =
    orderColumns.length > 0 ? ` ORDER BY ${orderColumns.map(quotedIdentifier).join(", ")}` : "";
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += TABLE_PAGE_SIZE) {
    const statement = db.prepare(
      `SELECT * FROM ${quotedIdentifier(tableName)} WHERE project_id = ?1${workspaceClause}${order} LIMIT ${TABLE_PAGE_SIZE} OFFSET ${offset}`,
    );
    const page = workspaceClause
      ? await statement.bind(projectId, workspaceId).all<Record<string, unknown>>()
      : await statement.bind(projectId).all<Record<string, unknown>>();
    rows.push(...page.results);
    if (page.results.length < TABLE_PAGE_SIZE) break;
  }
  return sortRows(rows);
}

async function tableColumns(db: D1Database, tableName: string): Promise<string[]> {
  if (!safeIdentifier(tableName)) return [];
  const result = await db
    .prepare(`PRAGMA table_info(${quotedIdentifier(tableName)})`)
    .all<{ name: string }>();
  return result.results.map((row) => row.name).filter(safeIdentifier);
}

async function generatedItems(input: {
  bucket: PrivateObjectStore;
  prefix: string;
  project: ProjectRow;
  projectRoot: string;
  snapshotId: string;
  createdAt: number;
  dataBytes: Uint8Array;
  dataHash: string;
}) {
  const dataObjectKey = `${input.prefix}/project-data.json`;
  const schemaObjectKey = `${input.prefix}/schema-version.txt`;
  const schemaBytes = new TextEncoder().encode(`${EXPORT_SCHEMA_VERSION}\n`);
  const schemaHash = await sha256(schemaBytes.buffer);
  await Promise.all([
    putGenerated(input.bucket, dataObjectKey, input.dataBytes, "application/json", input.dataHash),
    putGenerated(
      input.bucket,
      schemaObjectKey,
      schemaBytes,
      "text/plain; charset=utf-8",
      schemaHash,
    ),
  ]);
  return {
    dataObjectKey,
    beforeManifest: [
      exportItem({
        relativePath: `${input.projectRoot}/11-data-exports/project-data.json`,
        objectKey: dataObjectKey,
        bytes: input.dataBytes,
        mimeType: "application/json",
        digest: input.dataHash,
      }),
      exportItem({
        relativePath: `${input.projectRoot}/manifest/schema-version.txt`,
        objectKey: schemaObjectKey,
        bytes: schemaBytes,
        mimeType: "text/plain; charset=utf-8",
        digest: schemaHash,
      }),
    ],
  };
}

async function createProjectManifest(input: {
  bucket: PrivateObjectStore;
  prefix: string;
  project: ProjectRow;
  projectRoot: string;
  snapshotId: string;
  createdAt: number;
  items: readonly ExportItem[];
}): Promise<ExportItem> {
  const content = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    product: "Sinbod Wayne Productions",
    snapshotId: input.snapshotId,
    project: { id: input.project.id, code: input.project.code, title: input.project.title },
    createdAt: input.createdAt,
    items: input.items.map((item) => ({
      id: item.id,
      relativePath: item.relativePath,
      byteSize: item.byteSize,
      mimeType: item.mimeType,
      sha256: item.sha256,
      logicalFileId: item.logicalFileId,
      fileVersionId: item.fileVersionId,
      sourceRevisionId: item.sourceRevisionId,
    })),
  };
  const bytes = new TextEncoder().encode(`${canonicalJson(content)}\n`);
  const digest = await sha256(bytes.buffer);
  const objectKey = `${input.prefix}/project-manifest.json`;
  await putGenerated(input.bucket, objectKey, bytes, "application/json", digest);
  return exportItem({
    relativePath: `${input.projectRoot}/manifest/project-manifest.json`,
    objectKey,
    bytes,
    mimeType: "application/json",
    digest,
  });
}

async function createChecksumItem(input: {
  bucket: PrivateObjectStore;
  prefix: string;
  projectRoot: string;
  items: readonly ExportItem[];
}): Promise<ExportItem> {
  const body = `${[...input.items]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en-GB"))
    .map((item) => `${item.sha256}  ${item.relativePath}`)
    .join("\n")}\n`;
  const bytes = new TextEncoder().encode(body);
  const digest = await sha256(bytes.buffer);
  const objectKey = `${input.prefix}/checksums.sha256`;
  await putGenerated(input.bucket, objectKey, bytes, "text/plain; charset=utf-8", digest);
  return exportItem({
    relativePath: `${input.projectRoot}/manifest/checksums.sha256`,
    objectKey,
    bytes,
    mimeType: "text/plain; charset=utf-8",
    digest,
  });
}

async function putGenerated(
  bucket: PrivateObjectStore,
  key: string,
  bytes: Uint8Array,
  mimeType: string,
  digest: string,
) {
  await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: mimeType, cacheControl: "private, no-store" },
    customMetadata: { sha256: digest, immutable: "true", product: "sinbod-wayne-productions" },
    sha256: hexToArrayBuffer(digest),
  });
}

async function loadFileItems(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  projectRoot: string,
  scope: "current" | "all",
): Promise<ExportItem[]> {
  const currentClause = scope === "current" ? "AND fv.id = f.current_version_id" : "";
  const rows = await db
    .prepare(
      `SELECT f.id AS logical_file_id, fv.id AS file_version_id, fv.version_number,
              fv.safe_display_name, fv.object_key, fv.byte_size, fv.mime_type, fv.sha256,
              fo.title AS folder_title, fo.logical_code AS folder_code
         FROM file_versions fv
         JOIN files f ON f.id = fv.file_id AND f.workspace_id = fv.workspace_id AND f.project_id = fv.project_id
         LEFT JOIN folders fo ON fo.id = f.folder_id AND fo.project_id = f.project_id
        WHERE fv.workspace_id = ?1 AND fv.project_id = ?2 AND f.status <> 'cloud_removed'
          ${currentClause}
        ORDER BY COALESCE(fo.sort_rank, ''), f.sort_rank, f.id, fv.version_number`,
    )
    .bind(workspaceId, projectId)
    .all<FileVersionRow>();
  return rows.results.map((row) => {
    const folder = archiveFolder(row.folder_code ?? row.folder_title);
    const name = versionedArchiveName(
      row.safe_display_name,
      row.file_version_id,
      row.version_number,
    );
    return {
      id: createUuidV7(),
      logicalFileId: row.logical_file_id,
      fileVersionId: row.file_version_id,
      sourceRevisionId: null,
      relativePath: safeRelativeArchivePath(`${projectRoot}/${folder}/${name}`),
      objectKey: row.object_key,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      sha256: row.sha256,
    };
  });
}

async function insertManifestItems(
  db: D1Database,
  snapshotId: string,
  items: readonly ExportItem[],
  createdAt: number,
) {
  for (let offset = 0; offset < items.length; offset += 50) {
    await db.batch(
      items.slice(offset, offset + 50).map((item, index) =>
        db
          .prepare(
            `INSERT INTO export_manifest_items
              (id, export_snapshot_id, logical_file_id, file_version_id, source_revision_id,
               relative_path, object_key, byte_size, mime_type, sha256, sort_rank, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(
            item.id,
            snapshotId,
            item.logicalFileId,
            item.fileVersionId,
            item.sourceRevisionId,
            item.relativePath,
            item.objectKey,
            item.byteSize,
            item.mimeType,
            item.sha256,
            String(offset + index).padStart(10, "0"),
            createdAt,
          ),
      ),
    );
  }
}

async function insertSnapshotObjects(
  db: D1Database,
  snapshotId: string,
  tables: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  createdAt: number,
) {
  const registry = tables.object_registry ?? [];
  const statements = await Promise.all(
    registry.map(async (row) => {
      const objectId = typeof row.id === "string" ? row.id : null;
      const domainTable = typeof row.domain_table === "string" ? row.domain_table : "";
      const domainId = typeof row.domain_id === "string" ? row.domain_id : "";
      if (!objectId) return null;
      const source = tables[domainTable]?.find((item) => item.id === domainId) ?? row;
      return db
        .prepare(
          `INSERT OR IGNORE INTO export_snapshot_objects
            (id, export_snapshot_id, object_id, revision_or_version_id, source_hash, created_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5)`,
        )
        .bind(createUuidV7(), snapshotId, objectId, await sha256(canonicalJson(source)), createdAt);
    }),
  );
  const filtered = statements.filter(
    (statement): statement is D1PreparedStatement => statement !== null,
  );
  for (let offset = 0; offset < filtered.length; offset += 50)
    await db.batch(filtered.slice(offset, offset + 50));
}

function exportItem(input: {
  relativePath: string;
  objectKey: string;
  bytes: Uint8Array;
  mimeType: string;
  digest: string;
}): ExportItem {
  return {
    id: createUuidV7(),
    logicalFileId: null,
    fileVersionId: null,
    sourceRevisionId: null,
    relativePath: safeRelativeArchivePath(input.relativePath),
    objectKey: input.objectKey,
    byteSize: input.bytes.byteLength,
    mimeType: input.mimeType,
    sha256: input.digest,
  };
}

function contractItem(item: ExportItem): ArchiveManifestItemContract {
  return {
    id: item.id,
    relativePath: item.relativePath,
    byteSize: item.byteSize,
    mimeType: item.mimeType,
    sha256: item.sha256,
    ...(item.logicalFileId ? { logicalFileId: item.logicalFileId } : {}),
    ...(item.fileVersionId ? { fileVersionId: item.fileVersionId } : {}),
    ...(item.sourceRevisionId ? { sourceRevisionIds: [item.sourceRevisionId] } : {}),
  };
}

function archiveFolder(value: string | null): string {
  const prefix = value?.match(/^(?:0[0-9]|1[01])/u)?.[0];
  return ARCHIVE_FOLDERS[prefix as keyof typeof ARCHIVE_FOLDERS] ?? "11-data-exports";
}

const ARCHIVE_FOLDERS = {
  "00": "00-project-development",
  "01": "01-story-writing",
  "02": "02-breakdown",
  "03": "03-visual-planning",
  "04": "04-cast-crew",
  "05": "05-locations",
  "06": "06-budget",
  "07": "07-legal-safety",
  "08": "08-equipment-logistics",
  "09": "09-schedule",
  "10": "10-call-sheets-production-packs",
  "11": "11-data-exports",
} as const;

function versionedArchiveName(value: string, id: string, version: number): string {
  const safe = safeDisplayName(value);
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  return `${base.slice(0, 150)}--${keyPart(id).slice(0, 12)}-v${version}${extension.slice(0, 32)}`;
}

function archiveSlug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^A-Za-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "project"
  );
}

function keyPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 128);
}
function safeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value);
}
function quotedIdentifier(value: string): string {
  if (!safeIdentifier(value))
    throw new HttpError(500, "unsafe_schema", "The database schema contains an unsafe identifier.");
  return `"${value}"`;
}
function requiredParam(value: string | undefined): string {
  if (!value)
    throw new HttpError(404, "route_not_found", "The requested route parameter is missing.");
  return value;
}
function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function sortRows(rows: readonly Record<string, unknown>[]) {
  return [...rows].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right), "en-GB"),
  );
}

async function requireJob(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  jobId: string,
): Promise<ArchiveJobRow> {
  const row = await db
    .prepare(
      `SELECT aj.id, aj.export_snapshot_id, aj.status, aj.attempt_count, aj.last_error_code, aj.last_error_message, aj.last_error_retryable, aj.created_at, aj.updated_at, aj.verified_at, es.title, es.manifest_hash FROM archive_jobs aj JOIN export_snapshots es ON es.id = aj.export_snapshot_id WHERE aj.id = ?1 AND aj.workspace_id = ?2 AND aj.project_id = ?3 LIMIT 1`,
    )
    .bind(jobId, workspaceId, projectId)
    .first<ArchiveJobRow>();
  if (!row) throw new HttpError(404, "not_found", "The archive job was not found.");
  return row;
}

async function requireSnapshot(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  snapshotId: string,
) {
  const row = await db
    .prepare(
      "SELECT body_object_key, manifest_object_key FROM export_snapshots WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND state = 'complete' LIMIT 1",
    )
    .bind(snapshotId, workspaceId, projectId)
    .first<{ body_object_key: string | null; manifest_object_key: string | null }>();
  if (!row) throw new HttpError(404, "not_found", "The completed export snapshot was not found.");
  return row;
}

async function streamExportObject(
  bucket: PrivateObjectStore,
  objectKey: string,
  fileName: string,
  fallbackType: string,
) {
  const object = await bucket.get(objectKey);
  if (!object)
    throw new HttpError(
      409,
      "export_object_missing",
      "The immutable export object is missing from private storage.",
    );
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? fallbackType,
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${safeDisplayName(fileName)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jobView(row: ArchiveJobRow) {
  return {
    id: row.id,
    snapshotId: row.export_snapshot_id,
    title: row.title,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    retryable: row.last_error_retryable === 1,
    manifestHash: row.manifest_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at,
  };
}
