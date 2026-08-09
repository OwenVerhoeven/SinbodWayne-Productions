import type { Context, MiddlewareHandler } from "hono";
import { createUuidV7 } from "@swp/domain";

import { HttpError } from "../http/errors";
import type { ActorContext, AppEnv } from "../http/types";
import { randomToken, safeEqual, sha256 } from "./crypto";

const PRODUCTION_COOKIE = "__Host-swp_session";
const DEVELOPMENT_COOKIE = "swp_dev_session";

interface SessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly workspace_id: string;
  readonly username: string;
  readonly display_name: string;
  readonly role: "workspace_owner" | "producer" | "viewer";
  readonly user_auth_epoch: number;
  readonly session_auth_epoch: number;
  readonly csrf_hash: string;
  readonly last_seen_at: number;
}

export interface NewSession {
  readonly id: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly csrfToken: string;
  readonly csrfHash: string;
  readonly createdAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}

function isProductionRequest(context: Context<AppEnv>): boolean {
  const url = new URL(context.req.url);
  return url.protocol === "https:" && url.hostname === new URL(context.env.APP_ORIGIN).hostname;
}

function cookieName(context: Context<AppEnv>): string {
  return isProductionRequest(context) ? PRODUCTION_COOKIE : DEVELOPMENT_COOKIE;
}

function parseCookies(value?: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function readSessionToken(context: Context<AppEnv>): string | undefined {
  return parseCookies(context.req.header("Cookie")).get(cookieName(context));
}

export function setSessionCookie(context: Context<AppEnv>, token: string): void {
  const secure = isProductionRequest(context) ? "; Secure" : "";
  context.header(
    "Set-Cookie",
    `${cookieName(context)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`,
  );
}

export function clearSessionCookie(context: Context<AppEnv>): void {
  const secure = isProductionRequest(context) ? "; Secure" : "";
  context.header(
    "Set-Cookie",
    `${cookieName(context)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}

export async function createSession(context: Context<AppEnv>): Promise<NewSession> {
  const token = randomToken();
  const csrfToken = randomToken();
  const createdAt = Date.now();
  return {
    id: createUuidV7(),
    token,
    tokenHash: await sha256(token),
    csrfToken,
    csrfHash: await sha256(csrfToken),
    createdAt,
    idleExpiresAt: createdAt + Number(context.env.SESSION_IDLE_SECONDS) * 1000,
    absoluteExpiresAt: createdAt + Number(context.env.SESSION_ABSOLUTE_SECONDS) * 1000,
  };
}

export async function findActor(context: Context<AppEnv>): Promise<ActorContext | undefined> {
  const token = readSessionToken(context);
  if (!token) return undefined;
  const now = Date.now();
  const row = await context.env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.workspace_id, s.csrf_hash,
            s.auth_epoch AS session_auth_epoch, s.last_seen_at,
            u.username, u.display_name, u.auth_epoch AS user_auth_epoch,
            CASE WHEN u.access_mode = 'viewer' THEN 'viewer' ELSE wm.role END AS role
       FROM sessions s
       JOIN user_identities u ON u.id = s.user_id AND u.workspace_id = s.workspace_id
       JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = s.workspace_id
      WHERE s.token_hash = ?1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > ?2
        AND s.absolute_expires_at > ?2
        AND u.status = 'active'
        AND wm.status = 'active'
      LIMIT 1`,
  )
    .bind(await sha256(token), now)
    .first<SessionRow>();
  if (!row || row.user_auth_epoch !== row.session_auth_epoch) return undefined;

  if (now - row.last_seen_at > 300_000) {
    const idleExpiresAt = now + Number(context.env.SESSION_IDLE_SECONDS) * 1000;
    context.executionCtx.waitUntil(
      context.env.DB.prepare(
        `UPDATE sessions
          SET last_seen_at = ?1,
              idle_expires_at = MIN(absolute_expires_at, ?2)
        WHERE id = ?3 AND revoked_at IS NULL`,
      )
        .bind(now, idleExpiresAt, row.session_id)
        .run()
        .then(() => undefined),
    );
  }

  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    authEpoch: row.user_auth_epoch,
    csrfHash: row.csrf_hash,
    lastSeenAt: row.last_seen_at,
  };
}

export const requireActor: MiddlewareHandler<AppEnv> = async (context, next) => {
  const actor = await findActor(context);
  if (!actor) {
    clearSessionCookie(context);
    throw new HttpError(401, "authentication_required", "Authentication is required.");
  }
  context.set("actor", actor);
  await next();
};

export const requireCsrf: MiddlewareHandler<AppEnv> = async (context, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    await next();
    return;
  }
  const actor = context.get("actor");
  const token = context.req.header("X-CSRF-Token");
  if (!token || !(await safeEqual(await sha256(token), actor.csrfHash))) {
    throw new HttpError(403, "csrf_denied", "The request could not be verified.");
  }
  await next();
};
