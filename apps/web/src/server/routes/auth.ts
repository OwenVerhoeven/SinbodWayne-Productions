import { createUuidV7 } from "@swp/domain";
import { Hono } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import {
  encodePassword,
  performDummyPasswordWork,
  sha256,
  validateNewPassword,
  verifyPassword,
} from "../auth/crypto";
import {
  clearSessionCookie,
  createSession,
  findActor,
  requireActor,
  requireCsrf,
  setSessionCookie,
} from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";

const loginSchema = z
  .object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) })
  .strict();
const ownerRecoverySchema = z
  .object({
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    password: z.string().min(1).max(1024),
  })
  .strict();
const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

interface LoginIdentityRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly username: string;
  readonly display_name: string;
  readonly role: "workspace_owner" | "producer";
  readonly auth_epoch: number;
  readonly status: string;
  readonly encoded_hash: string;
}

interface LoginAttemptRow {
  readonly fail_count: number;
  readonly blocked_until: number;
}

interface OwnerRecoveryRow {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly previous_credential_id: string;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.use("/owner-recovery", requireSameOrigin, requireJson);

authRoutes.post("/owner-recovery", async (context) => {
  const input = ownerRecoverySchema.parse(await context.req.json());
  if (new TextEncoder().encode(input.password).byteLength > 1024) {
    throw new HttpError(422, "recovery_input_invalid", "The recovery input is invalid.");
  }
  const ip = context.req.header("CF-Connecting-IP") ?? "unknown";
  const rateKey = await sha256(`${ip}\u0000owner-recovery`);
  const rate = await context.env.PUBLIC_RATE_LIMITER.limit({ key: rateKey.slice(0, 64) });
  if (!rate.success) {
    throw new HttpError(429, "recovery_unavailable", "Owner recovery is temporarily unavailable.");
  }

  const now = Date.now();
  const challengeDigest = await sha256(input.challenge);
  const operation = await context.env.DB.prepare(
    `SELECT bo.id AS operation_id,
            bo.workspace_id,
            u.id AS owner_id,
            u.current_password_credential_id AS previous_credential_id
       FROM bootstrap_operations bo
       JOIN user_identities u
         ON u.workspace_id = bo.workspace_id
        AND u.username = 'SinbodWayne' COLLATE BINARY
        AND u.role = 'workspace_owner'
        AND u.status = 'active'
        AND u.archived_at IS NULL
       JOIN workspace_memberships wm
         ON wm.workspace_id = u.workspace_id
        AND wm.user_id = u.id
        AND wm.role = 'workspace_owner'
        AND wm.status = 'active'
        AND wm.archived_at IS NULL
       JOIN password_credentials pc
         ON pc.id = u.current_password_credential_id
        AND pc.user_id = u.id
        AND pc.superseded_at IS NULL
      WHERE bo.challenge_digest = ?1
        AND bo.state = 'created'
        AND bo.expires_at > ?2
        AND (SELECT COUNT(*)
               FROM user_identities manifest_user
              WHERE manifest_user.workspace_id = bo.workspace_id
                AND manifest_user.status = 'active'
                AND manifest_user.archived_at IS NULL) = 2
        AND (SELECT COUNT(*)
               FROM user_identities manifest_user
              WHERE manifest_user.workspace_id = bo.workspace_id
                AND manifest_user.status = 'active'
                AND manifest_user.archived_at IS NULL
                AND manifest_user.username IN ('SinbodWayne', 'KyanWayne')) = 2
      LIMIT 1`,
  )
    .bind(challengeDigest, now)
    .first<OwnerRecoveryRow>();
  if (!operation) {
    await performDummyPasswordWork(input.password, context.env.AUTH_PEPPER);
    throw new HttpError(404, "recovery_not_available", "Owner recovery is not available.");
  }

  const credential = await encodePassword(input.password, context.env.AUTH_PEPPER);
  const credentialId = createUuidV7();
  const guardId = createUuidV7();
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at)
         SELECT ?1, 1,
           CASE WHEN EXISTS (
             SELECT 1
               FROM bootstrap_operations bo
               JOIN user_identities u
                 ON u.workspace_id = bo.workspace_id
                AND u.id = ?3
                AND u.current_password_credential_id = ?4
                AND u.status = 'active'
                AND u.archived_at IS NULL
               JOIN password_credentials pc
                 ON pc.id = u.current_password_credential_id
                AND pc.user_id = u.id
                AND pc.superseded_at IS NULL
              WHERE bo.id = ?2
                AND bo.state = 'created'
                AND bo.expires_at > ?5
           ) THEN 1 ELSE 0 END,
           ?5`,
      ).bind(
        guardId,
        operation.operation_id,
        operation.owner_id,
        operation.previous_credential_id,
        now,
      ),
      context.env.DB.prepare(
        `UPDATE password_credentials
            SET superseded_at = ?1
          WHERE id = ?2
            AND workspace_id = ?3
            AND user_id = ?4
            AND superseded_at IS NULL`,
      ).bind(now, operation.previous_credential_id, operation.workspace_id, operation.owner_id),
      context.env.DB.prepare(
        `INSERT INTO password_credentials
          (id, workspace_id, user_id, kdf, parameters_json, encoded_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        credentialId,
        operation.workspace_id,
        operation.owner_id,
        credential.kdf,
        credential.parameters,
        credential.encodedHash,
        now,
      ),
      context.env.DB.prepare(
        `UPDATE user_identities
            SET current_password_credential_id = ?1,
                auth_epoch = auth_epoch + 1,
                failed_login_count = 0,
                backoff_until = NULL,
                updated_at = ?2,
                version = version + 1
          WHERE id = ?3
            AND workspace_id = ?4
            AND current_password_credential_id = ?5
            AND status = 'active'
            AND archived_at IS NULL`,
      ).bind(
        credentialId,
        now,
        operation.owner_id,
        operation.workspace_id,
        operation.previous_credential_id,
      ),
      context.env.DB.prepare(
        `UPDATE sessions
            SET revoked_at = ?1,
                revoke_reason = COALESCE(revoke_reason, 'owner_credential_recovery')
          WHERE workspace_id = ?2
            AND user_id = ?3
            AND revoked_at IS NULL`,
      ).bind(now, operation.workspace_id, operation.owner_id),
      context.env.DB.prepare(
        `UPDATE bootstrap_operations
            SET state = 'consumed', consumed_at = ?1
          WHERE id = ?2 AND state = 'created' AND expires_at > ?1`,
      ).bind(now, operation.operation_id),
      auditStatement(context.env.DB, {
        workspaceId: operation.workspace_id,
        action: "auth.owner_credential_recovered",
        objectType: "user_identity",
        objectId: operation.owner_id,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { source: "one_time_challenge", sessionsRevoked: true },
      }),
      context.env.DB.prepare("DELETE FROM optimistic_mutation_guards WHERE id = ?1").bind(guardId),
    ]);
  } catch {
    throw new HttpError(
      409,
      "recovery_conflict",
      "Owner recovery could not be applied to the current account state.",
    );
  }

  return ok(context, { recovered: true as const });
});

authRoutes.use("/login", requireSameOrigin, requireJson);

authRoutes.post("/login", async (context) => {
  const input = loginSchema.parse(await context.req.json());
  const ip = context.req.header("CF-Connecting-IP") ?? "unknown";
  const rateKey = await sha256(`${ip}\u0000${input.username}`);
  const rate = await context.env.LOGIN_RATE_LIMITER.limit({ key: rateKey.slice(0, 64) });
  if (!rate.success) {
    throw new HttpError(
      429,
      "sign_in_unavailable",
      "Sign-in is temporarily unavailable. Try again shortly.",
    );
  }

  const attempt = await context.env.DB.prepare(
    "SELECT fail_count, blocked_until FROM login_attempts WHERE key_hash = ?1 LIMIT 1",
  )
    .bind(rateKey)
    .first<LoginAttemptRow>();
  const now = Date.now();
  if (attempt && attempt.blocked_until > now) {
    await performDummyPasswordWork(input.password, context.env.AUTH_PEPPER);
    throw new HttpError(
      429,
      "sign_in_unavailable",
      "Sign-in is temporarily unavailable. Try again shortly.",
    );
  }

  const identity = await context.env.DB.prepare(
    `SELECT u.id, u.workspace_id, u.username, u.display_name, wm.role, u.auth_epoch, u.status, pc.encoded_hash
       FROM user_identities u
       JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = u.workspace_id
       JOIN password_credentials pc ON pc.id = u.current_password_credential_id AND pc.user_id = u.id
      WHERE u.username = ?1 COLLATE BINARY
        AND wm.status = 'active'
      LIMIT 1`,
  )
    .bind(input.username)
    .first<LoginIdentityRow>();

  const passwordValid = identity
    ? await verifyPassword(input.password, identity.encoded_hash, context.env.AUTH_PEPPER)
    : (await performDummyPasswordWork(input.password, context.env.AUTH_PEPPER), false);
  if (!identity || identity.status !== "active" || !passwordValid) {
    const failures = Math.min((attempt?.fail_count ?? 0) + 1, 20);
    const delay = failures < 3 ? 0 : Math.min(300_000, 1_000 * 2 ** Math.min(failures - 3, 8));
    const statements = [
      context.env.DB.prepare(
        `INSERT INTO login_attempts (key_hash, fail_count, blocked_until, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(key_hash) DO UPDATE SET fail_count = excluded.fail_count, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`,
      ).bind(rateKey, failures, now + delay, now),
    ];
    if (identity) {
      statements.push(
        auditStatement(context.env.DB, {
          workspaceId: identity.workspace_id,
          action: "auth.login_failed",
          objectType: "user_identity",
          objectId: identity.id,
          requestId: context.get("requestId"),
          details: { keyHash: rateKey },
        }),
      );
    }
    await context.env.DB.batch(statements);
    throw new HttpError(401, "invalid_credentials", "The username or password is incorrect.");
  }

  let session: Awaited<ReturnType<typeof createSession>>;
  let ipHash: string;
  try {
    session = await createSession(context);
    ipHash = await sha256(ip);
  } catch {
    throw new HttpError(500, "session_material_failed", "A secure session could not be created.");
  }
  const deviceLabel = describeDevice(context.req.header("User-Agent"));
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO sessions
        (id, user_id, workspace_id, token_hash, csrf_hash, auth_epoch, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, device_label, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, NULL, ?10, ?11)`,
      ).bind(
        session.id,
        identity.id,
        identity.workspace_id,
        session.tokenHash,
        session.csrfHash,
        identity.auth_epoch,
        session.createdAt,
        session.idleExpiresAt,
        session.absoluteExpiresAt,
        deviceLabel,
        ipHash,
      ),
      context.env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?1").bind(rateKey),
      auditStatement(context.env.DB, {
        workspaceId: identity.workspace_id,
        action: "auth.login_succeeded",
        objectType: "session",
        objectId: session.id,
        requestId: context.get("requestId"),
        occurredAt: session.createdAt,
        details: { deviceLabel },
      }),
    ]);
  } catch {
    throw new HttpError(
      500,
      "session_persistence_failed",
      "The secure session could not be stored.",
    );
  }
  setSessionCookie(context, session.token);
  return ok(context, sessionView(identity, session.csrfToken, session.absoluteExpiresAt));
});

authRoutes.get("/session", async (context) => {
  const actor = await findActor(context);
  if (!actor) {
    clearSessionCookie(context);
    return ok(context, { authenticated: false as const });
  }
  const csrfToken = await rotateCsrf(context, actor.sessionId);
  return ok(
    context,
    sessionView(
      actor,
      csrfToken.token,
      Date.now() + Number(context.env.SESSION_IDLE_SECONDS) * 1000,
    ),
  );
});

authRoutes.use("/logout", requireActor, requireSameOrigin, requireJson, requireCsrf);
authRoutes.post("/logout", async (context) => {
  const actor = context.get("actor");
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
    ).bind(now, actor.sessionId),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      actor,
      action: "auth.logout",
      objectType: "session",
      objectId: actor.sessionId,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  clearSessionCookie(context);
  return ok(context, { revoked: true as const });
});

authRoutes.use("/password", requireActor, requireSameOrigin, requireJson, requireCsrf);
authRoutes.post("/password", async (context) => {
  const actor = context.get("actor");
  const input = passwordChangeSchema.parse(await context.req.json());
  validateNewPassword(input.newPassword, actor.username);
  const credential = await context.env.DB.prepare(
    `SELECT pc.encoded_hash
       FROM user_identities u
       JOIN password_credentials pc ON pc.id = u.current_password_credential_id
      WHERE u.id = ?1 AND u.workspace_id = ?2 LIMIT 1`,
  )
    .bind(actor.userId, actor.workspaceId)
    .first<{ encoded_hash: string }>();
  if (
    !credential ||
    !(await verifyPassword(input.currentPassword, credential.encoded_hash, context.env.AUTH_PEPPER))
  ) {
    throw new HttpError(401, "invalid_credentials", "The current password is incorrect.");
  }
  const next = await encodePassword(input.newPassword, context.env.AUTH_PEPPER);
  const credentialId = createUuidV7();
  const session = await createSession(context);
  const now = Date.now();
  const nextEpoch = actor.authEpoch + 1;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO password_credentials (id, workspace_id, user_id, kdf, parameters_json, encoded_hash, created_at, superseded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
    ).bind(
      credentialId,
      actor.workspaceId,
      actor.userId,
      next.kdf,
      next.parameters,
      next.encodedHash,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE password_credentials SET superseded_at = ?1 WHERE user_id = ?2 AND id <> ?3 AND superseded_at IS NULL",
    ).bind(now, actor.userId, credentialId),
    context.env.DB.prepare(
      "UPDATE user_identities SET current_password_credential_id = ?1, auth_epoch = ?2, updated_at = ?3, version = version + 1 WHERE id = ?4 AND workspace_id = ?5",
    ).bind(credentialId, nextEpoch, now, actor.userId, actor.workspaceId),
    context.env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL",
    ).bind(now, actor.userId),
    context.env.DB.prepare(
      `INSERT INTO sessions
        (id, user_id, workspace_id, token_hash, csrf_hash, auth_epoch, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, device_label, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, NULL, 'Password change', ?10)`,
    ).bind(
      session.id,
      actor.userId,
      actor.workspaceId,
      session.tokenHash,
      session.csrfHash,
      nextEpoch,
      now,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
      await sha256(context.req.header("CF-Connecting-IP") ?? "unknown"),
    ),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      actor,
      action: "auth.password_changed",
      objectType: "user_identity",
      objectId: actor.userId,
      requestId: context.get("requestId"),
      occurredAt: now,
    }),
  ]);
  setSessionCookie(context, session.token);
  return ok(context, sessionView(actor, session.csrfToken, session.absoluteExpiresAt));
});

function sessionView(
  identity:
    | Pick<LoginIdentityRow, "id" | "workspace_id" | "username" | "display_name" | "role">
    | {
        userId: string;
        workspaceId: string;
        username: string;
        displayName: string;
        role: "workspace_owner" | "producer";
      },
  csrfToken: string,
  expiresAt: number,
) {
  const row =
    "id" in identity
      ? {
          id: identity.id,
          workspaceId: identity.workspace_id,
          username: identity.username,
          displayName: identity.display_name,
          role: identity.role,
        }
      : {
          id: identity.userId,
          workspaceId: identity.workspaceId,
          username: identity.username,
          displayName: identity.displayName,
          role: identity.role,
        };
  return { authenticated: true as const, account: row, csrfToken, expiresAt };
}

async function rotateCsrf(
  context: Parameters<typeof findActor>[0],
  sessionId: string,
): Promise<{ token: string }> {
  const token = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of token) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  await context.env.DB.prepare(
    "UPDATE sessions SET csrf_hash = ?1 WHERE id = ?2 AND revoked_at IS NULL",
  )
    .bind(await sha256(encoded), sessionId)
    .run();
  return { token: encoded };
}

function describeDevice(userAgent?: string): string {
  if (!userAgent) return "Unknown browser";
  const browser = /Firefox/u.test(userAgent)
    ? "Firefox"
    : /Edg\//u.test(userAgent)
      ? "Edge"
      : /Chrome\//u.test(userAgent)
        ? "Chrome"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /Windows/u.test(userAgent)
    ? "Windows"
    : /Mac OS/u.test(userAgent)
      ? "macOS"
      : /Android/u.test(userAgent)
        ? "Android"
        : /iPhone|iPad/u.test(userAgent)
          ? "iOS"
          : /Linux/u.test(userAgent)
            ? "Linux"
            : "device";
  return `${browser} on ${system}`;
}
