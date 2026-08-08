import { createUuidV7 } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
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
import { parseIfMatch, versionGuard } from "../records/version";

const objectTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);
const objectIdSchema = z.string().min(8).max(80);
const commentInputSchema = z
  .object({
    body: z.string().trim().min(1).max(8_000),
    parentCommentId: z.string().min(8).max(80).optional(),
    mentionUserIds: z.array(z.string().min(8).max(80)).max(10).default([]),
  })
  .strict();
const approvalInputSchema = z
  .object({
    title: z.string().trim().min(2).max(240),
    summary: z.string().trim().max(2_000).default(""),
    approverUserId: z.string().min(8).max(80),
    pinnedVersionId: z.string().min(1).max(160).optional(),
    dueAt: z.number().int().positive().optional(),
    selfApprovalAllowed: z.boolean().default(false),
  })
  .strict();
const decisionInputSchema = z
  .object({
    decision: z.enum(["approved", "changes_requested", "rejected"]),
    comment: z.string().trim().max(4_000).default(""),
  })
  .strict();

interface RegisteredObject {
  readonly id: string;
  readonly object_type: string;
  readonly domain_id: string;
  readonly title: string | null;
}

interface CommentRow {
  readonly id: string;
  readonly body: string;
  readonly parent_comment_id: string | null;
  readonly author_user_id: string | null;
  readonly author_name: string | null;
  readonly resolved_at: number | null;
  readonly resolved_by_name: string | null;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ApprovalRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly summary: string | null;
  readonly owner_user_id: string | null;
  readonly owner_name: string | null;
  readonly approver_user_id: string | null;
  readonly approver_name: string | null;
  readonly pinned_version_id: string | null;
  readonly requested_at: number;
  readonly due_at: number | null;
  readonly self_approval_allowed: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export const collaborationRoutes = new Hono<AppEnv>();
collaborationRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

collaborationRoutes.get("/:objectType/:domainId", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const object = await registeredObject(
    context.env.DB,
    actor.workspaceId,
    projectId,
    context.req.param("objectType"),
    context.req.param("domainId"),
  );

  const [members, commentRows, mentionRows, approvalRows, decisionRows, activityRows] =
    await Promise.all([
      context.env.DB.prepare(
        `SELECT u.id, u.username, u.display_name, pm.role
         FROM project_memberships pm JOIN user_identities u ON u.id = pm.user_id AND u.workspace_id = pm.workspace_id
        WHERE pm.workspace_id = ?1 AND pm.project_id = ?2 AND pm.status = 'active' AND u.status = 'active'
        ORDER BY u.display_name, u.id`,
      )
        .bind(actor.workspaceId, projectId)
        .all<{ id: string; username: string; display_name: string; role: string }>(),
      context.env.DB.prepare(
        `SELECT c.id, c.body, c.parent_comment_id, c.author_user_id, u.display_name AS author_name,
              c.resolved_at, ru.display_name AS resolved_by_name, c.version, c.created_at, c.updated_at
         FROM comments c
         LEFT JOIN user_identities u ON u.id = c.author_user_id AND u.workspace_id = c.workspace_id
         LEFT JOIN user_identities ru ON ru.id = c.resolved_by_user_id AND ru.workspace_id = c.workspace_id
        WHERE c.workspace_id = ?1 AND c.project_id = ?2 AND c.object_id = ?3 AND c.archived_at IS NULL
        ORDER BY c.created_at, c.id LIMIT 500`,
      )
        .bind(actor.workspaceId, projectId, object.id)
        .all<CommentRow>(),
      context.env.DB.prepare(
        `SELECT m.comment_id, u.id AS user_id, u.display_name
         FROM mentions m JOIN user_identities u ON u.id = m.mentioned_user_id AND u.workspace_id = m.workspace_id
         JOIN comments c ON c.id = m.comment_id
        WHERE m.workspace_id = ?1 AND c.project_id = ?2 AND c.object_id = ?3
        ORDER BY u.display_name`,
      )
        .bind(actor.workspaceId, projectId, object.id)
        .all<{ comment_id: string; user_id: string; display_name: string }>(),
      context.env.DB.prepare(
        `SELECT a.id, a.title, a.status, a.summary, a.owner_user_id, owner.display_name AS owner_name,
              a.approver_user_id, approver.display_name AS approver_name, a.pinned_version_id,
              a.requested_at, a.due_at, a.self_approval_allowed, a.version, a.created_at, a.updated_at
         FROM approvals a
         LEFT JOIN user_identities owner ON owner.id = a.owner_user_id AND owner.workspace_id = a.workspace_id
         LEFT JOIN user_identities approver ON approver.id = a.approver_user_id AND approver.workspace_id = a.workspace_id
        WHERE a.workspace_id = ?1 AND a.project_id = ?2 AND a.object_id = ?3 AND a.archived_at IS NULL
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
      )
        .bind(actor.workspaceId, projectId, object.id)
        .all<ApprovalRow>(),
      context.env.DB.prepare(
        `SELECT d.id, d.approval_id, d.decision, d.comment, d.pinned_version_id, d.created_at,
              u.display_name AS actor_name
         FROM approval_decisions d
         JOIN approvals a ON a.id = d.approval_id AND a.workspace_id = d.workspace_id
         LEFT JOIN user_identities u ON u.id = d.actor_user_id AND u.workspace_id = d.workspace_id
        WHERE d.workspace_id = ?1 AND d.project_id = ?2 AND a.object_id = ?3
        ORDER BY d.created_at, d.id`,
      )
        .bind(actor.workspaceId, projectId, object.id)
        .all<{
          id: string;
          approval_id: string;
          decision: string;
          comment: string | null;
          pinned_version_id: string | null;
          created_at: number;
          actor_name: string | null;
        }>(),
      context.env.DB.prepare(
        `SELECT a.id, a.verb, a.summary, a.metadata_json, a.created_at, u.display_name AS actor_name
         FROM activities a LEFT JOIN user_identities u ON u.id = a.actor_user_id AND u.workspace_id = a.workspace_id
        WHERE a.workspace_id = ?1 AND a.project_id = ?2 AND a.object_id = ?3
        ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
      )
        .bind(actor.workspaceId, projectId, object.id)
        .all<{
          id: string;
          verb: string;
          summary: string;
          metadata_json: string;
          created_at: number;
          actor_name: string | null;
        }>(),
    ]);

  return ok(context, {
    object: { id: object.domain_id, objectType: object.object_type, title: object.title },
    members: members.results.map((member) => ({
      id: member.id,
      username: member.username,
      displayName: member.display_name,
      role: member.role,
    })),
    comments: commentRows.results.map((comment) => commentView(comment, mentionRows.results)),
    approvals: approvalRows.results.map((approval) => approvalView(approval, decisionRows.results)),
    activity: activityRows.results.map((activity) => ({
      id: activity.id,
      verb: activity.verb,
      summary: activity.summary,
      actorName: activity.actor_name,
      metadata: parseJson(activity.metadata_json),
      createdAt: activity.created_at,
    })),
  });
});

collaborationRoutes.use("/:objectType/:domainId/comments", requireJson);
collaborationRoutes.post("/:objectType/:domainId/comments", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const object = await registeredObject(
    context.env.DB,
    actor.workspaceId,
    projectId,
    context.req.param("objectType"),
    context.req.param("domainId"),
  );
  const input = commentInputSchema.parse(await context.req.json());
  if (input.parentCommentId) {
    const parent = await context.env.DB.prepare(
      "SELECT id FROM comments WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND object_id = ?4 AND archived_at IS NULL",
    )
      .bind(input.parentCommentId, actor.workspaceId, projectId, object.id)
      .first();
    if (!parent)
      throw new HttpError(
        422,
        "invalid_parent_comment",
        "The parent comment is not part of this discussion.",
      );
  }
  const mentioned = await activeMentionedMembers(
    context.env.DB,
    actor.workspaceId,
    projectId,
    input.mentionUserIds,
  );
  const id = createUuidV7();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "INSERT INTO comments (id, workspace_id, project_id, object_id, author_user_id, share_link_id, parent_comment_id, body, resolved_at, resolved_by_user_id, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, NULL, 1, NULL, ?8, ?8)",
    ).bind(
      id,
      actor.workspaceId,
      projectId,
      object.id,
      actor.userId,
      input.parentCommentId ?? null,
      input.body,
      now,
    ),
    activityStatement(
      context.env.DB,
      actor,
      projectId,
      object.id,
      "commented",
      `${actor.displayName} commented on ${object.title ?? object.object_type}.`,
      now,
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "comment.created",
      objectType: object.object_type,
      objectId: object.domain_id,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ];
  for (const member of mentioned) {
    statements.push(
      context.env.DB.prepare(
        "INSERT INTO mentions (id, workspace_id, project_id, comment_id, mentioned_user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(createUuidV7(), actor.workspaceId, projectId, id, member.id, now),
    );
    if (member.id !== actor.userId)
      statements.push(
        notificationStatement(
          context.env.DB,
          actor.workspaceId,
          projectId,
          member.id,
          "mention",
          `${actor.displayName} mentioned you`,
          input.body.slice(0, 240),
          object.object_type,
          object.domain_id,
          now,
        ),
      );
  }
  await context.env.DB.batch(statements);
  const row = await commentById(context.env.DB, actor.workspaceId, projectId, object.id, id);
  return ok(
    context,
    commentView(
      row,
      mentioned.map((member) => ({
        comment_id: id,
        user_id: member.id,
        display_name: member.displayName,
      })),
    ),
    201,
  );
});

collaborationRoutes.use("/:objectType/:domainId/comments/:commentId/resolve", requireJson);
collaborationRoutes.post("/:objectType/:domainId/comments/:commentId/resolve", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const object = await registeredObject(
    context.env.DB,
    actor.workspaceId,
    projectId,
    context.req.param("objectType"),
    context.req.param("domainId"),
  );
  const input = z
    .object({ resolved: z.boolean() })
    .strict()
    .parse(await context.req.json());
  const expected = parseIfMatch(context.req.header("If-Match"));
  const commentId = objectIdSchema.parse(context.req.param("commentId"));
  const current = await commentById(
    context.env.DB,
    actor.workspaceId,
    projectId,
    object.id,
    commentId,
  );
  const guard = versionGuard(
    context.env.DB,
    "comments",
    commentId,
    actor.workspaceId,
    projectId,
    expected,
  );
  const now = Date.now();
  try {
    await context.env.DB.batch([
      guard.insert,
      context.env.DB.prepare(
        "UPDATE comments SET resolved_at = ?1, resolved_by_user_id = ?2, updated_at = ?3, version = version + 1 WHERE id = ?4 AND workspace_id = ?5 AND project_id = ?6 AND object_id = ?7",
      ).bind(
        input.resolved ? now : null,
        input.resolved ? actor.userId : null,
        now,
        commentId,
        actor.workspaceId,
        projectId,
        object.id,
      ),
      activityStatement(
        context.env.DB,
        actor,
        projectId,
        object.id,
        input.resolved ? "comment_resolved" : "comment_reopened",
        `${actor.displayName} ${input.resolved ? "resolved" : "reopened"} a comment.`,
        now,
      ),
      guard.remove,
    ]);
  } catch (error) {
    if (isConstraintError(error))
      throw new HttpError(409, "version_conflict", "The comment changed in another session.", {
        expectedVersion: expected,
        currentVersion: current.version,
      });
    throw error;
  }
  return ok(
    context,
    commentView(
      await commentById(context.env.DB, actor.workspaceId, projectId, object.id, commentId),
      [],
    ),
  );
});

collaborationRoutes.use("/:objectType/:domainId/approvals", requireJson);
collaborationRoutes.post("/:objectType/:domainId/approvals", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredParam(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const object = await registeredObject(
    context.env.DB,
    actor.workspaceId,
    projectId,
    context.req.param("objectType"),
    context.req.param("domainId"),
  );
  const input = approvalInputSchema.parse(await context.req.json());
  if (input.approverUserId === actor.userId && !input.selfApprovalAllowed)
    throw new HttpError(
      422,
      "self_approval_not_allowed",
      "Choose another approver or explicitly allow self-approval.",
    );
  const [approver] = await activeMentionedMembers(context.env.DB, actor.workspaceId, projectId, [
    input.approverUserId,
  ]);
  if (!approver)
    throw new HttpError(422, "invalid_approver", "The approver is not an active project member.");
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: `user:${actor.userId}`,
    operation: "approval.request",
    key: context.req.header("Idempotency-Key"),
    requestBody: { projectId, objectId: object.id, ...input },
  });
  if (lease.replayRef)
    return ok(
      context,
      approvalView(
        await approvalById(
          context.env.DB,
          actor.workspaceId,
          projectId,
          object.id,
          lease.replayRef,
        ),
        [],
      ),
    );
  const id = createUuidV7();
  const registryId = createUuidV7();
  const now = Date.now();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO approvals (id, workspace_id, project_id, object_id, title, status, summary, owner_user_id, approver_user_id, pinned_version_id, requested_at, due_at, self_approval_allowed, details_json, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'requested', ?6, ?7, ?8, ?9, ?10, ?11, ?12, '{}', 1, NULL, ?10, ?10)",
      ).bind(
        id,
        actor.workspaceId,
        projectId,
        object.id,
        input.title,
        input.summary || null,
        actor.userId,
        input.approverUserId,
        input.pinnedVersionId ?? null,
        now,
        input.dueAt ?? null,
        input.selfApprovalAllowed ? 1 : 0,
      ),
      context.env.DB.prepare(
        "INSERT INTO object_registry (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version, archived_at, created_at, updated_at) VALUES (?1, ?2, ?3, 'approval', 'approvals', ?4, ?5, 1, NULL, ?6, ?6)",
      ).bind(registryId, actor.workspaceId, projectId, id, input.title, now),
      activityStatement(
        context.env.DB,
        actor,
        projectId,
        object.id,
        "approval_requested",
        `${actor.displayName} requested approval from ${approver.displayName}.`,
        now,
        registryId,
      ),
      notificationStatement(
        context.env.DB,
        actor.workspaceId,
        projectId,
        approver.id,
        "approval_requested",
        `Approval requested: ${input.title}`,
        input.summary || `Requested by ${actor.displayName}.`,
        object.object_type,
        object.domain_id,
        now,
      ),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "approval.requested",
        objectType: object.object_type,
        objectId: object.domain_id,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { approvalId: id, approverUserId: approver.id },
      }),
      completeIdempotentOperation(context.env.DB, lease.id, id, 201),
    ]);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
  return ok(
    context,
    approvalView(
      await approvalById(context.env.DB, actor.workspaceId, projectId, object.id, id),
      [],
    ),
    201,
  );
});

collaborationRoutes.use("/:objectType/:domainId/approvals/:approvalId/decisions", requireJson);
collaborationRoutes.post(
  "/:objectType/:domainId/approvals/:approvalId/decisions",
  async (context) => {
    const actor = context.get("actor");
    const projectId = requiredParam(context.req.param("projectId"));
    await assertProjectAccess(context.env.DB, actor, projectId, "edit");
    const object = await registeredObject(
      context.env.DB,
      actor.workspaceId,
      projectId,
      context.req.param("objectType"),
      context.req.param("domainId"),
    );
    const input = decisionInputSchema.parse(await context.req.json());
    const approvalId = objectIdSchema.parse(context.req.param("approvalId"));
    const approval = await approvalById(
      context.env.DB,
      actor.workspaceId,
      projectId,
      object.id,
      approvalId,
    );
    if (approval.status !== "requested")
      throw new HttpError(
        409,
        "approval_already_decided",
        "This approval already has an immutable decision.",
      );
    if (approval.approver_user_id !== actor.userId && actor.role !== "workspace_owner")
      throw new HttpError(
        403,
        "permission_denied",
        "Only the named approver or workspace owner may decide this approval.",
      );
    if (approval.owner_user_id === actor.userId && approval.self_approval_allowed !== 1)
      throw new HttpError(
        403,
        "self_approval_not_allowed",
        "This approval does not permit self-approval.",
      );
    const lease = await beginIdempotentOperation({
      db: context.env.DB,
      workspaceId: actor.workspaceId,
      actorFingerprint: `user:${actor.userId}`,
      operation: "approval.decision",
      key: context.req.header("Idempotency-Key"),
      requestBody: { projectId, approvalId, ...input },
    });
    if (lease.replayRef)
      return ok(
        context,
        approvalView(
          await approvalById(context.env.DB, actor.workspaceId, projectId, object.id, approvalId),
          await decisionsForApproval(context.env.DB, actor.workspaceId, projectId, approvalId),
        ),
      );
    const decisionId = createUuidV7();
    const now = Date.now();
    try {
      const statements: D1PreparedStatement[] = [
        context.env.DB.prepare(
          "INSERT INTO approval_decisions (id, workspace_id, project_id, approval_id, decision, actor_user_id, comment, pinned_version_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        ).bind(
          decisionId,
          actor.workspaceId,
          projectId,
          approvalId,
          input.decision,
          actor.userId,
          input.comment || null,
          approval.pinned_version_id,
          now,
        ),
        context.env.DB.prepare(
          "UPDATE approvals SET status = ?1, updated_at = ?2, version = version + 1 WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5 AND status = 'requested'",
        ).bind(input.decision, now, approvalId, actor.workspaceId, projectId),
        activityStatement(
          context.env.DB,
          actor,
          projectId,
          object.id,
          "approval_decided",
          `${actor.displayName} marked ${approval.title} as ${input.decision.replaceAll("_", " ")}.`,
          now,
        ),
        auditStatement(context.env.DB, {
          workspaceId: actor.workspaceId,
          projectId,
          actor,
          action: `approval.${input.decision}`,
          objectType: object.object_type,
          objectId: object.domain_id,
          requestId: context.get("requestId"),
          occurredAt: now,
          details: { approvalId, decisionId },
        }),
        completeIdempotentOperation(context.env.DB, lease.id, decisionId),
      ];
      if (approval.owner_user_id && approval.owner_user_id !== actor.userId)
        statements.push(
          notificationStatement(
            context.env.DB,
            actor.workspaceId,
            projectId,
            approval.owner_user_id,
            "approval_decided",
            `Approval ${input.decision.replaceAll("_", " ")}: ${approval.title}`,
            input.comment || `Decision recorded by ${actor.displayName}.`,
            object.object_type,
            object.domain_id,
            now,
          ),
        );
      await context.env.DB.batch(statements);
    } catch (error) {
      await failIdempotentOperation(context.env.DB, lease.id);
      throw error;
    }
    return ok(
      context,
      approvalView(
        await approvalById(context.env.DB, actor.workspaceId, projectId, object.id, approvalId),
        await decisionsForApproval(context.env.DB, actor.workspaceId, projectId, approvalId),
      ),
    );
  },
);

async function registeredObject(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  rawType: string | undefined,
  rawId: string | undefined,
): Promise<RegisteredObject> {
  const objectType = objectTypeSchema.parse(rawType);
  const domainId = objectIdSchema.parse(rawId);
  const row = await db
    .prepare(
      "SELECT id, object_type, domain_id, title FROM object_registry WHERE workspace_id = ?1 AND project_id = ?2 AND object_type = ?3 AND domain_id = ?4 AND archived_at IS NULL LIMIT 1",
    )
    .bind(workspaceId, projectId, objectType, domainId)
    .first<RegisteredObject>();
  if (!row)
    throw new HttpError(404, "object_not_found", "The requested project object was not found.");
  return row;
}

async function activeMentionedMembers(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  userIds: readonly string[],
): Promise<Array<{ id: string; displayName: string }>> {
  const uniqueIds = [...new Set(userIds)];
  const members: Array<{ id: string; displayName: string }> = [];
  for (const userId of uniqueIds) {
    const member = await db
      .prepare(
        "SELECT u.id, u.display_name FROM project_memberships pm JOIN user_identities u ON u.id = pm.user_id AND u.workspace_id = pm.workspace_id WHERE pm.workspace_id = ?1 AND pm.project_id = ?2 AND pm.user_id = ?3 AND pm.status = 'active' AND u.status = 'active' LIMIT 1",
      )
      .bind(workspaceId, projectId, userId)
      .first<{ id: string; display_name: string }>();
    if (!member)
      throw new HttpError(
        422,
        "invalid_project_member",
        "A selected person is not an active project member.",
      );
    members.push({ id: member.id, displayName: member.display_name });
  }
  return members;
}

async function commentById(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  objectRegistryId: string,
  commentId: string,
): Promise<CommentRow> {
  const row = await db
    .prepare(
      "SELECT c.id, c.body, c.parent_comment_id, c.author_user_id, u.display_name AS author_name, c.resolved_at, ru.display_name AS resolved_by_name, c.version, c.created_at, c.updated_at FROM comments c LEFT JOIN user_identities u ON u.id = c.author_user_id LEFT JOIN user_identities ru ON ru.id = c.resolved_by_user_id WHERE c.id = ?1 AND c.workspace_id = ?2 AND c.project_id = ?3 AND c.object_id = ?4 AND c.archived_at IS NULL LIMIT 1",
    )
    .bind(commentId, workspaceId, projectId, objectRegistryId)
    .first<CommentRow>();
  if (!row) throw new HttpError(404, "comment_not_found", "The comment was not found.");
  return row;
}

async function approvalById(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  objectRegistryId: string,
  approvalId: string,
): Promise<ApprovalRow> {
  const row = await db
    .prepare(
      "SELECT a.id, a.title, a.status, a.summary, a.owner_user_id, owner.display_name AS owner_name, a.approver_user_id, approver.display_name AS approver_name, a.pinned_version_id, a.requested_at, a.due_at, a.self_approval_allowed, a.version, a.created_at, a.updated_at FROM approvals a LEFT JOIN user_identities owner ON owner.id = a.owner_user_id LEFT JOIN user_identities approver ON approver.id = a.approver_user_id WHERE a.id = ?1 AND a.workspace_id = ?2 AND a.project_id = ?3 AND a.object_id = ?4 AND a.archived_at IS NULL LIMIT 1",
    )
    .bind(approvalId, workspaceId, projectId, objectRegistryId)
    .first<ApprovalRow>();
  if (!row) throw new HttpError(404, "approval_not_found", "The approval was not found.");
  return row;
}

async function decisionsForApproval(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  approvalId: string,
) {
  const rows = await db
    .prepare(
      "SELECT d.id, d.approval_id, d.decision, d.comment, d.pinned_version_id, d.created_at, u.display_name AS actor_name FROM approval_decisions d LEFT JOIN user_identities u ON u.id = d.actor_user_id WHERE d.workspace_id = ?1 AND d.project_id = ?2 AND d.approval_id = ?3 ORDER BY d.created_at, d.id",
    )
    .bind(workspaceId, projectId, approvalId)
    .all<{
      id: string;
      approval_id: string;
      decision: string;
      comment: string | null;
      pinned_version_id: string | null;
      created_at: number;
      actor_name: string | null;
    }>();
  return rows.results;
}

function commentView(
  row: CommentRow,
  mentions: readonly { comment_id: string; user_id: string; display_name: string }[],
) {
  return {
    id: row.id,
    body: row.body,
    parentCommentId: row.parent_comment_id,
    authorUserId: row.author_user_id,
    authorName: row.author_name ?? "External collaborator",
    resolvedAt: row.resolved_at,
    resolvedByName: row.resolved_by_name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mentions: mentions
      .filter((mention) => mention.comment_id === row.id)
      .map((mention) => ({ userId: mention.user_id, displayName: mention.display_name })),
  };
}

function approvalView(
  row: ApprovalRow,
  decisions: readonly {
    id: string;
    approval_id: string;
    decision: string;
    comment: string | null;
    pinned_version_id: string | null;
    created_at: number;
    actor_name: string | null;
  }[],
) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    approverUserId: row.approver_user_id,
    approverName: row.approver_name,
    pinnedVersionId: row.pinned_version_id,
    requestedAt: row.requested_at,
    dueAt: row.due_at,
    selfApprovalAllowed: row.self_approval_allowed === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decisions: decisions
      .filter((decision) => decision.approval_id === row.id)
      .map((decision) => ({
        id: decision.id,
        decision: decision.decision,
        comment: decision.comment,
        pinnedVersionId: decision.pinned_version_id,
        actorName: decision.actor_name ?? "External approver",
        createdAt: decision.created_at,
      })),
  };
}

function activityStatement(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  objectId: string,
  verb: string,
  summary: string,
  createdAt: number,
  secondaryObjectId?: string,
) {
  return db
    .prepare(
      "INSERT INTO activities (id, workspace_id, project_id, actor_user_id, actor_type, verb, object_id, secondary_object_id, summary, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, 'user', ?5, ?6, ?7, ?8, '{}', ?9)",
    )
    .bind(
      createUuidV7(),
      actor.workspaceId,
      projectId,
      actor.userId,
      verb,
      objectId,
      secondaryObjectId ?? null,
      summary,
      createdAt,
    );
}

function notificationStatement(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  recipientId: string,
  type: string,
  title: string,
  body: string,
  objectType: string,
  objectId: string,
  createdAt: number,
) {
  return db
    .prepare(
      "INSERT INTO notifications (id, workspace_id, project_id, recipient_user_id, type, title, body, object_type, object_id, created_at, read_at, archived_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)",
    )
    .bind(
      createUuidV7(),
      workspaceId,
      projectId,
      recipientId,
      type,
      title,
      body,
      objectType,
      objectId,
      createdAt,
    );
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

function requiredParam(value: string | undefined): string {
  if (!value) throw new HttpError(404, "route_not_found", "A required route parameter is missing.");
  return value;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL/iu.test(error.message);
}
