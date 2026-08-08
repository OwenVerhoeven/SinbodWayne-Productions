import { HttpError } from "../http/errors";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const KDF_NAME = "pbkdf2-sha256";
const KDF_ITERATIONS = 600_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
const encoder = new TextEncoder();
const commonPasswords = new Set([
  "password",
  "password123",
  "qwerty123",
  "letmein123",
  "welcome123",
  "admin123",
]);

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes))),
  );
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations = KDF_ITERATIONS,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(encoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: asArrayBuffer(salt), iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function encodePassword(
  password: string,
): Promise<{ encodedHash: string; kdf: string; parameters: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt);
  return {
    encodedHash: `${KDF_NAME}$i=${KDF_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`,
    kdf: KDF_NAME,
    parameters: JSON.stringify({
      iterations: KDF_ITERATIONS,
      hash: "SHA-256",
      saltBytes: SALT_BYTES,
      outputBytes: HASH_BYTES,
    }),
  };
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 4 || parts[0] !== KDF_NAME || !parts[1]?.startsWith("i=")) return false;
  const iterations = Number(parts[1].slice(2));
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000 ||
    iterations > 2_000_000 ||
    !parts[2] ||
    !parts[3]
  )
    return false;
  try {
    const expected = base64UrlDecode(parts[3]);
    const actual = await derive(password, base64UrlDecode(parts[2]), iterations);
    if (expected.byteLength !== actual.byteLength) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch {
    return false;
  }
}

export async function performDummyPasswordWork(password: string): Promise<void> {
  const salt = encoder.encode("swp-unknown-user").slice(0, SALT_BYTES);
  const actual = await derive(password, salt);
  const expected = new Uint8Array(HASH_BYTES);
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function validateNewPassword(password: string, username: string): void {
  const scalarLength = [...password].length;
  const byteLength = encoder.encode(password).byteLength;
  if (scalarLength < 15 || scalarLength > 128 || byteLength > 1024) {
    throw new HttpError(422, "password_policy", "Choose a password between 15 and 128 characters.");
  }
  const normalized = password.normalize("NFKC").toLocaleLowerCase("en-GB");
  if (commonPasswords.has(normalized) || normalized.includes(username.toLocaleLowerCase("en-GB"))) {
    throw new HttpError(422, "password_policy", "Choose a less predictable password.");
  }
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  return timingSafeEqual(
    Buffer.from(base64UrlDecode(leftHash)),
    Buffer.from(base64UrlDecode(rightHash)),
  );
}
