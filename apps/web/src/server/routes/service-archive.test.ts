import { describe, expect, it } from "vitest";

import type { ArchiveCoordinatorContract } from "../archive/service";
import type {
  ArchiveDownload,
  ArchiveLeaseContract,
  ArchiveServicePrincipal,
} from "../archive/types";
import { createArchiveServiceRoutes } from "./service-archive";

const principal: ArchiveServicePrincipal = {
  credentialId: "credential-01",
  workspaceId: "workspace-01",
};

class FakeArchiveCoordinator implements ArchiveCoordinatorContract {
  readonly calls: string[] = [];

  async authenticate(token: string): Promise<ArchiveServicePrincipal> {
    this.calls.push("authenticate");
    if (token !== "valid-service-token-value") throw new Error("invalid fake credential");
    return principal;
  }

  async consumeRateLimit(): Promise<void> {
    this.calls.push("rate-limit");
  }

  async lease(): Promise<ArchiveLeaseContract | null> {
    this.calls.push("lease");
    return null;
  }

  async heartbeat(): Promise<{ readonly leaseExpiresAt: string }> {
    this.calls.push("heartbeat");
    return { leaseExpiresAt: "2030-01-01T00:00:00.000Z" };
  }

  async download(): Promise<ArchiveDownload> {
    this.calls.push("download");
    return {
      status: 206,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      }),
      byteSize: 4,
      start: 4,
      end: 7,
      total: 8,
      mimeType: "application/octet-stream",
      sha256: "a".repeat(64),
      filename: "archive.bin",
    };
  }

  async acknowledgeItem(): Promise<{ readonly acknowledged: true }> {
    this.calls.push("acknowledge-item");
    return { acknowledged: true };
  }

  async acknowledgeManifest(): Promise<{ readonly verified: true }> {
    this.calls.push("acknowledge-manifest");
    return { verified: true };
  }

  async recordFailure(): Promise<{ readonly recorded: true; readonly willRetry: boolean }> {
    this.calls.push("failure");
    return { recorded: true, willRetry: false };
  }

  async materializeWorkflowManifest(jobId: string): Promise<{ readonly archiveJobId: string }> {
    return { archiveJobId: jobId };
  }

  async validateWorkflowJob(jobId: string): Promise<{ readonly archiveJobId: string }> {
    return { archiveJobId: jobId };
  }

  async markWorkflowJobRequested(jobId: string): Promise<{ readonly archiveJobId: string }> {
    return { archiveJobId: jobId };
  }

  async markWorkflowJobFailed(): Promise<void> {}
}

function testRoutes(coordinator = new FakeArchiveCoordinator()) {
  return {
    coordinator,
    app: createArchiveServiceRoutes({
      coordinatorFactory: () => coordinator,
      now: () => Date.parse("2029-01-01T00:00:00.000Z"),
      requestId: () => "request-test-01",
    }),
  };
}

const authentication = { Authorization: "Bearer valid-service-token-value" };

describe("archive service routes", () => {
  it("returns the NAS agent success envelope when no job is ready", async () => {
    const { app } = testRoutes();
    const response = await app.request("/jobs/lease", {
      method: "POST",
      headers: { ...authentication, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "nas-agent-01", leaseDurationMs: 120_000 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: null, requestId: "request-test-01" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing bearer credentials without reading a body", async () => {
    const { app } = testRoutes();
    const response = await app.request("/jobs/lease", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "nas-agent-01", leaseDurationMs: 120_000 }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="archive-agent"');
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_REQUIRED" },
      requestId: "request-test-01",
    });
  });

  it("streams a private ranged object without a JSON wrapper", async () => {
    const { app, coordinator } = testRoutes();
    const response = await app.request("/jobs/job-01/items/item-01/content", {
      method: "GET",
      headers: {
        ...authentication,
        "X-Archive-Lease": "lease-token-value",
        Range: "bytes=4-",
      },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 4-7/8");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe("data");
    expect(coordinator.calls).toContain("download");
  });

  it("validates acknowledgement bodies before calling the coordinator", async () => {
    const { app, coordinator } = testRoutes();
    const response = await app.request("/jobs/job-01/items/item-01/acknowledgements", {
      method: "POST",
      headers: {
        ...authentication,
        "Content-Type": "application/json",
        "X-Archive-Lease": "lease-token-value",
        "Idempotency-Key": "item-ack-test-01",
      },
      body: JSON.stringify({ byteSize: -1, sha256: "wrong", destinationPath: "../escape" }),
    });

    expect(response.status).toBe(400);
    expect(coordinator.calls).not.toContain("acknowledge-item");
  });
});
