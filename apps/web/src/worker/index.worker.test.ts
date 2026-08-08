/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll, describe, expect, it } from "vitest";

import { KvPrivateObjectStore } from "../server/storage/private-object-store";

declare global {
  namespace Cloudflare {
    interface Env extends CloudflareBindings {
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      // The Cloudflare test harness requires the main module's exact module shape.
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      mainModule: typeof import("./index");
      durableNamespaces: "ProjectCollaborationHub";
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("Worker boundary", () => {
  it("serves the typed health envelope from workerd with D1 available", async () => {
    const response = await exports.default.fetch(
      "https://productions.sinbodwayne.nl/api/v1/health",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      data: {
        status: "healthy",
        database: "available",
        files: "configured",
        fileStorage: "workers_kv_free",
        maximumFileBytes: 26_214_400,
        storageBudgetBytes: 1_000_000_000,
        archive: "configured",
      },
    });
  });

  it("round-trips an immutable private object through the configured KV binding", async () => {
    const store = new KvPrivateObjectStore(env.FILE_OBJECTS);
    const key = `private/integration/${crypto.randomUUID()}`;
    const stored = await store.put(key, "private integration fixture", {
      httpMetadata: { contentType: "text/plain" },
    });
    expect(stored.size).toBe(27);
    expect(await (await store.get(key))?.bytes()).toEqual(
      new TextEncoder().encode("private integration fixture"),
    );
    await store.delete(key);
  });

  it("returns a generic API 404 with a request identifier", async () => {
    const response = await exports.default.fetch(
      "https://productions.sinbodwayne.nl/api/v1/does-not-exist",
    );
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("route_not_found");
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
