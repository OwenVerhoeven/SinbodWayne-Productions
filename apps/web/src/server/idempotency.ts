import { createUuidV7 } from "@swp/domain";

import { HttpError } from "./http/errors";

const KEY_PATTERN = /^[A-Za-z0-9._~:+\-/]{16,200}$/u;

export interface IdempotencyLease {
  readonly id: string;
  readonly replayRef?: string;
}

export async function beginIdempotentOperation(input: {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly actorFingerprint: string;
  readonly operation: string;
  readonly key: string | undefined;
  readonly requestBody: unknown;
  readonly now?: number;
}): Promise<IdempotencyLease> {
  if (!input.key || !KEY_PATTERN.test(input.key)) {
    throw new HttpError(
      400,
      "idempotency_key_required",
      "A valid Idempotency-Key header is required.",
    );
  }
  const now = input.now ?? Date.now();
  const [keyDigest, requestHash] = await Promise.all([
    sha256(input.key),
    sha256(stableJson(input.requestBody)),
  ]);
  const id = createUuidV7();
  const insert = await input.db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_records
        (id, workspace_id, actor_fingerprint, operation, idempotency_key_digest, request_hash,
         response_status, response_ref, state, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'running', ?7, ?8, ?8)`,
    )
    .bind(
      id,
      input.workspaceId,
      input.actorFingerprint,
      input.operation,
      keyDigest,
      requestHash,
      now + 24 * 60 * 60 * 1000,
      now,
    )
    .run();
  if (insert.meta.changes === 1) return { id };

  const existing = await input.db
    .prepare(
      `SELECT id, request_hash, response_ref, state, expires_at FROM idempotency_records
        WHERE workspace_id = ?1 AND actor_fingerprint = ?2 AND operation = ?3
          AND idempotency_key_digest = ?4 LIMIT 1`,
    )
    .bind(input.workspaceId, input.actorFingerprint, input.operation, keyDigest)
    .first<{
      id: string;
      request_hash: string;
      response_ref: string | null;
      state: "running" | "completed" | "failed";
      expires_at: number;
    }>();
  if (!existing || existing.expires_at <= now) {
    throw new HttpError(
      409,
      "idempotency_expired",
      "The prior idempotent operation expired; use a new key.",
    );
  }
  if (existing.request_hash !== requestHash) {
    throw new HttpError(
      409,
      "idempotency_mismatch",
      "This idempotency key was already used for different input.",
    );
  }
  if (existing.state === "completed" && existing.response_ref) {
    return { id: existing.id, replayRef: existing.response_ref };
  }
  throw new HttpError(
    409,
    existing.state === "running" ? "operation_in_progress" : "operation_failed",
    existing.state === "running"
      ? "The same operation is still in progress."
      : "The prior operation failed; use a new idempotency key after reviewing its state.",
  );
}

export function completeIdempotentOperation(
  db: D1Database,
  leaseId: string,
  responseRef: string,
  status = 200,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE idempotency_records SET state = 'completed', response_status = ?1, response_ref = ?2,
         updated_at = ?3 WHERE id = ?4 AND state = 'running'`,
    )
    .bind(status, responseRef, Date.now(), leaseId);
}

export async function failIdempotentOperation(db: D1Database, leaseId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE idempotency_records SET state = 'failed', updated_at = ?1 WHERE id = ?2 AND state = 'running'",
    )
    .bind(Date.now(), leaseId)
    .run();
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
