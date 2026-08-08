import { z } from "zod";

import { DomainError } from "./errors";

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const opaqueIdSchema = z
  .string()
  .refine((value) => uuidV7Pattern.test(value) || ulidPattern.test(value), {
    message: "Expected a UUIDv7 or canonical ULID.",
  })
  .brand<"OpaqueId">();

export type OpaqueId = z.infer<typeof opaqueIdSchema>;

export const objectTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const objectRefSchema = z
  .object({
    workspaceId: opaqueIdSchema,
    projectId: opaqueIdSchema.optional(),
    objectType: objectTypeSchema,
    objectId: opaqueIdSchema,
  })
  .strict();

export type ObjectRef = z.infer<typeof objectRefSchema>;

export function assertSameTenant(
  reference: ObjectRef,
  workspaceId: OpaqueId,
  projectId?: OpaqueId,
): void {
  if (reference.workspaceId !== workspaceId) {
    throw new DomainError("AUTHORIZATION_DENIED", "Object reference belongs to another workspace.");
  }
  if (projectId !== undefined && reference.projectId !== projectId) {
    throw new DomainError("AUTHORIZATION_DENIED", "Object reference belongs to another project.");
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministically builds a UUIDv7 from an explicit timestamp and ten random bytes.
 * Runtime callers remain responsible for sourcing those bytes from crypto.getRandomValues.
 */
export function uuidV7From(timestampMs: number, random: Uint8Array): OpaqueId {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
    throw new DomainError("INVALID_INPUT", "UUIDv7 timestamp must fit the unsigned 48-bit field.");
  }
  if (random.byteLength !== 10) {
    throw new DomainError("INVALID_INPUT", "UUIDv7 requires exactly ten random bytes.");
  }

  const bytes = new Uint8Array(16);
  let remaining = BigInt(timestampMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = 0x70 | (random[0]! & 0x0f);
  bytes[7] = random[1]!;
  bytes[8] = 0x80 | (random[2]! & 0x3f);
  bytes.set(random.subarray(3), 9);

  const encoded = `${hex(bytes.subarray(0, 4))}-${hex(bytes.subarray(4, 6))}-${hex(
    bytes.subarray(6, 8),
  )}-${hex(bytes.subarray(8, 10))}-${hex(bytes.subarray(10, 16))}`;
  return opaqueIdSchema.parse(encoded);
}

export function createUuidV7(now: () => number = Date.now): OpaqueId {
  const random = crypto.getRandomValues(new Uint8Array(10));
  return uuidV7From(now(), random);
}
