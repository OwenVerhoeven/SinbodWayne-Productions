import { HttpError } from "../http/errors";

export const SINGLE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const ZIP_MIME_TYPES = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/xml",
  "application/zip",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/calendar",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/xml",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export interface UploadIntent {
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly mode: "single" | "multipart";
}

export interface StoredObjectEvidence {
  readonly byteSize: number;
  readonly contentType?: string;
  readonly sha256?: string;
  readonly uploadSessionId?: string;
  readonly workspaceId?: string;
  readonly projectId?: string;
}

export function normaliseMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function assertUploadIntent(intent: UploadIntent, configuredMaxBytes: number): void {
  const maximum =
    Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
      ? configuredMaxBytes
      : SINGLE_UPLOAD_MAX_BYTES;
  if (!Number.isSafeInteger(intent.byteSize) || intent.byteSize <= 0 || intent.byteSize > maximum) {
    throw new HttpError(
      413,
      "invalid_file_size",
      `Files must be between 1 byte and ${maximum} bytes.`,
    );
  }
  if (intent.mode === "single" && intent.byteSize > Math.min(maximum, SINGLE_UPLOAD_MAX_BYTES)) {
    throw new HttpError(
      413,
      "file_too_large",
      "The no-subscription storage profile accepts files up to 25 MiB.",
    );
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(normaliseMimeType(intent.mimeType))) {
    throw new HttpError(415, "mime_type_denied", "This file type is not permitted.");
  }
  if (!/^[0-9a-f]{64}$/u.test(intent.sha256)) {
    throw new HttpError(
      422,
      "checksum_required",
      "Provide the lowercase hexadecimal SHA-256 checksum.",
    );
  }
}

export function assertStoredObject(
  evidence: StoredObjectEvidence,
  expected: UploadIntent & {
    readonly uploadSessionId: string;
    readonly workspaceId: string;
    readonly projectId: string;
  },
): void {
  if (evidence.byteSize !== expected.byteSize) {
    throw new HttpError(
      409,
      "upload_size_mismatch",
      "The stored object size does not match the upload authorization.",
    );
  }
  if (normaliseMimeType(evidence.contentType ?? "") !== normaliseMimeType(expected.mimeType)) {
    throw new HttpError(
      409,
      "upload_mime_mismatch",
      "The stored object type does not match the upload authorization.",
    );
  }
  if (evidence.sha256 !== undefined && evidence.sha256 !== expected.sha256) {
    throw new HttpError(
      409,
      "upload_checksum_mismatch",
      "The stored object checksum does not match the expected checksum.",
    );
  }
  if (
    evidence.uploadSessionId !== expected.uploadSessionId ||
    evidence.workspaceId !== expected.workspaceId ||
    evidence.projectId !== expected.projectId
  ) {
    throw new HttpError(
      409,
      "upload_scope_mismatch",
      "The stored object is outside the authorized upload scope.",
    );
  }
}

export function assertFileSignature(mimeType: string, sample: Uint8Array): void {
  const mime = normaliseMimeType(mimeType);
  const starts = (...bytes: number[]) => bytes.every((byte, index) => sample[index] === byte);
  const ascii = (offset: number, value: string) =>
    [...value].every((character, index) => sample[offset + index] === character.charCodeAt(0));

  let valid = true;
  if (mime === "application/pdf") valid = ascii(0, "%PDF-");
  else if (mime === "image/png") valid = starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  else if (mime === "image/jpeg") valid = starts(0xff, 0xd8, 0xff);
  else if (mime === "image/gif") valid = ascii(0, "GIF87a") || ascii(0, "GIF89a");
  else if (mime === "image/webp") valid = ascii(0, "RIFF") && ascii(8, "WEBP");
  else if (mime === "audio/wav") valid = ascii(0, "RIFF") && ascii(8, "WAVE");
  else if (mime === "application/rtf") valid = ascii(0, "{\\rtf");
  else if (
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    valid = starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  } else if (mime === "audio/mpeg") {
    valid = ascii(0, "ID3") || (sample[0] === 0xff && ((sample[1] ?? 0) & 0xe0) === 0xe0);
  } else if (mime === "image/avif") {
    valid = ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"));
  } else if (mime === "video/mp4" || mime === "audio/mp4" || mime === "video/quicktime")
    valid = ascii(4, "ftyp");
  else if (mime === "video/webm") valid = starts(0x1a, 0x45, 0xdf, 0xa3);
  else if (ZIP_MIME_TYPES.has(mime)) {
    valid =
      starts(0x50, 0x4b, 0x03, 0x04) ||
      starts(0x50, 0x4b, 0x05, 0x06) ||
      starts(0x50, 0x4b, 0x07, 0x08);
  } else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("xml")) {
    valid = !sample.includes(0);
  }

  if (!valid) {
    throw new HttpError(
      415,
      "file_signature_mismatch",
      "The file contents do not match the declared type.",
    );
  }
}

export function safeDisplayName(value: string): string {
  const leaf = originalFileName(value);
  const withoutControls = [...leaf.normalize("NFKC")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("");
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  return [...(cleaned || "file")].slice(0, 180).join("");
}

export function originalFileName(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = [...leaf.normalize("NFC")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .slice(0, 500)
    .join("")
    .trim();
  return cleaned || "file";
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/u.test(hex))
    throw new HttpError(422, "invalid_checksum", "The checksum encoding is invalid.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

export function arrayBufferToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function contentDisposition(name: string): string {
  const safe = safeDisplayName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/gu, "_").replaceAll('"', "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe).replaceAll("'", "%27")}`;
}
