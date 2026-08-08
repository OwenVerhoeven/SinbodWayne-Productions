import type { JsonValue } from "./canonical";
import { sha256Hex } from "./canonical";
import { DomainError } from "./errors";

export interface IdempotencyRecord {
  readonly keyHash: string;
  readonly scope: string;
  readonly requestHash: string;
  readonly state: "pending" | "completed";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly response?: JsonValue;
}

export async function hashIdempotencyKey(key: string): Promise<string> {
  if (key.length < 16 || key.length > 200 || /[^\x21-\x7e]/.test(key)) {
    throw new DomainError(
      "INVALID_INPUT",
      "Idempotency key must be 16–200 printable ASCII characters.",
    );
  }
  return sha256Hex(key);
}

export type IdempotencyBeginResult =
  | { readonly action: "execute"; readonly record: IdempotencyRecord }
  | { readonly action: "pending"; readonly record: IdempotencyRecord }
  | { readonly action: "replay"; readonly response: JsonValue; readonly record: IdempotencyRecord };

export function beginIdempotentOperation(input: {
  readonly existing?: IdempotencyRecord;
  readonly keyHash: string;
  readonly scope: string;
  readonly requestHash: string;
  readonly now: number;
  readonly expiresAt: number;
}): IdempotencyBeginResult {
  if (!/^[0-9a-f]{64}$/.test(input.keyHash) || !/^[0-9a-f]{64}$/.test(input.requestHash)) {
    throw new DomainError(
      "INVALID_INPUT",
      "Idempotency and request hashes must be SHA-256 hex strings.",
    );
  }
  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.now
  ) {
    throw new DomainError("INVALID_INPUT", "Idempotency timestamps are invalid.");
  }
  const existing = input.existing;
  if (existing === undefined || existing.expiresAt <= input.now) {
    return {
      action: "execute",
      record: {
        keyHash: input.keyHash,
        scope: input.scope,
        requestHash: input.requestHash,
        state: "pending",
        createdAt: input.now,
        expiresAt: input.expiresAt,
      },
    };
  }
  if (
    existing.keyHash !== input.keyHash ||
    existing.scope !== input.scope ||
    existing.requestHash !== input.requestHash
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used for a different operation.",
    );
  }
  if (existing.state === "completed") {
    if (existing.response === undefined) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Completed idempotency record has no replay response.",
      );
    }
    return { action: "replay", response: existing.response, record: existing };
  }
  return { action: "pending", record: existing };
}

export function completeIdempotentOperation(
  record: IdempotencyRecord,
  response: JsonValue,
): IdempotencyRecord {
  if (record.state !== "pending") {
    throw new DomainError(
      "IMMUTABLE_RECORD",
      "Completed idempotency responses cannot be replaced.",
    );
  }
  return { ...record, state: "completed", response };
}
