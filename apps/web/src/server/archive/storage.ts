import { timingSafeHexEqual } from "./crypto";
import { ArchiveServiceError } from "./errors";
import { resolveArchiveByteRange } from "./range";
import type { ArchiveContentDescriptor, ArchiveDownload } from "./types";
import type {
  PrivateObject,
  PrivateObjectBody,
  PrivateObjectStore,
} from "../storage/private-object-store";

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectSha256(object: PrivateObject): string | null {
  if (object.checksums.sha256 !== undefined) return bytesToHex(object.checksums.sha256);
  const metadataDigest = object.customMetadata?.sha256;
  return metadataDigest && /^[a-f0-9]{64}$/u.test(metadataDigest) ? metadataDigest : null;
}

function basename(relativePath: string): string {
  const segment = relativePath.split("/").at(-1) ?? "archive-item";
  return segment.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160) || "archive-item";
}

function isObjectBody(object: PrivateObject): object is PrivateObjectBody {
  return Reflect.has(object, "body");
}

export class PrivateArchiveStorage {
  readonly bucket: PrivateObjectStore;

  constructor(bucket: PrivateObjectStore) {
    this.bucket = bucket;
  }

  async assertImmutableObject(descriptor: ArchiveContentDescriptor): Promise<PrivateObject> {
    const object = await this.bucket.head(descriptor.objectKey);
    if (object === null) {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "An archive source object is missing.");
    }
    const storedDigest = objectSha256(object);
    if (
      object.size !== descriptor.byteSize ||
      storedDigest === null ||
      !timingSafeHexEqual(storedDigest, descriptor.sha256)
    ) {
      throw new ArchiveServiceError(
        "INTEGRITY_FAILURE",
        "An archive source object does not match its immutable manifest metadata.",
      );
    }
    return object;
  }

  async open(
    descriptor: ArchiveContentDescriptor,
    rangeHeader: string | null,
  ): Promise<ArchiveDownload> {
    const metadata = await this.assertImmutableObject(descriptor);
    const range = resolveArchiveByteRange(rangeHeader, descriptor.byteSize);
    const object =
      range.length === 0
        ? await this.bucket.get(descriptor.objectKey, { onlyIf: { etagMatches: metadata.etag } })
        : await this.bucket.get(descriptor.objectKey, {
            range: { offset: range.start, length: range.length },
            onlyIf: { etagMatches: metadata.etag },
          });
    if (object === null || !isObjectBody(object) || object.size !== descriptor.byteSize) {
      throw new ArchiveServiceError(
        "INTEGRITY_FAILURE",
        "An archive source object changed during authorization.",
      );
    }
    return {
      status: range.partial ? 206 : 200,
      body: object.body,
      byteSize: range.length,
      start: range.start,
      end: range.end,
      total: descriptor.byteSize,
      mimeType: descriptor.mimeType,
      sha256: descriptor.sha256,
      filename: basename(descriptor.relativePath),
    };
  }
}
