import { createUuidV7 } from "@swp/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
import { randomToken, sha256 as shareSecretDigest } from "../auth/crypto";
import { requireActor, requireCsrf } from "../auth/session";
import { contentDisposition } from "../files/policy";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
} from "../idempotency";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import {
  allowedShareActions,
  assertShareAction,
  assertShareAvailable,
  assertShareObjectPurpose,
  createShareSession,
  extractPublicSections,
  isSupportedShareObjectType,
  parseActions,
  timingSafeStringEqual,
  unavailableShare,
  verifyShareSession,
  type SharePurpose,
  type ShareScope,
  type SupportedShareObjectType,
} from "../shares/security";

const sharePurposeSchema = z.enum([
  "viewer",
  "commenter",
  "approver",
  "candidate",
  "call_sheet_recipient",
]);
const shareActionSchema = z.enum(["view", "comment", "approve", "confirm", "download", "submit"]);
const createShareSchema = z
  .object({
    purpose: sharePurposeSchema,
    objectType: z.string().min(1).max(80),
    objectId: z.string().min(1).max(128),
    approvalId: z.string().min(1).max(128).optional(),
    allowedActions: z.array(shareActionSchema).max(6),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const exchangeSchema = z.object({ secret: z.string().min(32).max(200) }).strict();
const confirmationSchema = z.object({ note: z.string().trim().max(500).catch("") }).strict();
const commentSchema = z.object({ body: z.string().trim().min(1).max(4_000) }).strict();
const approvalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    displayName: z.string().trim().min(2).max(160),
    comment: z.string().trim().max(2_000).catch(""),
  })
  .strict();
const candidateSubmissionSchema = z
  .object({
    displayName: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(5).max(50).optional(),
    representation: z.string().trim().max(200).optional(),
    reelLinks: z.array(z.string().url().max(2_000)).max(10).default([]),
    note: z.string().trim().max(2_000).catch(""),
    consentAccepted: z.literal(true),
    privacyNoticeVersion: z.string().trim().min(1).max(80),
  })
  .strict();

interface ShareLinkRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly public_locator: string;
  readonly secret_digest: string;
  readonly purpose: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly allowed_actions_json: string;
  readonly field_projection_json: string;
  readonly expires_at: number;
  readonly revoked_at: number | null;
  readonly last_used_at: number | null;
  readonly created_at: number;
}

interface ArtifactDescriptor {
  readonly id: string;
  readonly type: SupportedShareObjectType;
  readonly title: string;
  readonly subtitle: string | null;
  readonly confidentiality: string;
  readonly issuedAt: number | null;
  readonly snapshot: unknown;
  readonly objectKey: string | null;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly byteSize: number | null;
  readonly recipientIssueId: string | null;
  readonly recipientDisplayName: string | null;
  readonly recipientPrivateNote: string | null;
  readonly registryId: string | null;
}

interface PublicSession {
  readonly scope: ShareScope;
  readonly csrf: string;
  readonly expiresAt: number;
}

const TARGET_TABLES: Readonly<Record<SupportedShareObjectType, string>> = {
  call_sheet_recipient_issue: "call_sheet_recipient_issues",
  call_sheet_issue: "call_sheet_issues",
  production_pack_issue: "production_pack_issues",
  sides_issue: "sides_issues",
  report_snapshot: "report_snapshots",
  file_version: "file_versions",
  casting_role: "casting_roles",
};

export const shareManagementRoutes = new Hono<AppEnv>();
shareManagementRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

shareManagementRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId);
  const links = await context.env.DB.prepare(
    `SELECT id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
              object_id, allowed_actions_json, field_projection_json, expires_at, revoked_at,
              last_used_at, created_at
         FROM share_links WHERE workspace_id = ?1 AND project_id = ?2
        ORDER BY created_at DESC, id DESC LIMIT 200`,
  )
    .bind(actor.workspaceId, projectId)
    .all<ShareLinkRow>();
  return ok(context, {
    items: links.results.map((link) => shareManagementView(scopeFromRow(link), link, false)),
  });
});

shareManagementRoutes.post("/", requireJson, async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = createShareSchema.parse(await context.req.json());
  if (!isSupportedShareObjectType(input.objectType)) {
    throw new HttpError(
      422,
      "invalid_share_scope",
      "The selected object type cannot be shared externally.",
    );
  }
  assertShareObjectPurpose(input.objectType, input.purpose);
  const now = Date.now();
  if (input.expiresAt < now + 5 * 60 * 1000 || input.expiresAt > now + 90 * 24 * 60 * 60 * 1000) {
    throw new HttpError(
      422,
      "invalid_share_expiry",
      "Secure links must expire between 5 minutes and 90 days from now.",
    );
  }
  const requestedActions = allowedShareActions(input.purpose, ["view", ...input.allowedActions]);
  if (requestedActions.length === 0)
    throw new HttpError(422, "invalid_share_scope", "The secure link must allow a view action.");
  const artifact = await loadArtifact(
    context.env.DB,
    actor.workspaceId,
    projectId,
    input.objectType,
    input.objectId,
  );
  const registryId =
    artifact.registryId ??
    (await ensureArtifactRegistry(
      context.env.DB,
      actor.workspaceId,
      projectId,
      input.objectType,
      input.objectId,
      artifact.title,
      now,
    ));
  const approvalId = await validateApprovalScope(
    context.env.DB,
    actor.workspaceId,
    projectId,
    input.purpose,
    input.approvalId,
    registryId,
  );
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: "share.create",
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef) {
    const replay = await requireManagedShare(
      context.env.DB,
      actor.workspaceId,
      projectId,
      lease.replayRef,
    );
    return ok(context, shareManagementView(scopeFromRow(replay), replay, false));
  }

  const id = createUuidV7();
  const publicLocator = randomToken(18);
  const secret = randomToken(32);
  const secretDigest = await shareSecretDigest(secret);
  const projection = JSON.stringify({
    version: 1,
    source: "immutable_snapshot",
    registryId,
    approvalId,
  });
  try {
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO share_links
            (id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
             object_id, allowed_actions_json, field_projection_json, created_by_user_id,
             expires_at, revoked_at, last_used_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL, ?13)`,
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        publicLocator,
        secretDigest,
        input.purpose,
        input.objectType,
        input.objectId,
        JSON.stringify(requestedActions),
        projection,
        actor.userId,
        input.expiresAt,
        now,
      ),
      completeIdempotentOperation(context.env.DB, lease.id, id, 201),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "share.created",
        objectType: input.objectType,
        objectId: input.objectId,
        requestId: context.get("requestId"),
        details: {
          shareLinkId: id,
          purpose: input.purpose,
          allowedActions: requestedActions,
          expiresAt: input.expiresAt,
        },
        occurredAt: now,
      }),
    ];
    if (input.objectType === "call_sheet_recipient_issue") {
      statements.push(
        context.env.DB.prepare(
          "UPDATE call_sheet_recipient_issues SET share_link_id = ?1 WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
        ).bind(id, input.objectId, actor.workspaceId, projectId),
      );
    }
    await context.env.DB.batch(statements);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
  const row = await requireManagedShare(context.env.DB, actor.workspaceId, projectId, id);
  return ok(
    context,
    {
      ...shareManagementView(scopeFromRow(row), row, true),
      secret,
      url: `${context.env.APP_ORIGIN}/s/${encodeURIComponent(publicLocator)}#${secret}`,
    },
    201,
  );
});

shareManagementRoutes.post("/:shareId/revoke", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"), "projectId");
  const shareId = requiredParam(context.req.param("shareId"), "shareId");
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const link = await requireManagedShare(context.env.DB, actor.workspaceId, projectId, shareId);
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4",
    ).bind(now, shareId, actor.workspaceId, projectId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "share.revoked",
      objectType: link.object_type,
      objectId: link.object_id,
      requestId: context.get("requestId"),
      details: { shareLinkId: link.id },
      occurredAt: now,
    }),
  ]);
  return ok(context, { revoked: true as const, revokedAt: link.revoked_at ?? now });
});

export const publicShareRoutes = new Hono<AppEnv>();
publicShareRoutes.use("*", publicShareRateLimit);

publicShareRoutes.post("/:publicId/exchange", requireSameOrigin, requireJson, async (context) => {
  const locator = requiredParam(context.req.param("publicId"), "publicId");
  const input = exchangeSchema.parse(await context.req.json());
  const row = await findShareByLocator(context.env.DB, locator);
  const providedDigest = await shareSecretDigest(input.secret);
  const valid = await timingSafeStringEqual(providedDigest, row?.secret_digest ?? "A".repeat(43));
  if (!row || !valid) throw unavailableShare();
  const scope = scopeFromRow(row);
  assertShareAvailable(scope, Date.now());
  assertShareAction(scope, "view");
  const session = await createShareSession(scope);
  setShareCookie(context, locator, session.token, session.expiresAt);
  await recordShareView(context, scope);
  return ok(context, await publicShareView(context.env.DB, scope, session.csrf, session.expiresAt));
});

publicShareRoutes.get("/:publicId", async (context) => {
  const session = await requirePublicSession(context);
  assertShareAction(session.scope, "view");
  return ok(
    context,
    await publicShareView(context.env.DB, session.scope, session.csrf, session.expiresAt),
  );
});

publicShareRoutes.post("/:publicId/confirm", requireSameOrigin, requireJson, async (context) => {
  const session = await requirePublicSession(context, true);
  assertShareAction(session.scope, "confirm");
  if (session.scope.objectType !== "call_sheet_recipient_issue") throw unavailableShare();
  const input = confirmationSchema.parse(await context.req.json());
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: session.scope.workspaceId,
    actorFingerprint: `share:${session.scope.id}`,
    operation: `share.confirm:${session.scope.objectId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (!lease.replayRef) {
    const id = createUuidV7();
    const now = Date.now();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO confirmations
              (id, workspace_id, project_id, call_sheet_recipient_issue_id, confirmed_by_type,
               confirmed_by_user_id, share_link_id, note, idempotency_key, confirmed_at, created_at)
             VALUES (?1, ?2, ?3, ?4, 'recipient', NULL, ?5, ?6, ?7, ?8, ?8)`,
        ).bind(
          id,
          session.scope.workspaceId,
          requiredShareProject(session.scope),
          session.scope.objectId,
          session.scope.id,
          input.note || null,
          context.req.header("Idempotency-Key"),
          now,
        ),
        completeIdempotentOperation(context.env.DB, lease.id, id, 201),
        shareAuditStatement(
          context.env.DB,
          session.scope,
          "share.recipient_confirmed",
          context.get("requestId"),
          now,
          {
            confirmationId: id,
            noteProvided: input.note.length > 0,
          },
        ),
      ]);
    } catch (error) {
      await failIdempotentOperation(context.env.DB, lease.id);
      throw error;
    }
  }
  return ok(
    context,
    await publicShareView(context.env.DB, session.scope, session.csrf, session.expiresAt),
  );
});

publicShareRoutes.post("/:publicId/comment", requireSameOrigin, requireJson, async (context) => {
  const session = await requirePublicSession(context, true);
  assertShareAction(session.scope, "comment");
  const input = commentSchema.parse(await context.req.json());
  const artifact = await loadArtifact(
    context.env.DB,
    session.scope.workspaceId,
    requiredShareProject(session.scope),
    session.scope.objectType,
    session.scope.objectId,
  );
  if (!artifact.registryId)
    throw new HttpError(
      409,
      "share_comment_unavailable",
      "Comments are not available for this issued artifact.",
    );
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: session.scope.workspaceId,
    actorFingerprint: `share:${session.scope.id}`,
    operation: `share.comment:${session.scope.objectId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  let commentId = lease.replayRef;
  if (!commentId) {
    commentId = createUuidV7();
    const now = Date.now();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO comments
              (id, workspace_id, project_id, object_id, author_user_id, share_link_id,
               parent_comment_id, body, resolved_at, resolved_by_user_id, version,
               archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6, NULL, NULL, 1, NULL, ?7, ?7)`,
        ).bind(
          commentId,
          session.scope.workspaceId,
          requiredShareProject(session.scope),
          artifact.registryId,
          session.scope.id,
          input.body,
          now,
        ),
        completeIdempotentOperation(context.env.DB, lease.id, commentId, 201),
        shareAuditStatement(
          context.env.DB,
          session.scope,
          "share.comment_created",
          context.get("requestId"),
          now,
          {
            commentId,
          },
        ),
      ]);
    } catch (error) {
      await failIdempotentOperation(context.env.DB, lease.id);
      throw error;
    }
  }
  const row = await context.env.DB.prepare(
    "SELECT id, body, created_at FROM comments WHERE id = ?1 AND share_link_id = ?2 LIMIT 1",
  )
    .bind(commentId, session.scope.id)
    .first<{ id: string; body: string; created_at: number }>();
  if (!row) throw new HttpError(409, "comment_unavailable", "The comment could not be loaded.");
  return ok(context, { comment: { id: row.id, body: row.body, createdAt: row.created_at } });
});

publicShareRoutes.post("/:publicId/submit", requireSameOrigin, requireJson, async (context) => {
  const session = await requirePublicSession(context, true);
  assertShareAction(session.scope, "submit");
  if (session.scope.objectType !== "casting_role") throw unavailableShare();
  const input = candidateSubmissionSchema.parse(await context.req.json());
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: session.scope.workspaceId,
    actorFingerprint: `share:${session.scope.id}`,
    operation: `share.candidate_submit:${session.scope.objectId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  let candidateId = lease.replayRef;
  if (!candidateId) {
    const personId = createUuidV7();
    candidateId = createUuidV7();
    const personRegistryId = createUuidV7();
    const candidateRegistryId = createUuidV7();
    const now = Date.now();
    const projectId = requiredShareProject(session.scope);
    try {
      const statements: D1PreparedStatement[] = [
        context.env.DB.prepare(
          `INSERT INTO people
              (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank,
               given_name, family_name, pronouns, photo_file_id, representation_company,
               provenance, consent_status, retention_review_at, details_json, version,
               archived_at, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'candidate', NULL, NULL, ?5, NULL, NULL, NULL, NULL,
                     ?6, ?7, 'provided', ?8, ?9, 1, NULL, NULL, ?10, ?10)`,
        ).bind(
          personId,
          session.scope.workspaceId,
          projectId,
          input.displayName,
          `candidate-${candidateId}`,
          input.representation ?? null,
          `secure_share:${session.scope.id}`,
          now + 180 * 24 * 60 * 60 * 1000,
          JSON.stringify({ privacyNoticeVersion: input.privacyNoticeVersion }),
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO contact_points
              (id, workspace_id, person_id, type, label, value, is_primary, consent_status,
               version, archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'email', 'Candidate submission', ?4, 1, 'provided', 1, NULL, ?5, ?5)`,
        ).bind(createUuidV7(), session.scope.workspaceId, personId, input.email, now),
        context.env.DB.prepare(
          `INSERT INTO candidates
              (id, workspace_id, project_id, casting_role_id, person_id, status, source,
               reel_links_json, private_notes, consent_status, retention_review_at, version,
               archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'submitted', ?6, ?7, ?8, 'provided', ?9, 1, NULL, ?10, ?10)`,
        ).bind(
          candidateId,
          session.scope.workspaceId,
          projectId,
          session.scope.objectId,
          personId,
          `secure_share:${session.scope.id}`,
          JSON.stringify(input.reelLinks),
          input.note || null,
          now + 180 * 24 * 60 * 60 * 1000,
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO object_registry
              (id, workspace_id, project_id, object_type, domain_table, domain_id, title,
               version, archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'person', 'people', ?4, ?5, 1, NULL, ?6, ?6)`,
        ).bind(
          personRegistryId,
          session.scope.workspaceId,
          projectId,
          personId,
          input.displayName,
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO object_registry
              (id, workspace_id, project_id, object_type, domain_table, domain_id, title,
               version, archived_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'candidate', 'candidates', ?4, ?5, 1, NULL, ?6, ?6)`,
        ).bind(
          candidateRegistryId,
          session.scope.workspaceId,
          projectId,
          candidateId,
          input.displayName,
          now,
        ),
        completeIdempotentOperation(context.env.DB, lease.id, candidateId, 201),
        shareAuditStatement(
          context.env.DB,
          session.scope,
          "share.candidate_submitted",
          context.get("requestId"),
          now,
          {
            candidateId,
            privacyNoticeVersion: input.privacyNoticeVersion,
            hasPhone: Boolean(input.phone),
            reelLinkCount: input.reelLinks.length,
          },
        ),
      ];
      if (input.phone) {
        statements.splice(
          2,
          0,
          context.env.DB.prepare(
            `INSERT INTO contact_points
                (id, workspace_id, person_id, type, label, value, is_primary, consent_status,
                 version, archived_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, 'phone', 'Candidate submission', ?4, 0, 'provided', 1, NULL, ?5, ?5)`,
          ).bind(createUuidV7(), session.scope.workspaceId, personId, input.phone, now),
        );
      }
      await context.env.DB.batch(statements);
    } catch (error) {
      await failIdempotentOperation(context.env.DB, lease.id);
      throw error;
    }
  }
  return ok(context, {
    submitted: true as const,
    referenceId: candidateId,
    message: "Submission received. Delivery providers were not used.",
  });
});

publicShareRoutes.post("/:publicId/approve", requireSameOrigin, requireJson, async (context) => {
  const session = await requirePublicSession(context, true);
  assertShareAction(session.scope, "approve");
  if (!session.scope.approvalId) throw unavailableShare();
  const input = approvalDecisionSchema.parse(await context.req.json());
  const artifact = await loadArtifact(
    context.env.DB,
    session.scope.workspaceId,
    requiredShareProject(session.scope),
    session.scope.objectType,
    session.scope.objectId,
  );
  if (!artifact.registryId) throw unavailableShare();
  const approval = await context.env.DB.prepare(
    `SELECT id, object_id, status, pinned_version_id, version
         FROM approvals
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1`,
  )
    .bind(session.scope.approvalId, session.scope.workspaceId, requiredShareProject(session.scope))
    .first<{
      id: string;
      object_id: string;
      status: string;
      pinned_version_id: string | null;
      version: number;
    }>();
  if (!approval || approval.object_id !== artifact.registryId) throw unavailableShare();

  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: session.scope.workspaceId,
    actorFingerprint: `share:${session.scope.id}`,
    operation: `share.approval:${approval.id}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (!lease.replayRef) {
    if (approval.status !== "requested") {
      await failIdempotentOperation(context.env.DB, lease.id);
      throw new HttpError(
        409,
        "approval_already_decided",
        "This approval request is no longer pending.",
      );
    }
    const decisionId = createUuidV7();
    const guardId = createUuidV7();
    const now = Date.now();
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at)
             VALUES (?1, ?2, COALESCE((
               SELECT version FROM approvals
                WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5 AND status = 'requested'
             ), -1), ?6)`,
        ).bind(
          guardId,
          approval.version,
          approval.id,
          session.scope.workspaceId,
          requiredShareProject(session.scope),
          now,
        ),
        context.env.DB.prepare(
          `INSERT INTO approval_decisions
              (id, workspace_id, project_id, approval_id, decision, actor_user_id,
               share_link_id, actor_label, comment, pinned_version_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10)`,
        ).bind(
          decisionId,
          session.scope.workspaceId,
          requiredShareProject(session.scope),
          approval.id,
          input.decision,
          session.scope.id,
          input.displayName,
          input.comment || null,
          approval.pinned_version_id,
          now,
        ),
        context.env.DB.prepare(
          `UPDATE approvals SET status = ?1, version = version + 1, updated_at = ?2
              WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5
                AND status = 'requested' AND version = ?6`,
        ).bind(
          input.decision,
          now,
          approval.id,
          session.scope.workspaceId,
          requiredShareProject(session.scope),
          approval.version,
        ),
        context.env.DB.prepare("DELETE FROM optimistic_mutation_guards WHERE id = ?1").bind(
          guardId,
        ),
        completeIdempotentOperation(context.env.DB, lease.id, decisionId, 201),
        shareAuditStatement(
          context.env.DB,
          session.scope,
          "share.approval_decided",
          context.get("requestId"),
          now,
          {
            approvalId: approval.id,
            approvalDecisionId: decisionId,
            decision: input.decision,
            pinnedVersionId: approval.pinned_version_id,
          },
        ),
      ]);
    } catch (error) {
      await failIdempotentOperation(context.env.DB, lease.id);
      if (error instanceof Error && /constraint|CHECK|version_step/iu.test(error.message)) {
        throw new HttpError(
          409,
          "approval_conflict",
          "The approval changed before this decision could be recorded.",
        );
      }
      throw error;
    }
  }
  return ok(
    context,
    await publicShareView(context.env.DB, session.scope, session.csrf, session.expiresAt),
  );
});

publicShareRoutes.get("/:publicId/download", async (context) => {
  const session = await requirePublicSession(context);
  assertShareAction(session.scope, "download");
  const artifact = await loadArtifact(
    context.env.DB,
    session.scope.workspaceId,
    requiredShareProject(session.scope),
    session.scope.objectType,
    session.scope.objectId,
  );
  if (!artifact.objectKey)
    throw new HttpError(
      404,
      "download_unavailable",
      "This issued artifact has no downloadable file.",
    );
  const object = await context.env.FILES.get(artifact.objectKey);
  if (!object || (artifact.byteSize !== null && object.size !== artifact.byteSize)) {
    throw new HttpError(
      503,
      "download_unavailable",
      "The issued file is unavailable or failed its integrity check.",
    );
  }
  await recordShareDownload(context, session.scope, artifact.recipientIssueId);
  const fileName = artifact.fileName ?? `${artifact.title}.pdf`;
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDisposition(fileName),
      "Content-Length": String(object.size),
      "Content-Type":
        artifact.mimeType ?? object.httpMetadata?.contentType ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

async function publicShareView(db: D1Database, scope: ShareScope, csrf: string, expiresAt: number) {
  const artifact = await loadArtifact(
    db,
    scope.workspaceId,
    requiredShareProject(scope),
    scope.objectType,
    scope.objectId,
  );
  const recipient = artifact.recipientIssueId
    ? await recipientState(db, artifact.recipientIssueId, scope.id, artifact)
    : null;
  const approval = scope.approvalId
    ? await db
        .prepare(
          "SELECT status, updated_at FROM approvals WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
        )
        .bind(scope.approvalId, scope.workspaceId, requiredShareProject(scope))
        .first<{ status: string; updated_at: number }>()
    : null;
  return {
    shareSession: csrf,
    expiresAt,
    purpose: scope.purpose,
    artifact: {
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      subtitle: artifact.subtitle,
      confidentiality: artifact.confidentiality,
      issuedAt: artifact.issuedAt,
      content: extractPublicSections(artifact.snapshot),
      downloadHref:
        artifact.objectKey && scope.allowedActions.includes("download")
          ? `/api/v1/public/shares/${encodeURIComponent(scope.publicLocator)}/download`
          : null,
    },
    recipient,
    approval: approval
      ? { id: scope.approvalId, status: approval.status, updatedAt: approval.updated_at }
      : null,
    permissions: {
      comment: scope.allowedActions.includes("comment"),
      approve: scope.allowedActions.includes("approve") && approval?.status === "requested",
      confirm: scope.allowedActions.includes("confirm"),
      download: scope.allowedActions.includes("download") && artifact.objectKey !== null,
      submit: scope.allowedActions.includes("submit"),
    },
  };
}

async function recipientState(
  db: D1Database,
  recipientIssueId: string,
  shareLinkId: string,
  artifact: ArtifactDescriptor,
) {
  const state = await db
    .prepare(
      `SELECT
         (SELECT MIN(occurred_at) FROM delivery_events WHERE call_sheet_recipient_issue_id = ?1 AND event_type = 'viewed') AS viewed_at,
         (SELECT MAX(confirmed_at) FROM confirmations WHERE call_sheet_recipient_issue_id = ?1 AND share_link_id = ?2) AS confirmed_at`,
    )
    .bind(recipientIssueId, shareLinkId)
    .first<{ viewed_at: number | null; confirmed_at: number | null }>();
  return {
    displayName: artifact.recipientDisplayName ?? "Recipient",
    confirmedAt: state?.confirmed_at ?? null,
    viewedAt: state?.viewed_at ?? null,
    privateNote: artifact.recipientPrivateNote,
  };
}

async function loadArtifact(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  objectType: SupportedShareObjectType,
  objectId: string,
): Promise<ArtifactDescriptor> {
  const registry = await db
    .prepare(
      "SELECT id FROM object_registry WHERE workspace_id = ?1 AND project_id = ?2 AND domain_table = ?3 AND domain_id = ?4 LIMIT 1",
    )
    .bind(workspaceId, projectId, TARGET_TABLES[objectType], objectId)
    .first<{ id: string }>();
  if (objectType === "call_sheet_recipient_issue") {
    const row = await db
      .prepare(
        `SELECT cri.id, ci.title, ci.confidentiality_marking, cri.variant_snapshot_json,
                cri.r2_object_key, cri.created_at, cr.private_note, p.title AS recipient_name
           FROM call_sheet_recipient_issues cri
           JOIN call_sheet_issues ci ON ci.id = cri.call_sheet_issue_id AND ci.workspace_id = cri.workspace_id AND ci.project_id = cri.project_id
           JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id AND cr.workspace_id = cri.workspace_id AND cr.project_id = cri.project_id
           JOIN people p ON p.id = cr.person_id AND p.workspace_id = cri.workspace_id
          WHERE cri.id = ?1 AND cri.workspace_id = ?2 AND cri.project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        confidentiality_marking: string | null;
        variant_snapshot_json: string;
        r2_object_key: string | null;
        created_at: number;
        private_note: string | null;
        recipient_name: string;
      }>();
    if (!row) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: row.confidentiality_marking,
      snapshotJson: row.variant_snapshot_json,
      objectKey: row.r2_object_key,
      createdAt: row.created_at,
      recipientIssueId: row.id,
      recipientDisplayName: row.recipient_name,
      recipientPrivateNote: row.private_note,
      registryId: registry?.id ?? null,
    });
  }
  if (objectType === "call_sheet_issue") {
    const row = await db
      .prepare(
        `SELECT id, title, confidentiality_marking, canonical_snapshot_json, r2_object_key, created_at
         FROM call_sheet_issues WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        confidentiality_marking: string | null;
        canonical_snapshot_json: string;
        r2_object_key: string | null;
        created_at: number;
      }>();
    if (!row) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: row.confidentiality_marking,
      snapshotJson: row.canonical_snapshot_json,
      objectKey: row.r2_object_key,
      createdAt: row.created_at,
      registryId: registry?.id ?? null,
    });
  }
  if (objectType === "production_pack_issue") {
    const row = await db
      .prepare(
        `SELECT id, title, manifest_json, r2_object_key, created_at FROM production_pack_issues
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        manifest_json: string;
        r2_object_key: string | null;
        created_at: number;
      }>();
    if (!row) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: "Confidential production pack",
      snapshotJson: row.manifest_json,
      objectKey: row.r2_object_key,
      createdAt: row.created_at,
      fileName: `${row.title}.zip`,
      mimeType: "application/zip",
      registryId: registry?.id ?? null,
    });
  }
  if (objectType === "sides_issue") {
    const row = await db
      .prepare(
        `SELECT id, title, presentation_json, r2_object_key, created_at FROM sides_issues
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        presentation_json: string;
        r2_object_key: string | null;
        created_at: number;
      }>();
    if (!row) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: "Confidential sides",
      snapshotJson: row.presentation_json,
      objectKey: row.r2_object_key,
      createdAt: row.created_at,
      registryId: registry?.id ?? null,
    });
  }
  if (objectType === "report_snapshot") {
    const row = await db
      .prepare(
        `SELECT id, title, snapshot_json, r2_object_key, created_at FROM report_snapshots
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        snapshot_json: string;
        r2_object_key: string | null;
        created_at: number;
      }>();
    if (!row) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: "Confidential report",
      snapshotJson: row.snapshot_json,
      objectKey: row.r2_object_key,
      createdAt: row.created_at,
      registryId: registry?.id ?? null,
    });
  }
  if (objectType === "file_version") {
    const row = await db
      .prepare(
        `SELECT fv.id, f.title, f.summary, fv.safe_display_name, fv.object_key, fv.mime_type,
              fv.byte_size, fv.created_at, fv.scan_state
         FROM file_versions fv JOIN files f ON f.id = fv.file_id AND f.workspace_id = fv.workspace_id AND f.project_id = fv.project_id
        WHERE fv.id = ?1 AND fv.workspace_id = ?2 AND fv.project_id = ?3 LIMIT 1`,
      )
      .bind(objectId, workspaceId, projectId)
      .first<{
        id: string;
        title: string;
        summary: string | null;
        safe_display_name: string;
        object_key: string;
        mime_type: string;
        byte_size: number;
        created_at: number;
        scan_state: string;
      }>();
    if (!row || !["clean", "not_configured"].includes(row.scan_state)) throw unavailableShare();
    return descriptor({
      id: row.id,
      type: objectType,
      title: row.title,
      confidentiality: "Confidential file",
      snapshot: { summary: row.summary ?? "Shared production file." },
      objectKey: row.object_key,
      createdAt: row.created_at,
      fileName: row.safe_display_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      registryId: registry?.id ?? null,
    });
  }
  const row = await db
    .prepare(
      `SELECT id, title, summary, details_json, created_at FROM casting_roles
      WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND archived_at IS NULL LIMIT 1`,
    )
    .bind(objectId, workspaceId, projectId)
    .first<{
      id: string;
      title: string;
      summary: string | null;
      details_json: string;
      created_at: number;
    }>();
  if (!row) throw unavailableShare();
  return descriptor({
    id: row.id,
    type: objectType,
    title: row.title,
    confidentiality: "Candidate submission",
    snapshot: { summary: row.summary ?? "Casting submission portal." },
    objectKey: null,
    createdAt: row.created_at,
    registryId: registry?.id ?? null,
  });
}

function descriptor(input: {
  readonly id: string;
  readonly type: SupportedShareObjectType;
  readonly title: string;
  readonly confidentiality: string | null;
  readonly snapshotJson?: string;
  readonly snapshot?: unknown;
  readonly objectKey: string | null;
  readonly createdAt: number;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly recipientIssueId?: string;
  readonly recipientDisplayName?: string;
  readonly recipientPrivateNote?: string | null;
  readonly registryId: string | null;
}): ArtifactDescriptor {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    subtitle: null,
    confidentiality: input.confidentiality ?? "Confidential",
    issuedAt: input.createdAt,
    snapshot: input.snapshot ?? parseJson(input.snapshotJson),
    objectKey: input.objectKey,
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? (input.objectKey ? "application/pdf" : null),
    byteSize: input.byteSize ?? null,
    recipientIssueId: input.recipientIssueId ?? null,
    recipientDisplayName: input.recipientDisplayName ?? null,
    recipientPrivateNote: input.recipientPrivateNote ?? null,
    registryId: input.registryId,
  };
}

async function requirePublicSession(
  context: Context<AppEnv>,
  mutation = false,
): Promise<PublicSession> {
  const locator = requiredParam(context.req.param("publicId"), "publicId");
  const row = await findShareByLocator(context.env.DB, locator);
  if (!row) throw unavailableShare();
  const scope = scopeFromRow(row);
  assertShareAvailable(scope, Date.now());
  const token = readCookie(context.req.header("Cookie"), "swp_share");
  if (!token) throw unavailableShare();
  const verified = await verifyShareSession(scope, token);
  if (mutation) {
    const authorization = context.req.header("Authorization");
    if (
      !authorization?.startsWith("Share ") ||
      !(await timingSafeStringEqual(authorization.slice(6), verified.csrf))
    ) {
      throw new HttpError(
        403,
        "share_request_denied",
        "The secure-link request could not be verified.",
      );
    }
  }
  return { scope, csrf: verified.csrf, expiresAt: verified.expiresAt };
}

async function publicShareRateLimit(
  context: Context<AppEnv>,
  next: () => Promise<void>,
): Promise<void> {
  const locator = context.req.param("publicId") ?? "unknown";
  const address = context.req.header("CF-Connecting-IP") ?? "unknown";
  const result = await context.env.PUBLIC_RATE_LIMITER.limit({
    key: await shareSecretDigest(`${address}|${locator}`),
  });
  if (!result.success) {
    context.header("Retry-After", "60");
    throw new HttpError(429, "rate_limited", "Too many secure-link requests. Try again later.");
  }
  await next();
}

async function recordShareView(context: Context<AppEnv>, scope: ShareScope): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare("UPDATE share_links SET last_used_at = ?1 WHERE id = ?2").bind(
      now,
      scope.id,
    ),
    shareAuditStatement(context.env.DB, scope, "share.viewed", context.get("requestId"), now),
  ];
  if (scope.objectType === "call_sheet_recipient_issue") {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO delivery_events
            (id, workspace_id, project_id, call_sheet_recipient_issue_id, outbox_entry_id,
             event_type, evidence_json, idempotency_key, occurred_at, created_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 'viewed', '{}', ?5, ?6, ?6)`,
      ).bind(
        createUuidV7(),
        scope.workspaceId,
        requiredShareProject(scope),
        scope.objectId,
        `share-view:${scope.id}`,
        now,
      ),
    );
  }
  await context.env.DB.batch(statements);
}

async function recordShareDownload(
  context: Context<AppEnv>,
  scope: ShareScope,
  recipientIssueId: string | null,
): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    shareAuditStatement(context.env.DB, scope, "share.downloaded", context.get("requestId"), now),
  ];
  if (recipientIssueId) {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO delivery_events
            (id, workspace_id, project_id, call_sheet_recipient_issue_id, outbox_entry_id,
             event_type, evidence_json, idempotency_key, occurred_at, created_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 'downloaded', '{}', ?5, ?6, ?6)`,
      ).bind(
        createUuidV7(),
        scope.workspaceId,
        requiredShareProject(scope),
        recipientIssueId,
        `share-download:${scope.id}`,
        now,
      ),
    );
  }
  await context.env.DB.batch(statements);
}

function shareAuditStatement(
  db: D1Database,
  scope: ShareScope,
  action: string,
  requestId: string,
  now: number,
  metadata: Record<string, unknown> = {},
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events
        (id, workspace_id, project_id, actor_type, actor_id, action, object_type,
         object_id, request_id, metadata_json, created_at)
       VALUES (?1, ?2, ?3, 'share', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      createUuidV7(),
      scope.workspaceId,
      scope.projectId,
      scope.id,
      action,
      scope.objectType,
      scope.objectId,
      requestId,
      JSON.stringify(metadata),
      now,
    );
}

async function findShareByLocator(db: D1Database, locator: string): Promise<ShareLinkRow | null> {
  return db
    .prepare(
      `SELECT id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
              object_id, allowed_actions_json, field_projection_json, expires_at, revoked_at,
              last_used_at, created_at
         FROM share_links WHERE public_locator = ?1 LIMIT 1`,
    )
    .bind(locator)
    .first<ShareLinkRow>();
}

async function requireManagedShare(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  id: string,
): Promise<ShareLinkRow> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
              object_id, allowed_actions_json, field_projection_json, expires_at, revoked_at,
              last_used_at, created_at
         FROM share_links WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
    )
    .bind(id, workspaceId, projectId)
    .first<ShareLinkRow>();
  if (!row) throw new HttpError(404, "not_found", "The secure link was not found.");
  return row;
}

function scopeFromRow(row: ShareLinkRow): ShareScope {
  const purpose = sharePurposeSchema.safeParse(row.purpose);
  if (!purpose.success || !isSupportedShareObjectType(row.object_type)) throw unavailableShare();
  const projection = parseJson(row.field_projection_json);
  const approvalId =
    isRecord(projection) && typeof projection.approvalId === "string"
      ? projection.approvalId
      : undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    publicLocator: row.public_locator,
    secretDigest: row.secret_digest,
    purpose: purpose.data,
    objectType: row.object_type,
    objectId: row.object_id,
    ...(approvalId ? { approvalId } : {}),
    allowedActions: parseActions(row.allowed_actions_json),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function shareManagementView(scope: ShareScope, row: ShareLinkRow, secretShown: boolean) {
  return {
    id: scope.id,
    publicLocator: scope.publicLocator,
    purpose: scope.purpose,
    objectType: scope.objectType,
    objectId: scope.objectId,
    allowedActions: scope.allowedActions,
    expiresAt: scope.expiresAt,
    revokedAt: scope.revokedAt,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    secretShownOnce: secretShown,
    secret: null,
    url: null,
  };
}

async function ensureArtifactRegistry(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  objectType: SupportedShareObjectType,
  objectId: string,
  title: string,
  now: number,
): Promise<string> {
  const id = createUuidV7();
  await db
    .prepare(
      `INSERT OR IGNORE INTO object_registry
        (id, workspace_id, project_id, object_type, domain_table, domain_id, title,
         version, archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?8, ?8)`,
    )
    .bind(id, workspaceId, projectId, objectType, TARGET_TABLES[objectType], objectId, title, now)
    .run();
  const row = await db
    .prepare(
      "SELECT id FROM object_registry WHERE workspace_id = ?1 AND project_id = ?2 AND domain_table = ?3 AND domain_id = ?4 LIMIT 1",
    )
    .bind(workspaceId, projectId, TARGET_TABLES[objectType], objectId)
    .first<{ id: string }>();
  if (!row)
    throw new HttpError(
      409,
      "object_registry_unavailable",
      "The shared object could not be registered.",
    );
  return row.id;
}

async function validateApprovalScope(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  purpose: SharePurpose,
  approvalId: string | undefined,
  artifactRegistryId: string,
): Promise<string | null> {
  if (purpose !== "approver") {
    if (approvalId) {
      throw new HttpError(
        422,
        "invalid_share_scope",
        "Only an approver link can select an approval request.",
      );
    }
    return null;
  }
  if (!approvalId) {
    throw new HttpError(
      422,
      "approval_required",
      "Select the pending approval request for this approver link.",
    );
  }
  const approval = await db
    .prepare(
      `SELECT id FROM approvals
        WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND object_id = ?4
          AND status = 'requested' AND archived_at IS NULL LIMIT 1`,
    )
    .bind(approvalId, workspaceId, projectId, artifactRegistryId)
    .first<{ id: string }>();
  if (!approval) {
    throw new HttpError(
      422,
      "approval_unavailable",
      "The selected approval request is not pending for this artifact.",
    );
  }
  return approval.id;
}

function setShareCookie(
  context: Context<AppEnv>,
  locator: string,
  token: string,
  expiresAt: number,
): void {
  const url = new URL(context.req.url);
  const secure =
    url.protocol === "https:" && url.hostname === new URL(context.env.APP_ORIGIN).hostname
      ? "; Secure"
      : "";
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  context.header(
    "Set-Cookie",
    `swp_share=${encodeURIComponent(token)}; Path=/api/v1/public/shares/${encodeURIComponent(locator)}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function requiredShareProject(scope: ShareScope): string {
  if (!scope.projectId) throw unavailableShare();
  return scope.projectId;
}

function parseJson(value?: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw new HttpError(404, "route_not_found", `Missing route parameter: ${name}.`);
  return value;
}
