import { HttpError } from "../http/errors";

export type SharePurpose =
  "viewer" | "commenter" | "approver" | "candidate" | "call_sheet_recipient";
export type ShareAction = "view" | "comment" | "approve" | "confirm" | "download" | "submit";
export type SupportedShareObjectType =
  | "call_sheet_recipient_issue"
  | "call_sheet_issue"
  | "production_pack_issue"
  | "sides_issue"
  | "report_snapshot"
  | "file_version"
  | "casting_role";

const PURPOSE_ACTIONS: Readonly<Record<SharePurpose, ReadonlySet<ShareAction>>> = {
  viewer: new Set(["view", "download"]),
  commenter: new Set(["view", "comment", "download"]),
  approver: new Set(["view", "comment", "approve", "download"]),
  candidate: new Set(["view", "comment", "submit"]),
  call_sheet_recipient: new Set(["view", "confirm", "download"]),
};

const OBJECT_PURPOSES: Readonly<Record<SupportedShareObjectType, ReadonlySet<SharePurpose>>> = {
  call_sheet_recipient_issue: new Set(["call_sheet_recipient"]),
  call_sheet_issue: new Set(["viewer", "commenter", "approver"]),
  production_pack_issue: new Set(["viewer", "commenter", "approver"]),
  sides_issue: new Set(["viewer", "commenter", "approver"]),
  report_snapshot: new Set(["viewer", "commenter", "approver"]),
  file_version: new Set(["viewer", "commenter", "approver"]),
  casting_role: new Set(["candidate"]),
};

export interface ShareScope {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly publicLocator: string;
  readonly secretDigest: string;
  readonly purpose: SharePurpose;
  readonly objectType: SupportedShareObjectType;
  readonly objectId: string;
  readonly approvalId?: string;
  readonly allowedActions: readonly ShareAction[];
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface PublicSection {
  readonly heading: string;
  readonly body: string;
}

interface SessionPayload {
  readonly token: string;
  readonly csrf: string;
  readonly expiresAt: number;
}

export function isSupportedShareObjectType(value: string): value is SupportedShareObjectType {
  return Object.hasOwn(OBJECT_PURPOSES, value);
}

export function allowedShareActions(
  purpose: SharePurpose,
  requested: readonly ShareAction[],
): ShareAction[] {
  const maximum = PURPOSE_ACTIONS[purpose];
  return [...new Set(requested)].filter((action) => maximum.has(action)).sort();
}

export function assertShareObjectPurpose(
  objectType: SupportedShareObjectType,
  purpose: SharePurpose,
): void {
  if (!OBJECT_PURPOSES[objectType].has(purpose)) {
    throw new HttpError(
      422,
      "invalid_share_scope",
      "This share purpose cannot be used for the selected object.",
    );
  }
}

export function assertShareAvailable(
  scope: ShareScope,
  now: number,
  expectedProjectId?: string,
): void {
  if (scope.revokedAt !== null || scope.expiresAt <= now) throw unavailableShare();
  if (expectedProjectId !== undefined && scope.projectId !== expectedProjectId)
    throw unavailableShare();
}

export function assertShareAction(scope: ShareScope, action: ShareAction): void {
  if (!scope.allowedActions.includes(action)) {
    throw new HttpError(403, "share_scope_denied", "This secure link does not permit that action.");
  }
}

export async function createShareSession(
  scope: Pick<ShareScope, "publicLocator" | "secretDigest" | "expiresAt">,
  now = Date.now(),
): Promise<SessionPayload> {
  const expiresAt = Math.min(scope.expiresAt, now + 15 * 60 * 1000);
  const csrf = randomBase64Url(18);
  const nonce = randomBase64Url(18);
  const payload = `v1.${expiresAt}.${nonce}.${csrf}`;
  const signature = await hmac(scope.secretDigest, `${scope.publicLocator}.${payload}`);
  return { token: `${payload}.${signature}`, csrf, expiresAt };
}

export async function verifyShareSession(
  scope: Pick<ShareScope, "publicLocator" | "secretDigest" | "expiresAt">,
  token: string,
  now = Date.now(),
): Promise<{ csrf: string; expiresAt: number }> {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v1" || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
    throw unavailableShare();
  }
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > scope.expiresAt)
    throw unavailableShare();
  const payload = parts.slice(0, 4).join(".");
  const expected = await hmac(scope.secretDigest, `${scope.publicLocator}.${payload}`);
  if (!(await timingSafeStringEqual(expected, parts[4]))) throw unavailableShare();
  return { csrf: parts[3], expiresAt };
}

export function extractPublicSections(snapshot: unknown): PublicSection[] {
  if (!isRecord(snapshot)) return [];
  const source = Array.isArray(snapshot.sections)
    ? snapshot.sections
    : Array.isArray(snapshot.content)
      ? snapshot.content
      : [];
  const sections: PublicSection[] = [];
  for (const value of source.slice(0, 50)) {
    if (
      !isRecord(value) ||
      value.private === true ||
      value.sensitive === true ||
      value.visibility === "private"
    )
      continue;
    const heading = textField(value.heading ?? value.title, 160);
    const body = textField(value.body ?? value.text ?? value.summary, 10_000);
    if (heading && body) sections.push({ heading, body });
  }
  if (sections.length === 0) {
    const summary = textField(snapshot.summary, 10_000);
    if (summary) sections.push({ heading: "Summary", body: summary });
  }
  return sections;
}

export function parseActions(value: string): ShareAction[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isShareAction);
  } catch {
    return [];
  }
}

export function pinnedVersionId(
  requestedVersionId: string,
  record: { readonly fileId: string; readonly versionId: string },
): string {
  if (record.versionId !== requestedVersionId) throw unavailableShare();
  return record.versionId;
}

export async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", asArrayBuffer(encoder.encode(left))),
    crypto.subtle.digest("SHA-256", asArrayBuffer(encoder.encode(right))),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function unavailableShare(): HttpError {
  return new HttpError(
    404,
    "share_unavailable",
    "This secure link is invalid, expired, revoked, or unavailable.",
  );
}

function isShareAction(value: unknown): value is ShareAction {
  return (
    typeof value === "string" &&
    ["view", "comment", "approve", "confirm", "download", "submit"].includes(value)
  );
}

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmac(base64UrlKey: string, value: string): Promise<string> {
  const keyBytes = decodeBase64Url(base64UrlKey);
  if (keyBytes.byteLength !== 32) throw unavailableShare();
  const key = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    asArrayBuffer(new TextEncoder().encode(value)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw unavailableShare();
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textField(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? [...value]
        .filter((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (code >= 32 && code !== 127) || character === "\n" || character === "\t";
        })
        .slice(0, maximum)
        .join("")
        .trim()
    : "";
}
