import { DomainError } from "./errors";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalize(value: JsonValue, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError("INVALID_INPUT", "Canonical JSON cannot contain a non-finite number.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (ancestors.has(value)) {
    throw new DomainError("INVALID_INPUT", "Canonical JSON cannot contain a cycle.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }

    const entries = Object.keys(value)
      .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue, ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON serialization used for hashes and immutable-record comparisons. */
export function canonicalJson(value: JsonValue): string {
  return canonicalize(value, new Set());
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  // Copy into an owned ArrayBuffer so DOM and Workers type definitions cannot infer SharedArrayBuffer.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashCanonicalJson(value: JsonValue): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
