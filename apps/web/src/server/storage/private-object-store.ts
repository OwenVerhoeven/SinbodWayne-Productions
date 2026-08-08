import { z } from "zod";

export const PRIVATE_OBJECT_MAX_BYTES = 25 * 1024 * 1024;
export const PRIVATE_OBJECT_TOTAL_BUDGET_BYTES = 1_000_000_000;
const KV_METADATA_MAX_BYTES = 1024;

const digestPattern = /^[0-9a-f]{64}$/u;

const kvObjectMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    byteSize: z.number().int().nonnegative().max(PRIVATE_OBJECT_MAX_BYTES),
    contentType: z.string().min(1).max(160),
    cacheControl: z.string().min(1).max(160),
    sha256: z.string().regex(digestPattern),
    etag: z.string().min(1).max(160),
    uploadedAt: z.number().int().nonnegative(),
    customMetadata: z.record(z.string().max(80), z.string().max(256)),
  })
  .strict();

type KvObjectMetadata = z.infer<typeof kvObjectMetadataSchema>;

export interface PrivateObjectHttpMetadata {
  readonly contentType?: string;
  readonly cacheControl?: string;
}

export interface PrivateObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly checksums: { readonly sha256?: ArrayBuffer };
  readonly httpMetadata?: PrivateObjectHttpMetadata;
  readonly customMetadata?: Record<string, string>;
}

export interface PrivateObjectBody extends PrivateObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly range?: { readonly offset: number; readonly length: number };
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
}

export interface PrivateObjectGetOptions {
  readonly range?: { readonly offset: number; readonly length: number };
  readonly onlyIf?: { readonly etagMatches?: string };
}

export interface PrivateObjectPutOptions {
  readonly onlyIf?: { readonly etagDoesNotMatch?: string };
  readonly httpMetadata?: PrivateObjectHttpMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly sha256?: ArrayBuffer;
}

export type PrivateObjectValue =
  ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Uint8Array | string | Blob;

export interface PrivateObjectStore {
  head(key: string): Promise<PrivateObject | null>;
  get(key: string, options?: PrivateObjectGetOptions): Promise<PrivateObjectBody | null>;
  put(
    key: string,
    value: PrivateObjectValue,
    options?: PrivateObjectPutOptions,
  ): Promise<PrivateObject>;
  delete(key: string | readonly string[]): Promise<void>;
}

export class PrivateStorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStorageIntegrityError";
  }
}

/**
 * Private immutable-object storage backed by Workers KV for the no-subscription test release.
 *
 * KV does not provide conditional writes or byte-range reads. Object keys are random, immutable,
 * and bound by D1 to an expected digest; the existence check is additional collision defence and
 * same-key retries can only submit the authorized bytes. Requested byte ranges are sliced after
 * one bounded (25 MiB maximum) read. Metadata is generated only after the Worker has calculated
 * and verified the body digest.
 */
export class KvPrivateObjectStore implements PrivateObjectStore {
  readonly namespace: KVNamespace;

  constructor(namespace: KVNamespace) {
    this.namespace = namespace;
  }

  async head(key: string): Promise<PrivateObject | null> {
    const entry = await this.read(key);
    return entry ? objectMetadata(key, entry.metadata) : null;
  }

  async get(key: string, options: PrivateObjectGetOptions = {}): Promise<PrivateObjectBody | null> {
    const entry = await this.read(key);
    if (!entry) return null;
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== entry.metadata.etag) {
      return null;
    }
    const requested = options.range;
    let offset = 0;
    let length = entry.value.byteLength;
    if (requested) {
      if (
        !Number.isSafeInteger(requested.offset) ||
        !Number.isSafeInteger(requested.length) ||
        requested.offset < 0 ||
        requested.length < 0 ||
        requested.offset + requested.length > entry.value.byteLength
      ) {
        throw new PrivateStorageIntegrityError(
          "The requested private-object byte range is invalid.",
        );
      }
      offset = requested.offset;
      length = requested.length;
    }
    const selected = entry.value.slice(offset, offset + length);
    const metadata = objectMetadata(key, entry.metadata);
    return {
      ...metadata,
      body: bytesToStream(selected),
      ...(requested ? { range: { offset, length } } : {}),
      arrayBuffer: async () => selected.slice(0),
      bytes: async () => new Uint8Array(selected.slice(0)),
    };
  }

  async put(
    key: string,
    value: PrivateObjectValue,
    options: PrivateObjectPutOptions = {},
  ): Promise<PrivateObject> {
    assertSafeObjectKey(key);
    if (await this.namespace.get(key, "arrayBuffer")) {
      throw new PrivateStorageIntegrityError("An immutable private object already uses this key.");
    }
    const bytes = await valueToArrayBuffer(value);
    if (bytes.byteLength > PRIVATE_OBJECT_MAX_BYTES) {
      throw new PrivateStorageIntegrityError(
        `Workers KV objects may not exceed ${PRIVATE_OBJECT_MAX_BYTES} bytes.`,
      );
    }
    const digest = await sha256Hex(bytes);
    if (options.sha256 && arrayBufferToHex(options.sha256) !== digest) {
      throw new PrivateStorageIntegrityError("The private-object checksum did not match its body.");
    }
    const metadata = kvObjectMetadataSchema.parse({
      schemaVersion: 1,
      byteSize: bytes.byteLength,
      contentType: options.httpMetadata?.contentType ?? "application/octet-stream",
      cacheControl: options.httpMetadata?.cacheControl ?? "private, no-store",
      sha256: digest,
      etag: digest,
      uploadedAt: Date.now(),
      customMetadata: options.customMetadata ?? {},
    });
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > KV_METADATA_MAX_BYTES) {
      throw new PrivateStorageIntegrityError("Private-object metadata exceeds the KV limit.");
    }
    await this.namespace.put(key, bytes, { metadata });
    return objectMetadata(key, metadata);
  }

  async delete(key: string | readonly string[]): Promise<void> {
    const keys = typeof key === "string" ? [key] : key;
    await Promise.all(keys.map(async (item) => this.namespace.delete(item)));
  }

  private async read(
    key: string,
  ): Promise<{ readonly value: ArrayBuffer; readonly metadata: KvObjectMetadata } | null> {
    assertSafeObjectKey(key);
    const result = await this.namespace.getWithMetadata<unknown>(key, "arrayBuffer");
    if (result.value === null) return null;
    const parsed = kvObjectMetadataSchema.safeParse(result.metadata);
    if (!parsed.success || parsed.data.byteSize !== result.value.byteLength) {
      throw new PrivateStorageIntegrityError(
        "Private-object metadata failed integrity validation.",
      );
    }
    return { value: result.value, metadata: parsed.data };
  }
}

function objectMetadata(key: string, metadata: KvObjectMetadata): PrivateObject {
  return {
    key,
    size: metadata.byteSize,
    etag: metadata.etag,
    uploaded: new Date(metadata.uploadedAt),
    checksums: { sha256: hexToArrayBuffer(metadata.sha256) },
    httpMetadata: {
      contentType: metadata.contentType,
      cacheControl: metadata.cacheControl,
    },
    customMetadata: { ...metadata.customMetadata, sha256: metadata.sha256 },
  };
}

async function valueToArrayBuffer(value: PrivateObjectValue): Promise<ArrayBuffer> {
  if (typeof value === "string") return new TextEncoder().encode(value).buffer;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (value instanceof Blob) return value.arrayBuffer();
  return new Response(value).arrayBuffer();
}

function bytesToStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  const body = new Response(bytes).body;
  if (!body) throw new PrivateStorageIntegrityError("The private-object stream is unavailable.");
  return body;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return arrayBufferToHex(await crypto.subtle.digest("SHA-256", bytes));
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (!digestPattern.test(hex)) throw new PrivateStorageIntegrityError("Invalid SHA-256 metadata.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function arrayBufferToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertSafeObjectKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new PrivateStorageIntegrityError("The private-object key is unsafe.");
  }
}
