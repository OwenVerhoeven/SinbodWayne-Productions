import { createUuidV7, rankBetween } from "@swp/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertAllowed, assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import {
  arrayBufferToHex,
  assertFileSignature,
  assertStoredObject,
  assertUploadIntent,
  contentDisposition,
  hexToArrayBuffer,
  normaliseMimeType,
  originalFileName,
  safeDisplayName,
  type UploadIntent,
} from "../files/policy";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  sha256,
} from "../idempotency";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { ActorContext, AppEnv } from "../http/types";
import { parseIfMatch, versionGuard } from "../records/version";
import {
  PRIVATE_OBJECT_MAX_BYTES,
  PRIVATE_OBJECT_TOTAL_BUDGET_BYTES,
} from "../storage/private-object-store";

const authorizeSchema = z
  .object({
    fileId: z.string().min(1).max(128).optional(),
    folderId: z.string().min(1).max(128).nullable().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    name: z.string().trim().min(1).max(500),
    mimeType: z.string().trim().min(1).max(160),
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mode: z.enum(["auto", "single", "multipart"]).default("auto"),
    provenance: z.string().trim().max(500).optional(),
    retentionClass: z.string().trim().max(80).optional(),
  })
  .strict();

const retentionSchema = z.object({ confirmation: z.string().max(500) }).strict();
const fileLinkSchema = z
  .object({
    objectId: z.string().min(1).max(128),
    purpose: z.string().trim().min(1).max(80),
    pinnedFileVersionId: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

interface UploadSessionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly file_id: string | null;
  readonly object_key: string;
  readonly intended_name: string;
  readonly intended_mime_type: string;
  readonly intended_byte_size: number;
  readonly intended_sha256: string;
  readonly allowed_types_json: string;
  readonly upload_mode: "single" | "multipart";
  readonly multipart_upload_id: string | null;
  readonly state:
    "authorized" | "uploading" | "verifying" | "complete" | "failed" | "expired" | "aborted";
  readonly created_by_user_id: string;
  readonly expires_at: number;
  readonly completed_file_version_id: string | null;
  readonly error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface FileRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly folder_id: string | null;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly safe_display_name: string;
  readonly current_version_id: string | null;
  readonly provenance: string | null;
  readonly retention_class: string | null;
  readonly retention_review_at: number | null;
  readonly version: number;
  readonly archived_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface FileVersionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly file_id: string;
  readonly version_number: number;
  readonly original_name: string;
  readonly safe_display_name: string;
  readonly object_key: string;
  readonly byte_size: number;
  readonly mime_type: string;
  readonly sha256: string;
  readonly uploader_user_id: string;
  readonly provenance: string | null;
  readonly scan_state: "pending" | "clean" | "quarantined" | "failed" | "not_configured";
  readonly retention_class: string | null;
  readonly created_at: number;
}

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

fileRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const state = z
    .enum(["active", "archived", "all"])
    .catch("active")
    .parse(context.req.query("state"));
  const archiveClause =
    state === "active"
      ? "AND f.archived_at IS NULL"
      : state === "archived"
        ? "AND f.archived_at IS NOT NULL"
        : "";
  const rows = await context.env.DB.prepare(
    `SELECT f.id, f.workspace_id, f.project_id, f.folder_id, f.title, f.status, f.summary,
              f.safe_display_name, f.current_version_id, f.provenance, f.retention_class,
              f.retention_review_at, f.version, f.archived_at, f.created_at, f.updated_at,
              fv.version_number, fv.byte_size, fv.mime_type, fv.sha256, fv.scan_state
         FROM files f
         LEFT JOIN file_versions fv ON fv.id = f.current_version_id AND fv.file_id = f.id
        WHERE f.workspace_id = ?1 AND f.project_id = ?2 ${archiveClause}
        ORDER BY f.updated_at DESC, f.id DESC LIMIT 200`,
  )
    .bind(actor.workspaceId, projectId)
    .all<FileRow & Partial<FileVersionRow>>();
  return ok(context, { items: rows.results.map(fileListView) });
});

fileRoutes.post("/uploads/authorize", requireJson, async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = authorizeSchema.parse(await context.req.json());
  if (input.mode === "multipart") {
    throw new HttpError(
      422,
      "multipart_not_available",
      "The no-subscription storage profile supports single uploads up to 25 MiB.",
    );
  }
  const mode = "single" as const;
  const intent = {
    byteSize: input.byteSize,
    mimeType: normaliseMimeType(input.mimeType),
    sha256: input.sha256,
    mode,
  } satisfies UploadIntent;
  assertUploadIntent(
    intent,
    Math.min(
      positiveInteger(context.env.UPLOAD_MAX_BYTES, PRIVATE_OBJECT_MAX_BYTES),
      PRIVATE_OBJECT_MAX_BYTES,
    ),
  );
  if (input.fileId) await requireFile(context.env.DB, actor, projectId, input.fileId, false);
  if (input.folderId) await requireFolder(context.env.DB, actor, projectId, input.folderId);

  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: "file.upload.authorize",
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef) {
    return ok(
      context,
      uploadAuthorizationView(
        await requireUploadSession(context.env.DB, actor, projectId, lease.replayRef),
      ),
    );
  }

  const id = createUuidV7();
  const objectKey = `private/${opaqueKeyPart(actor.workspaceId)}/${opaqueKeyPart(projectId)}/uploads/${opaqueKeyPart(id)}`;
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000;
  try {
    await assertStorageBudget(
      context.env.DB,
      actor.workspaceId,
      intent.byteSize,
      positiveInteger(
        context.env.FILE_STORAGE_TOTAL_BUDGET_BYTES,
        PRIVATE_OBJECT_TOTAL_BUDGET_BYTES,
      ),
    );
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO upload_sessions
            (id, workspace_id, project_id, file_id, object_key, intended_name, intended_mime_type,
             intended_byte_size, intended_sha256, allowed_types_json, upload_mode, multipart_upload_id,
             state, created_by_user_id, expires_at, completed_file_version_id, error_code, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'authorized', ?13, ?14, NULL, NULL, ?15, ?15)`,
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        input.fileId ?? null,
        objectKey,
        originalFileName(input.name),
        intent.mimeType,
        intent.byteSize,
        intent.sha256,
        JSON.stringify({
          allowedTypes: [intent.mimeType],
          folderId: input.folderId ?? null,
          title: input.title ?? null,
          provenance: input.provenance ?? null,
          retentionClass: input.retentionClass ?? null,
        }),
        mode,
        null,
        actor.userId,
        expiresAt,
        now,
      ),
      completeIdempotentOperation(context.env.DB, lease.id, id, 201),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "file.upload_authorized",
        objectType: "upload_session",
        objectId: id,
        requestId: context.get("requestId"),
        details: {
          mode,
          byteSize: intent.byteSize,
          mimeType: intent.mimeType,
          fileId: input.fileId ?? null,
        },
        occurredAt: now,
      }),
    ]);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
  return ok(
    context,
    uploadAuthorizationView(await requireUploadSession(context.env.DB, actor, projectId, id)),
    201,
  );
});

fileRoutes.put("/uploads/:uploadSessionId/content", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const sessionId = requiredParam(context.req.param("uploadSessionId"), "uploadSessionId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const session = await requireUploadSession(context.env.DB, actor, projectId, sessionId);
  if (session.completed_file_version_id)
    return ok(context, await completedUploadView(context.env.DB, session));
  assertUploadSessionWritable(session, actor, "single");
  assertUploadBodyHeaders(context.req.raw, session, session.intended_byte_size);
  if (!context.req.raw.body)
    throw new HttpError(422, "upload_body_required", "The upload body is required.");

  const existing = await context.env.FILES.head(session.object_key);
  if (!existing) {
    const claimedAt = Date.now();
    const claim = await context.env.DB.prepare(
      `UPDATE upload_sessions SET state = 'uploading', error_code = NULL, updated_at = ?1
        WHERE id = ?2 AND completed_file_version_id IS NULL
          AND (state = 'authorized' OR (state = 'uploading' AND updated_at < ?3))`,
    )
      .bind(claimedAt, session.id, claimedAt - 60_000)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) {
      throw new HttpError(
        409,
        "upload_in_progress",
        "This upload is already being processed. Retry after the current request finishes.",
      );
    }
    try {
      await context.env.FILES.put(session.object_key, context.req.raw.body, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: session.intended_mime_type,
          cacheControl: "private, no-store",
        },
        customMetadata: uploadMetadata(
          session.id,
          actor.workspaceId,
          projectId,
          session.intended_sha256,
        ),
        sha256: hexToArrayBuffer(session.intended_sha256),
      });
    } catch {
      await context.env.DB.prepare(
        `UPDATE upload_sessions SET state = 'authorized', error_code = 'checksum_or_storage_failure',
                  updated_at = ?1
          WHERE id = ?2 AND completed_file_version_id IS NULL AND state = 'uploading'`,
      )
        .bind(Date.now(), session.id)
        .run();
      throw new HttpError(
        409,
        "upload_integrity_failed",
        "Private storage rejected the upload or its checksum.",
      );
    }
  }
  const refreshed = await requireUploadSession(context.env.DB, actor, projectId, session.id);
  return ok(context, await verifyAndFinalize(context, actor, refreshed));
});

fileRoutes.put("/uploads/:uploadSessionId/parts/:partNumber", () => {
  throw new HttpError(
    409,
    "multipart_not_available",
    "Multipart uploads are unavailable in the no-subscription storage profile.",
  );
});

fileRoutes.post("/uploads/:uploadSessionId/complete", requireJson, () => {
  throw new HttpError(
    409,
    "multipart_not_available",
    "Multipart uploads are unavailable in the no-subscription storage profile.",
  );
});

fileRoutes.post("/uploads/:uploadSessionId/abort", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const sessionId = requiredParam(context.req.param("uploadSessionId"), "uploadSessionId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const session = await requireUploadSession(context.env.DB, actor, projectId, sessionId);
  if (session.created_by_user_id !== actor.userId)
    throw new HttpError(404, "not_found", "The upload session was not found.");
  if (session.completed_file_version_id)
    throw new HttpError(
      409,
      "upload_already_complete",
      "A completed immutable file version cannot be aborted.",
    );
  await context.env.FILES.delete(session.object_key);
  await context.env.DB.prepare(
    "UPDATE upload_sessions SET state = 'aborted', updated_at = ?1 WHERE id = ?2 AND completed_file_version_id IS NULL",
  )
    .bind(Date.now(), session.id)
    .run();
  return ok(context, { aborted: true as const });
});

fileRoutes.get("/:fileId", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const file = await requireFile(context.env.DB, actor, projectId, fileId, true);
  const versions = await context.env.DB.prepare(
    `SELECT id, workspace_id, project_id, file_id, version_number, original_name, safe_display_name,
              object_key, byte_size, mime_type, sha256, uploader_user_id, provenance, scan_state,
              retention_class, created_at
         FROM file_versions WHERE workspace_id = ?1 AND project_id = ?2 AND file_id = ?3
        ORDER BY version_number DESC`,
  )
    .bind(actor.workspaceId, projectId, fileId)
    .all<FileVersionRow>();
  return ok(context, { file: fileView(file), versions: versions.results.map(versionView) });
});

fileRoutes.get("/:fileId/links", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  await requireFile(context.env.DB, actor, projectId, fileId, true);
  const links = await context.env.DB.prepare(
    `SELECT fl.id, fl.object_id, fl.purpose, fl.pinned_file_version_id, fl.sort_rank,
              fl.archived_at, fl.created_at, o.object_type, o.title
         FROM file_links fl
         JOIN object_registry o ON o.id = fl.object_id AND o.workspace_id = fl.workspace_id
        WHERE fl.workspace_id = ?1 AND fl.project_id = ?2 AND fl.file_id = ?3
        ORDER BY fl.archived_at IS NOT NULL, fl.sort_rank, fl.id`,
  )
    .bind(actor.workspaceId, projectId, fileId)
    .all<{
      id: string;
      object_id: string;
      purpose: string;
      pinned_file_version_id: string | null;
      sort_rank: string;
      archived_at: number | null;
      created_at: number;
      object_type: string;
      title: string | null;
    }>();
  return ok(context, {
    items: links.results.map((link) => ({
      id: link.id,
      objectId: link.object_id,
      objectType: link.object_type,
      objectTitle: link.title,
      purpose: link.purpose,
      pinnedFileVersionId: link.pinned_file_version_id,
      sortRank: link.sort_rank,
      archivedAt: link.archived_at,
      createdAt: link.created_at,
    })),
  });
});

fileRoutes.post("/:fileId/links", requireJson, async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = fileLinkSchema.parse(await context.req.json());
  const file = await requireFile(context.env.DB, actor, projectId, fileId, false);
  const target = await context.env.DB.prepare(
    "SELECT id FROM object_registry WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
  )
    .bind(input.objectId, actor.workspaceId, projectId)
    .first<{ id: string }>();
  if (!target) throw new HttpError(404, "not_found", "The link target was not found.");
  if (input.pinnedFileVersionId) {
    await requireFileVersion(
      context.env.DB,
      actor.workspaceId,
      projectId,
      file.id,
      input.pinnedFileVersionId,
    );
  }
  const id = createUuidV7();
  const now = Date.now();
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM file_links WHERE workspace_id = ?1 AND project_id = ?2 AND object_id = ?3 ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(actor.workspaceId, projectId, target.id)
    .first<{ sort_rank: string }>();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO file_links
            (id, workspace_id, project_id, file_id, object_id, purpose, pinned_file_version_id,
             sort_rank, created_by_user_id, archived_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)`,
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        file.id,
        target.id,
        input.purpose,
        input.pinnedFileVersionId ?? null,
        rankBetween(last?.sort_rank, undefined),
        actor.userId,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "file.link_created",
        objectType: "file",
        objectId: file.id,
        requestId: context.get("requestId"),
        details: {
          fileLinkId: id,
          targetObjectId: target.id,
          purpose: input.purpose,
          pinnedFileVersionId: input.pinnedFileVersionId ?? null,
        },
        occurredAt: now,
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE|constraint/iu.test(error.message)) {
      throw new HttpError(409, "file_link_exists", "This file link already exists.");
    }
    throw error;
  }
  return ok(
    context,
    {
      id,
      objectId: target.id,
      purpose: input.purpose,
      pinnedFileVersionId: input.pinnedFileVersionId ?? null,
      createdAt: now,
    },
    201,
  );
});

fileRoutes.get("/:fileId/versions/:versionId/download", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  const versionId = requiredParam(context.req.param("versionId"), "versionId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const file = await requireFile(context.env.DB, actor, projectId, fileId, true);
  if (file.status === "cloud_removed") {
    throw new HttpError(404, "not_found", "The private file body is no longer available.");
  }
  const version = await requireFileVersion(
    context.env.DB,
    actor.workspaceId,
    projectId,
    fileId,
    versionId,
  );
  assertDownloadable(version);
  const object = await context.env.FILES.get(version.object_key);
  if (!object || object.size !== version.byte_size) {
    throw new HttpError(
      503,
      "file_storage_unavailable",
      "The private file body is unavailable or failed its size check.",
    );
  }
  const headers = privateDownloadHeaders(version);
  return new Response(object.body, { headers });
});

fileRoutes.post("/:fileId/versions/:versionId/make-current", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  const versionId = requiredParam(context.req.param("versionId"), "versionId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const file = await requireFile(context.env.DB, actor, projectId, fileId, false);
  await requireFileVersion(context.env.DB, actor.workspaceId, projectId, fileId, versionId);
  const expected = parseIfMatch(context.req.header("If-Match"));
  const guard = versionGuard(
    context.env.DB,
    "files",
    file.id,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  await guardedFileBatch(context, file, expected, [
    guard.insert,
    context.env.DB.prepare(
      "UPDATE files SET current_version_id = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
    ).bind(versionId, now, file.id, actor.workspaceId, projectId),
    context.env.DB.prepare(
      "UPDATE object_registry SET version = version + 1, updated_at = ?1 WHERE workspace_id = ?2 AND project_id = ?3 AND domain_table = 'files' AND domain_id = ?4",
    ).bind(now, actor.workspaceId, projectId, file.id),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "file.current_version_changed",
      objectType: "file",
      objectId: file.id,
      requestId: context.get("requestId"),
      details: { fileVersionId: versionId },
      occurredAt: now,
    }),
    guard.remove,
  ]);
  return ok(context, fileView(await requireFile(context.env.DB, actor, projectId, file.id, true)));
});

for (const action of ["archive", "restore"] as const) {
  fileRoutes.post(`/:fileId/${action}`, async (context) => {
    const actor = context.get("actor");
    const projectId = requiredParam(context.req.param("projectId"), "projectId");
    const fileId = requiredParam(context.req.param("fileId"), "fileId");
    await assertProjectAccess(context.env.DB, actor, projectId, "edit");
    const file = await requireFile(context.env.DB, actor, projectId, fileId, true);
    const expected = parseIfMatch(context.req.header("If-Match"));
    const guard = versionGuard(
      context.env.DB,
      "files",
      file.id,
      actor.workspaceId,
      projectId,
      expected,
    );
    const now = Date.now();
    await guardedFileBatch(context, file, expected, [
      guard.insert,
      context.env.DB.prepare(
        "UPDATE files SET archived_at = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5",
      ).bind(action === "archive" ? now : null, now, file.id, actor.workspaceId, projectId),
      context.env.DB.prepare(
        "UPDATE object_registry SET archived_at = ?1, version = version + 1, updated_at = ?2 WHERE workspace_id = ?3 AND project_id = ?4 AND domain_table = 'files' AND domain_id = ?5",
      ).bind(action === "archive" ? now : null, now, actor.workspaceId, projectId, file.id),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: `file.${action}d`,
        objectType: "file",
        objectId: file.id,
        requestId: context.get("requestId"),
        occurredAt: now,
      }),
      guard.remove,
    ]);
    return ok(
      context,
      fileView(await requireFile(context.env.DB, actor, projectId, file.id, true)),
    );
  });
}

fileRoutes.post("/:fileId/remove-cloud-copy", requireJson, async (context) => {
  const actor = context.get("actor");
  assertAllowed(actor, "archive.remove_cloud_copy");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const fileId = requiredParam(context.req.param("fileId"), "fileId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = retentionSchema.parse(await context.req.json());
  const file = await requireFile(context.env.DB, actor, projectId, fileId, true);
  if (file.archived_at === null)
    throw new HttpError(
      409,
      "archive_required",
      "Archive the logical file before removing its cloud body.",
    );
  if (input.confirmation !== `DELETE ${file.safe_display_name}`) {
    throw new HttpError(
      422,
      "typed_confirmation_mismatch",
      "The typed confirmation did not match the requested file.",
    );
  }
  const now = Date.now();
  if (file.retention_review_at === null || file.retention_review_at > now) {
    throw new HttpError(
      409,
      "retention_denied",
      "The file is not eligible under the active retention policy.",
    );
  }
  await assertNoActiveLegalHold(context.env.DB, actor.workspaceId, projectId, file.id);
  const verifiedArchive = await findVerifiedArchive(
    context.env.DB,
    actor.workspaceId,
    projectId,
    file.id,
  );
  if (!verifiedArchive) {
    throw new HttpError(
      409,
      "verified_archive_required",
      "Every immutable version must exist in one verified NAS archive before cloud removal.",
    );
  }
  const versions = await context.env.DB.prepare(
    "SELECT object_key FROM file_versions WHERE workspace_id = ?1 AND project_id = ?2 AND file_id = ?3 ORDER BY version_number",
  )
    .bind(actor.workspaceId, projectId, file.id)
    .all<{ object_key: string }>();
  if (versions.results.length === 0)
    throw new HttpError(
      409,
      "file_version_required",
      "The logical file has no immutable version to remove.",
    );
  const retentionId = createUuidV7();
  await context.env.DB.prepare(
    `INSERT INTO retention_actions
        (id, workspace_id, project_id, archive_job_id, action, typed_confirmation_hash,
         legal_hold_check_json, retention_check_json, actor_user_id, status, created_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, 'remove_cloud_copy', ?5, ?6, ?7, ?8, 'approved', ?9, NULL)`,
  )
    .bind(
      retentionId,
      actor.workspaceId,
      projectId,
      verifiedArchive,
      await sha256(input.confirmation),
      JSON.stringify({ checkedAt: now, active: false }),
      JSON.stringify({
        checkedAt: now,
        reviewAt: file.retention_review_at,
        allVersionsVerified: true,
      }),
      actor.userId,
      now,
    )
    .run();
  try {
    await assertNoActiveLegalHold(context.env.DB, actor.workspaceId, projectId, file.id);
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE files SET status = 'cloud_removed', version = version + 1, updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
      ).bind(Date.now(), file.id, actor.workspaceId, projectId),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "file.cloud_copy_access_revoked",
        objectType: "file",
        objectId: file.id,
        requestId: context.get("requestId"),
        details: {
          retentionActionId: retentionId,
          archiveJobId: verifiedArchive,
          versionCount: versions.results.length,
        },
      }),
    ]);
    await context.env.FILES.delete(versions.results.map((version) => version.object_key));
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE retention_actions SET status = 'completed', completed_at = ?1 WHERE id = ?2 AND status = 'approved'",
      ).bind(Date.now(), retentionId),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "file.cloud_copy_removed",
        objectType: "file",
        objectId: file.id,
        requestId: context.get("requestId"),
        details: { retentionActionId: retentionId, archiveJobId: verifiedArchive },
      }),
    ]);
  } catch (error) {
    await context.env.DB.prepare(
      "UPDATE retention_actions SET status = 'failed' WHERE id = ?1 AND status = 'approved'",
    )
      .bind(retentionId)
      .run();
    throw error;
  }
  return ok(context, { removed: true as const, retentionActionId: retentionId });
});

async function verifyAndFinalize(
  context: Context<AppEnv>,
  actor: ActorContext,
  session: UploadSessionRow,
  computedChecksum?: string,
) {
  if (session.completed_file_version_id) return completedUploadView(context.env.DB, session);
  const head = await context.env.FILES.head(session.object_key);
  if (!head)
    throw new HttpError(
      503,
      "upload_storage_propagating",
      "The uploaded object is still propagating through private storage. Retry this upload shortly.",
    );
  const storedChecksum =
    computedChecksum ??
    (head.checksums.sha256 ? arrayBufferToHex(head.checksums.sha256) : undefined);
  assertStoredObject(
    {
      byteSize: head.size,
      ...(head.httpMetadata?.contentType ? { contentType: head.httpMetadata.contentType } : {}),
      ...(storedChecksum ? { sha256: storedChecksum } : {}),
      ...(head.customMetadata?.uploadSessionId
        ? { uploadSessionId: head.customMetadata.uploadSessionId }
        : {}),
      ...(head.customMetadata?.workspaceId ? { workspaceId: head.customMetadata.workspaceId } : {}),
      ...(head.customMetadata?.projectId ? { projectId: head.customMetadata.projectId } : {}),
    },
    {
      byteSize: session.intended_byte_size,
      mimeType: session.intended_mime_type,
      sha256: session.intended_sha256,
      mode: session.upload_mode,
      uploadSessionId: session.id,
      workspaceId: session.workspace_id,
      projectId: session.project_id,
    },
  );
  if (!storedChecksum)
    throw new HttpError(
      409,
      "upload_checksum_unavailable",
      "The stored object did not provide checksum evidence.",
    );
  const sampleObject = await context.env.FILES.get(session.object_key, {
    range: { offset: 0, length: Math.min(head.size, 512) },
  });
  if (!sampleObject)
    throw new HttpError(
      409,
      "upload_object_missing",
      "The uploaded object was not found in private storage.",
    );
  assertFileSignature(session.intended_mime_type, await sampleObject.bytes());
  await context.env.DB.prepare(
    "UPDATE upload_sessions SET state = 'verifying', updated_at = ?1 WHERE id = ?2 AND state IN ('authorized', 'uploading')",
  )
    .bind(Date.now(), session.id)
    .run();
  return finalizeFileVersion(context, actor, session);
}

async function finalizeFileVersion(
  context: Context<AppEnv>,
  actor: ActorContext,
  session: UploadSessionRow,
) {
  const existingSession = await context.env.DB.prepare(
    "SELECT completed_file_version_id FROM upload_sessions WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3",
  )
    .bind(session.id, actor.workspaceId, session.project_id)
    .first<{ completed_file_version_id: string | null }>();
  if (existingSession?.completed_file_version_id) {
    return completedUploadView(context.env.DB, {
      ...session,
      completed_file_version_id: existingSession.completed_file_version_id,
    });
  }
  const existingFile = session.file_id
    ? await requireFile(context.env.DB, actor, session.project_id, session.file_id, false)
    : undefined;
  const fileId = existingFile?.id ?? createUuidV7();
  const versionId = createUuidV7();
  const versionNumber = existingFile
    ? ((
        await context.env.DB.prepare(
          "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM file_versions WHERE file_id = ?1",
        )
          .bind(fileId)
          .first<{ next: number }>()
      )?.next ?? 1)
    : 1;
  const now = Date.now();
  const registryId = createUuidV7();
  const safeName = safeDisplayName(session.intended_name);
  const options = parseUploadOptions(session.allowed_types_json);
  const title = options.title ?? safeName;
  const lastRank = !existingFile
    ? await context.env.DB.prepare(
        "SELECT sort_rank FROM files WHERE workspace_id = ?1 AND project_id = ?2 ORDER BY sort_rank DESC LIMIT 1",
      )
        .bind(actor.workspaceId, session.project_id)
        .first<{ sort_rank: string }>()
    : undefined;
  const statements: D1PreparedStatement[] = [];
  if (!existingFile) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO files
            (id, workspace_id, project_id, folder_id, title, status, summary, owner_user_id, sort_rank,
             safe_display_name, current_version_id, provenance, retention_class, retention_review_at,
             is_favorite, details_json, version, archived_at, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL, ?6, ?7, ?8, ?9, ?10, ?11, NULL, 0, '{}', 1, NULL, ?6, ?12, ?12)`,
      ).bind(
        fileId,
        actor.workspaceId,
        session.project_id,
        options.folderId,
        title,
        actor.userId,
        rankBetween(lastRank?.sort_rank, undefined),
        safeName,
        versionId,
        options.provenance,
        options.retentionClass,
        now,
      ),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO file_versions
          (id, workspace_id, project_id, file_id, version_number, original_name, safe_display_name,
           object_key, byte_size, mime_type, sha256, uploader_user_id, provenance, scan_state,
           scan_evidence_json, retention_class, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'not_configured', ?14, ?15, ?16)`,
    ).bind(
      versionId,
      actor.workspaceId,
      session.project_id,
      fileId,
      versionNumber,
      session.intended_name,
      safeName,
      session.object_key,
      session.intended_byte_size,
      session.intended_mime_type,
      session.intended_sha256,
      actor.userId,
      options.provenance,
      JSON.stringify({ provider: "not_configured", verifiedAt: now }),
      options.retentionClass,
      now,
    ),
  );
  if (existingFile) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE files SET current_version_id = ?1, safe_display_name = ?2, status = 'active',
                  version = version + 1, updated_at = ?3
            WHERE id = ?4 AND workspace_id = ?5 AND project_id = ?6`,
      ).bind(versionId, safeName, now, fileId, actor.workspaceId, session.project_id),
      context.env.DB.prepare(
        "UPDATE object_registry SET version = version + 1, updated_at = ?1 WHERE workspace_id = ?2 AND project_id = ?3 AND domain_table = 'files' AND domain_id = ?4",
      ).bind(now, actor.workspaceId, session.project_id, fileId),
    );
  } else {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO object_registry
            (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'file', 'files', ?4, ?5, 1, NULL, ?6, ?6)`,
      ).bind(registryId, actor.workspaceId, session.project_id, fileId, title, now),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `UPDATE upload_sessions SET state = 'complete', completed_file_version_id = ?1,
                error_code = NULL, updated_at = ?2
          WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5
            AND completed_file_version_id IS NULL AND state IN ('authorized', 'uploading', 'verifying')`,
    ).bind(versionId, now, session.id, actor.workspaceId, session.project_id),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId: session.project_id,
      actor,
      action: "file.version_created",
      objectType: "file",
      objectId: fileId,
      requestId: context.get("requestId"),
      details: { fileVersionId: versionId, versionNumber, scanState: "not_configured" },
      occurredAt: now,
    }),
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    const completed = await context.env.DB.prepare(
      "SELECT completed_file_version_id FROM upload_sessions WHERE id = ?1",
    )
      .bind(session.id)
      .first<{ completed_file_version_id: string | null }>();
    if (!completed?.completed_file_version_id) throw error;
  }
  return completedUploadView(
    context.env.DB,
    await requireUploadSession(context.env.DB, actor, session.project_id, session.id),
  );
}

async function requireUploadSession(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  id: string,
): Promise<UploadSessionRow> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, project_id, file_id, object_key, intended_name, intended_mime_type,
              intended_byte_size, intended_sha256, allowed_types_json, upload_mode, multipart_upload_id, state,
              created_by_user_id, expires_at, completed_file_version_id, error_code, created_at, updated_at
         FROM upload_sessions WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
    )
    .bind(id, actor.workspaceId, projectId)
    .first<UploadSessionRow>();
  if (!row) throw new HttpError(404, "not_found", "The upload session was not found.");
  return row;
}

function assertUploadSessionWritable(
  session: UploadSessionRow,
  actor: ActorContext,
  mode: UploadSessionRow["upload_mode"],
): void {
  if (session.created_by_user_id !== actor.userId)
    throw new HttpError(404, "not_found", "The upload session was not found.");
  if (session.upload_mode !== mode)
    throw new HttpError(
      409,
      "upload_mode_mismatch",
      `This upload uses ${session.upload_mode} mode.`,
    );
  if (session.expires_at <= Date.now())
    throw new HttpError(409, "upload_expired", "The upload authorization has expired.");
  if (!["authorized", "uploading", "verifying"].includes(session.state)) {
    throw new HttpError(409, "upload_not_writable", "The upload session is no longer writable.");
  }
}

function assertUploadBodyHeaders(
  request: Request,
  session: UploadSessionRow,
  expectedSize: number,
  part = false,
): void {
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isSafeInteger(length) || length !== expectedSize) {
    throw new HttpError(
      409,
      part ? "upload_part_size_mismatch" : "upload_size_mismatch",
      "The request size does not match the upload authorization.",
    );
  }
  if (normaliseMimeType(request.headers.get("Content-Type") ?? "") !== session.intended_mime_type) {
    throw new HttpError(
      415,
      "upload_mime_mismatch",
      "The request content type does not match the upload authorization.",
    );
  }
  if (!part && request.headers.get("X-Content-SHA256") !== session.intended_sha256) {
    throw new HttpError(
      409,
      "upload_checksum_mismatch",
      "The request checksum does not match the upload authorization.",
    );
  }
}

async function requireFile(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  fileId: string,
  includeArchived: boolean,
): Promise<FileRow> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, project_id, folder_id, title, status, summary, safe_display_name,
              current_version_id, provenance, retention_class, retention_review_at, version,
              archived_at, created_at, updated_at
         FROM files WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3
           AND (?4 = 1 OR archived_at IS NULL) LIMIT 1`,
    )
    .bind(fileId, actor.workspaceId, projectId, includeArchived ? 1 : 0)
    .first<FileRow>();
  if (!row) throw new HttpError(404, "not_found", "The requested file was not found.");
  return row;
}

async function requireFolder(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  folderId: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT id FROM folders WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1",
    )
    .bind(folderId, actor.workspaceId, projectId)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "not_found", "The requested folder was not found.");
}

async function requireFileVersion(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  fileId: string,
  versionId: string,
): Promise<FileVersionRow> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, project_id, file_id, version_number, original_name, safe_display_name,
              object_key, byte_size, mime_type, sha256, uploader_user_id, provenance, scan_state,
              retention_class, created_at
         FROM file_versions
        WHERE id = ?1 AND file_id = ?2 AND workspace_id = ?3 AND project_id = ?4 LIMIT 1`,
    )
    .bind(versionId, fileId, workspaceId, projectId)
    .first<FileVersionRow>();
  if (!row) throw new HttpError(404, "not_found", "The requested file version was not found.");
  return row;
}

async function completedUploadView(db: D1Database, session: UploadSessionRow) {
  if (!session.completed_file_version_id)
    throw new HttpError(409, "upload_not_complete", "The upload is not complete.");
  const version = await db
    .prepare(
      `SELECT id, workspace_id, project_id, file_id, version_number, original_name, safe_display_name,
              object_key, byte_size, mime_type, sha256, uploader_user_id, provenance, scan_state,
              retention_class, created_at
         FROM file_versions WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
    )
    .bind(session.completed_file_version_id, session.workspace_id, session.project_id)
    .first<FileVersionRow>();
  if (!version)
    throw new HttpError(
      409,
      "upload_metadata_incomplete",
      "The completed upload metadata is unavailable.",
    );
  return {
    uploadSessionId: session.id,
    state: "complete" as const,
    fileId: version.file_id,
    version: versionView(version),
  };
}

function uploadAuthorizationView(session: UploadSessionRow) {
  const base = `/api/v1/app/projects/${encodeURIComponent(session.project_id)}/files/uploads/${encodeURIComponent(session.id)}`;
  return {
    id: session.id,
    fileId: session.file_id,
    mode: session.upload_mode,
    state: session.state,
    byteSize: session.intended_byte_size,
    mimeType: session.intended_mime_type,
    sha256: session.intended_sha256,
    expiresAt: session.expires_at,
    contentHref: `${base}/content`,
    partHrefTemplate: null,
    completeHref: null,
    abortHref: `${base}/abort`,
    multipartPartBytes: null,
    scanState: "not_configured" as const,
  };
}

function uploadMetadata(
  uploadSessionId: string,
  workspaceId: string,
  projectId: string,
  sha256Value: string,
): Record<string, string> {
  return { uploadSessionId, workspaceId, projectId, sha256: sha256Value };
}

function parseUploadOptions(value: string): {
  readonly folderId: string | null;
  readonly title: string | null;
  readonly provenance: string | null;
  readonly retentionClass: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return emptyUploadOptions();
    return {
      folderId: boundedString(parsed.folderId, 128),
      title: boundedString(parsed.title, 240),
      provenance: boundedString(parsed.provenance, 500),
      retentionClass: boundedString(parsed.retentionClass, 80),
    };
  } catch {
    return emptyUploadOptions();
  }
}

function emptyUploadOptions() {
  return { folderId: null, title: null, provenance: null, retentionClass: null } as const;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fileListView(row: FileRow & Partial<FileVersionRow>) {
  return {
    ...fileView(row),
    currentVersion:
      row.current_version_id && row.version_number
        ? {
            id: row.current_version_id,
            versionNumber: row.version_number,
            byteSize: row.byte_size ?? null,
            mimeType: row.mime_type ?? null,
            sha256: row.sha256 ?? null,
            scanState: row.scan_state ?? null,
          }
        : null,
  };
}

function fileView(row: FileRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    safeDisplayName: row.safe_display_name,
    currentVersionId: row.current_version_id,
    provenance: row.provenance,
    retentionClass: row.retention_class,
    retentionReviewAt: row.retention_review_at,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionView(row: FileVersionRow) {
  return {
    id: row.id,
    fileId: row.file_id,
    versionNumber: row.version_number,
    originalName: row.original_name,
    safeDisplayName: row.safe_display_name,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    uploaderUserId: row.uploader_user_id,
    provenance: row.provenance,
    scanState: row.scan_state,
    scanConfigured: row.scan_state !== "not_configured",
    retentionClass: row.retention_class,
    createdAt: row.created_at,
  };
}

function assertDownloadable(version: FileVersionRow): void {
  if (["pending", "quarantined", "failed"].includes(version.scan_state)) {
    throw new HttpError(
      403,
      "file_quarantined",
      "This file is not available until its scan state is resolved.",
    );
  }
}

function privateDownloadHeaders(version: FileVersionRow): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(version.safe_display_name),
    "Content-Length": String(version.byte_size),
    "Content-Type": version.mime_type,
    ETag: `"sha256-${version.sha256}"`,
    "X-Content-Scan":
      version.scan_state === "not_configured" ? "not-configured" : version.scan_state,
    "X-Content-Type-Options": "nosniff",
  });
  return headers;
}

async function guardedFileBatch(
  context: Context<AppEnv>,
  file: FileRow,
  expectedVersion: number,
  statements: D1PreparedStatement[],
): Promise<void> {
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && /constraint|version_step|CHECK/iu.test(error.message)) {
      const current = await requireFile(
        context.env.DB,
        context.get("actor"),
        file.project_id,
        file.id,
        true,
      ).catch(() => null);
      throw new HttpError(409, "version_conflict", "This file changed in another session.", {
        expectedVersion,
        current: current ? fileView(current) : null,
      });
    }
    throw error;
  }
}

async function assertStorageBudget(
  db: D1Database,
  workspaceId: string,
  requestedBytes: number,
  budgetBytes: number,
): Promise<void> {
  const usage = await db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(byte_size) FROM file_versions WHERE workspace_id = ?1), 0) +
         COALESCE((SELECT SUM(intended_byte_size) FROM upload_sessions
                    WHERE workspace_id = ?1 AND completed_file_version_id IS NULL
                      AND state IN ('authorized', 'uploading', 'verifying')), 0) +
         COALESCE((SELECT SUM(emi.byte_size)
                     FROM export_manifest_items emi
                     JOIN export_snapshots es ON es.id = emi.export_snapshot_id
                    WHERE es.workspace_id = ?1 AND emi.file_version_id IS NULL), 0)
           AS used_bytes`,
    )
    .bind(workspaceId)
    .first<{ used_bytes: number }>();
  const usedBytes = Number(usage?.used_bytes ?? 0);
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    throw new HttpError(503, "storage_usage_unavailable", "Private storage usage is unavailable.");
  }
  if (usedBytes + requestedBytes > budgetBytes) {
    throw new HttpError(
      409,
      "storage_budget_exceeded",
      "The 1 GB no-subscription storage budget would be exceeded.",
      { usedBytes, requestedBytes, budgetBytes },
    );
  }
}

async function assertNoActiveLegalHold(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  fileId: string,
): Promise<void> {
  const active = await db
    .prepare(
      `SELECT lh.id
         FROM legal_holds lh
         LEFT JOIN legal_hold_objects lho ON lho.legal_hold_id = lh.id
         LEFT JOIN object_registry o ON o.id = lho.object_id
        WHERE lh.workspace_id = ?1 AND lh.released_at IS NULL
          AND (
            lh.scope = 'workspace'
            OR (lh.scope = 'project' AND lh.project_id = ?2)
            OR (lh.scope IN ('object', 'file') AND o.project_id = ?2 AND o.domain_table = 'files' AND o.domain_id = ?3)
          )
        LIMIT 1`,
    )
    .bind(workspaceId, projectId, fileId)
    .first<{ id: string }>();
  if (active)
    throw new HttpError(
      409,
      "legal_hold",
      "An active legal hold prevents removing this cloud copy.",
    );
}

async function findVerifiedArchive(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  fileId: string,
): Promise<string | undefined> {
  const row = await db
    .prepare(
      `SELECT aj.id
         FROM archive_jobs aj
         JOIN archive_manifest_items ami ON ami.archive_job_id = aj.id
        WHERE aj.workspace_id = ?1 AND aj.project_id = ?2 AND aj.status = 'verified'
          AND ami.logical_file_id = ?3 AND ami.state = 'verified'
        GROUP BY aj.id
       HAVING COUNT(DISTINCT ami.file_version_id) = (
         SELECT COUNT(*) FROM file_versions fv
          WHERE fv.workspace_id = ?1 AND fv.project_id = ?2 AND fv.file_id = ?3
       )
        ORDER BY aj.verified_at DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId, fileId)
    .first<{ id: string }>();
  return row?.id;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(404, "route_not_found", `Missing route parameter: ${name}.`);
  return value;
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function opaqueKeyPart(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new HttpError(422, "invalid_storage_scope", "The storage scope is invalid.");
  return value;
}
