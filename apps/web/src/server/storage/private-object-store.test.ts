import { describe, expect, it } from "vitest";

import {
  KvPrivateObjectStore,
  PRIVATE_OBJECT_MAX_BYTES,
  PrivateStorageIntegrityError,
} from "./private-object-store";

class MemoryKv {
  readonly values = new Map<string, { value: ArrayBuffer; metadata: unknown }>();

  async get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null> {
    void type;
    return this.values.get(key)?.value.slice(0) ?? null;
  }

  async getWithMetadata<Metadata>(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: Metadata | null; cacheStatus: string | null }> {
    void type;
    const entry = this.values.get(key);
    return {
      value: entry?.value.slice(0) ?? null,
      metadata: (entry?.metadata as Metadata | undefined) ?? null,
      cacheStatus: null,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { metadata?: unknown },
  ): Promise<void> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value).buffer
        : value instanceof ArrayBuffer
          ? value.slice(0)
          : ArrayBuffer.isView(value)
            ? (value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength,
              ) as ArrayBuffer)
            : await new Response(value).arrayBuffer();
    this.values.set(key, { value: bytes, metadata: options?.metadata ?? null });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe("KV private object storage", () => {
  it("stores immutable bytes with calculated checksum metadata", async () => {
    const kv = new MemoryKv();
    const store = new KvPrivateObjectStore(kv as unknown as KVNamespace);
    const bytes = new TextEncoder().encode("private fixture");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const object = await store.put("private/workspace/project/file", bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "text/plain", cacheControl: "private, no-store" },
      customMetadata: { workspaceId: "workspace", projectId: "project" },
      sha256: digest,
    });

    expect(object.size).toBe(bytes.byteLength);
    expect(object.httpMetadata?.contentType).toBe("text/plain");
    expect(object.customMetadata?.workspaceId).toBe("workspace");
    expect(object.etag).toMatch(/^[0-9a-f]{64}$/u);
    await expect(store.put("private/workspace/project/file", bytes)).rejects.toBeInstanceOf(
      PrivateStorageIntegrityError,
    );
  });

  it("serves bounded byte ranges while retaining full-object metadata", async () => {
    const store = new KvPrivateObjectStore(new MemoryKv() as unknown as KVNamespace);
    await store.put("private/workspace/project/ranged", new Uint8Array([1, 2, 3, 4, 5]));
    const object = await store.get("private/workspace/project/ranged", {
      range: { offset: 1, length: 3 },
    });

    expect(object?.size).toBe(5);
    expect([...((await object?.bytes()) ?? [])]).toEqual([2, 3, 4]);
    await expect(
      store.get("private/workspace/project/ranged", { range: { offset: 4, length: 2 } }),
    ).rejects.toBeInstanceOf(PrivateStorageIntegrityError);
  });

  it("rejects oversized values and malformed storage metadata", async () => {
    const kv = new MemoryKv();
    const store = new KvPrivateObjectStore(kv as unknown as KVNamespace);
    await expect(
      store.put("private/workspace/project/large", new Uint8Array(PRIVATE_OBJECT_MAX_BYTES + 1)),
    ).rejects.toBeInstanceOf(PrivateStorageIntegrityError);

    kv.values.set("private/workspace/project/tampered", {
      value: new Uint8Array([1]).buffer,
      metadata: { byteSize: 1 },
    });
    await expect(store.head("private/workspace/project/tampered")).rejects.toBeInstanceOf(
      PrivateStorageIntegrityError,
    );
    await expect(
      store.put("private/workspace/project/metadata-large", "body", {
        customMetadata: Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`field${index}`, "x".repeat(256)]),
        ),
      }),
    ).rejects.toBeInstanceOf(PrivateStorageIntegrityError);
  });

  it("deletes one or several immutable keys", async () => {
    const kv = new MemoryKv();
    const store = new KvPrivateObjectStore(kv as unknown as KVNamespace);
    await store.put("private/workspace/project/a", "a");
    await store.put("private/workspace/project/b", "b");
    await store.delete(["private/workspace/project/a", "private/workspace/project/b"]);
    await expect(store.get("private/workspace/project/a")).resolves.toBeNull();
    await expect(store.get("private/workspace/project/b")).resolves.toBeNull();
  });
});
