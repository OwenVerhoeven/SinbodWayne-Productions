import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArchiveAgent } from "../src/archive-agent.ts";
import { FileCredentialProvider, loadConfiguration } from "../src/config.ts";
import { JsonLineLogger, NullLogger } from "../src/logger.ts";
import { manifestDigest } from "../src/manifest.ts";
import { normalizeManifestPath } from "../src/path-policy.ts";
import type {
  ArchiveLease,
  ArchiveManifest,
  ArchiveManifestItem,
  ArchiveServiceClient,
  DownloadResponse,
  ItemAcknowledgement,
  JobFailure,
  ManifestAcknowledgement,
  SpaceProbe,
} from "../src/types.ts";

const encoder = new TextEncoder();

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeItem(
  id: string,
  relativePath: string,
  bytes: Uint8Array,
  overrides: Partial<ArchiveManifestItem> = {},
): ArchiveManifestItem {
  return {
    id,
    relativePath,
    byteSize: bytes.byteLength,
    mimeType: "application/octet-stream",
    sha256: digest(bytes),
    ...overrides,
  };
}

function makeLease(items: readonly ArchiveManifestItem[], jobId = "job-01"): ArchiveLease {
  const unsigned: Omit<ArchiveManifest, "manifestHash"> = {
    schemaVersion: "1.0.0",
    projectId: "project-01",
    exportSnapshotId: "snapshot-01",
    items,
  };
  return {
    jobId,
    leaseToken: "test-lease-token-value",
    leaseExpiresAt: "2100-01-01T00:00:00.000Z",
    manifest: { ...unsigned, manifestHash: manifestDigest(unsigned) },
  };
}

class FixedSpaceProbe implements SpaceProbe {
  readonly bytes: bigint | null;

  constructor(bytes: bigint | null) {
    this.bytes = bytes;
  }

  async availableBytes(): Promise<bigint | null> {
    return this.bytes;
  }
}

class FakeArchiveService implements ArchiveServiceClient {
  readonly leases: ArchiveLease[];
  readonly contents = new Map<string, Uint8Array>();
  readonly requestedOffsets: number[] = [];
  readonly itemAckRequests: {
    itemId: string;
    key: string;
    acknowledgement: ItemAcknowledgement;
  }[] = [];
  readonly itemAckEffects = new Set<string>();
  readonly manifestAckRequests: { key: string; acknowledgement: ManifestAcknowledgement }[] = [];
  readonly manifestAckEffects = new Set<string>();
  readonly failures: JobFailure[] = [];
  readonly cloudMutationKinds: string[] = [];
  heartbeatCalls = 0;
  interruptFirstAt: number | null = null;
  interrupted = false;

  constructor(leases: ArchiveLease[]) {
    this.leases = [...leases];
  }

  async leaseNextJob(): Promise<ArchiveLease | null> {
    return this.leases.shift() ?? null;
  }

  async heartbeat(): Promise<void> {
    this.heartbeatCalls += 1;
  }

  async downloadItem(
    _lease: ArchiveLease,
    item: ArchiveManifestItem,
    offset: number,
  ): Promise<DownloadResponse> {
    void _lease;
    this.requestedOffsets.push(offset);
    const bytes = this.contents.get(item.id);
    if (bytes === undefined) {
      return { status: 404, body: null };
    }
    const selected = bytes.subarray(offset);
    const status = offset === 0 ? 200 : 206;
    const interruptAt = this.interruptFirstAt;
    const shouldInterrupt = interruptAt !== null && !this.interrupted && offset === 0;
    if (shouldInterrupt) this.interrupted = true;

    async function* body(): AsyncGenerator<Uint8Array> {
      if (shouldInterrupt && interruptAt !== null) {
        yield selected.subarray(0, interruptAt);
        throw new Error("simulated transport interruption");
      }
      yield selected;
    }

    return {
      status,
      contentLength: selected.byteLength,
      ...(offset === 0
        ? {}
        : { contentRange: `bytes ${offset}-${bytes.byteLength - 1}/${bytes.byteLength}` }),
      body: body(),
    };
  }

  async acknowledgeItem(
    _lease: ArchiveLease,
    item: ArchiveManifestItem,
    acknowledgement: ItemAcknowledgement,
    idempotencyKey: string,
  ): Promise<void> {
    void _lease;
    this.itemAckRequests.push({ itemId: item.id, key: idempotencyKey, acknowledgement });
    this.itemAckEffects.add(idempotencyKey);
    this.cloudMutationKinds.push("acknowledge-item");
  }

  async acknowledgeManifest(
    _lease: ArchiveLease,
    acknowledgement: ManifestAcknowledgement,
    idempotencyKey: string,
  ): Promise<void> {
    void _lease;
    this.manifestAckRequests.push({ key: idempotencyKey, acknowledgement });
    this.manifestAckEffects.add(idempotencyKey);
    this.cloudMutationKinds.push("acknowledge-manifest");
  }

  async failJob(_lease: ArchiveLease, failure: JobFailure): Promise<void> {
    void _lease;
    this.failures.push(failure);
    this.cloudMutationKinds.push("fail-job");
  }
}

interface TestContext {
  readonly sandbox: string;
  readonly root: string;
}

async function context(t: { after(callback: () => Promise<void>): void }): Promise<TestContext> {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "swp-nas-agent-"));
  const root = path.join(sandbox, "archive-root");
  await mkdir(root);
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  return { sandbox, root };
}

function makeAgent(
  service: FakeArchiveService,
  root: string,
  overrides: Partial<ConstructorParameters<typeof ArchiveAgent>[1]> = {},
  spaceProbe: SpaceProbe = new FixedSpaceProbe(10_000_000n),
): ArchiveAgent {
  return new ArchiveAgent(
    service,
    {
      agentId: "test-agent-01",
      destinationRoot: root,
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 30_000,
      downloadAttempts: 2,
      retryBaseDelayMs: 1,
      minimumFreeSpaceBytes: 0n,
      ...overrides,
    },
    {
      logger: new NullLogger(),
      spaceProbe,
      now: () => new Date("2028-04-05T06:07:08.000Z"),
      sleep: async () => undefined,
    },
  );
}

test("resumes an interrupted object with Range and verifies before acknowledgement", async (t) => {
  const { root } = await context(t);
  const bytes = encoder.encode("hello resumable archive");
  const item = makeItem("item-01", "project/11-data-exports/project.json", bytes);
  const lease = makeLease([item]);
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, bytes);
  service.interruptFirstAt = 7;

  const result = await makeAgent(service, root).runOnce();

  assert.deepEqual(result, { kind: "verified", jobId: lease.jobId, itemCount: 1 });
  assert.deepEqual(service.requestedOffsets, [0, 7]);
  assert.deepEqual(
    new Uint8Array(await readFile(path.join(root, "project", "11-data-exports", "project.json"))),
    bytes,
  );
  assert.equal(service.manifestAckEffects.size, 1);
  assert.equal(service.failures.length, 0);
  assert.ok(service.heartbeatCalls >= 1);
});

test("re-running a verified lease safely repeats only idempotent acknowledgements", async (t) => {
  const { root } = await context(t);
  const bytes = encoder.encode("immutable production pack");
  const item = makeItem("item-02", "project/10-call-sheets-production-packs/pack.pdf", bytes);
  const lease = makeLease([item], "job-repeat");
  const service = new FakeArchiveService([lease, lease]);
  service.contents.set(item.id, bytes);
  const agent = makeAgent(service, root);

  assert.equal((await agent.runOnce()).kind, "verified");
  assert.equal((await agent.runOnce()).kind, "verified");

  assert.equal(service.itemAckRequests.length, 2);
  assert.equal(service.itemAckEffects.size, 1);
  assert.deepEqual(
    service.itemAckRequests[0]?.acknowledgement,
    service.itemAckRequests[1]?.acknowledgement,
  );
  assert.equal(service.manifestAckRequests.length, 2);
  assert.equal(service.manifestAckEffects.size, 1);
  assert.deepEqual(
    service.manifestAckRequests[0]?.acknowledgement,
    service.manifestAckRequests[1]?.acknowledgement,
  );
  assert.deepEqual(service.requestedOffsets, [0]);
  assert.ok(!service.cloudMutationKinds.includes("delete"));
});

test("a checksum mismatch blocks verification", async (t) => {
  const { root } = await context(t);
  const expected = encoder.encode("expected");
  const received = encoder.encode("tampered");
  const item = makeItem("item-03", "project/manifest/project-manifest.json", expected);
  const lease = makeLease([item], "job-mismatch");
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, received);

  const result = await makeAgent(service, root, { downloadAttempts: 1 }).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "CHECKSUM_MISMATCH");
  assert.deepEqual(service.failures, [{ code: "CHECKSUM_MISMATCH", retryable: true }]);
  assert.equal(service.manifestAckRequests.length, 0);
});

test("an existing destination is never overwritten when it conflicts", async (t) => {
  const { root } = await context(t);
  const expected = encoder.encode("known manifest content");
  const existing = encoder.encode("known existing content");
  const item = makeItem("item-existing", "project/manifest/checksums.sha256", expected);
  const lease = makeLease([item], "job-existing");
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, expected);
  const destination = path.join(root, "project", "manifest", "checksums.sha256");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, existing);

  const result = await makeAgent(service, root).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "DESTINATION_CONFLICT");
  assert.deepEqual(new Uint8Array(await readFile(destination)), existing);
  assert.deepEqual(service.requestedOffsets, []);
  assert.equal(service.manifestAckRequests.length, 0);
});

test("a manifest digest mismatch blocks every download", async (t) => {
  const { root } = await context(t);
  const bytes = encoder.encode("manifest integrity");
  const item = makeItem("item-manifest", "project/manifest/project-manifest.json", bytes);
  const lease = makeLease([item], "job-invalid-manifest");
  const invalidLease: ArchiveLease = {
    ...lease,
    manifest: { ...lease.manifest, manifestHash: "0".repeat(64) },
  };
  const service = new FakeArchiveService([invalidLease]);
  service.contents.set(item.id, bytes);

  const result = await makeAgent(service, root).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "INVALID_MANIFEST");
  assert.deepEqual(service.requestedOffsets, []);
});

test("a missing source object blocks verification", async (t) => {
  const { root } = await context(t);
  const bytes = encoder.encode("missing");
  const item = makeItem("item-04", "project/00-project-development/brief.pdf", bytes);
  const lease = makeLease([item], "job-missing");
  const service = new FakeArchiveService([lease]);

  const result = await makeAgent(service, root).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "MISSING_OBJECT");
  assert.equal(service.manifestAckRequests.length, 0);
});

test("an empty manifest object is archived and verified", async (t) => {
  const { root } = await context(t);
  const bytes = new Uint8Array();
  const item = makeItem("item-empty", "project/manifest/schema-version.txt", bytes);
  const lease = makeLease([item], "job-empty");
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, bytes);

  const result = await makeAgent(service, root).runOnce();

  assert.equal(result.kind, "verified");
  assert.equal(
    (await readFile(path.join(root, "project", "manifest", "schema-version.txt"))).byteLength,
    0,
  );
  assert.equal(service.itemAckEffects.size, 1);
});

test("unsafe manifest paths are rejected before download", async (t) => {
  const invalidPaths = [
    "../escape.txt",
    "/absolute.txt",
    "C:/absolute.txt",
    "folder/../../escape.txt",
    "CON/report.txt",
    "folder/file.",
    "folder\\escape.txt",
    ".swp-staging/injected.txt",
  ];

  for (const [index, relativePath] of invalidPaths.entries()) {
    const { root } = await context(t);
    const bytes = encoder.encode("unsafe");
    const item = makeItem(`item-path-${index}`, relativePath, bytes);
    const lease = makeLease([item], `job-path-${index}`);
    const service = new FakeArchiveService([lease]);
    service.contents.set(item.id, bytes);

    const result = await makeAgent(service, root).runOnce();
    assert.equal(result.kind, "failed", relativePath);
    assert.equal(result.kind === "failed" ? result.code : "", "INVALID_PATH", relativePath);
    assert.equal(service.requestedOffsets.length, 0, relativePath);
  }
});

test("insufficient available space fails before download", async (t) => {
  const { root } = await context(t);
  const bytes = encoder.encode("requires space");
  const item = makeItem("item-space", "project/11-data-exports/data.zip", bytes);
  const lease = makeLease([item], "job-space");
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, bytes);

  const result = await makeAgent(service, root, {}, new FixedSpaceProbe(1n)).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "INSUFFICIENT_SPACE");
  assert.deepEqual(service.requestedOffsets, []);
});

test("a symlink or junction escape under the archive root is rejected", async (t) => {
  const { sandbox, root } = await context(t);
  const outside = path.join(sandbox, "outside");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const bytes = encoder.encode("must not escape");
  const item = makeItem("item-link", "escape/file.bin", bytes);
  const lease = makeLease([item], "job-link");
  const service = new FakeArchiveService([lease]);
  service.contents.set(item.id, bytes);

  const result = await makeAgent(service, root).runOnce();

  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.code : "", "PATH_ESCAPE");
  assert.deepEqual(service.requestedOffsets, []);
});

test("credential files can rotate without restarting and secrets are redacted", async (t) => {
  const { sandbox } = await context(t);
  const credentialFile = path.join(sandbox, "service-token");
  const first = "first-test-service-token-value";
  const second = "second-test-service-token-value";
  await writeFile(credentialFile, first, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(credentialFile, 0o600);
  const provider = new FileCredentialProvider(credentialFile);
  assert.equal(await provider.getToken(), first);
  await writeFile(credentialFile, second, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(credentialFile, 0o600);
  assert.equal(await provider.getToken(), second);

  const lines: string[] = [];
  const logger = new JsonLineLogger((line) => lines.push(line));
  logger.error("test_redaction", {
    authorization: `Bearer ${second}`,
    endpoint: `https://example.invalid/download?signature=${second}`,
  });
  assert.ok(!lines.join("\n").includes(second));
  assert.match(lines[0] ?? "", /\[REDACTED\]/);
});

test("configuration requires an explicit root and a single non-argument credential source", async (t) => {
  const { sandbox, root } = await context(t);
  const credentialFile = path.join(sandbox, "configuration-token");
  await writeFile(credentialFile, "configuration-test-service-token", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(credentialFile, 0o600);

  const configuration = await loadConfiguration({
    SWP_ARCHIVE_API_URL: "http://[::1]:8787",
    SWP_ARCHIVE_ALLOW_INSECURE_LOCALHOST: "true",
    SWP_ARCHIVE_DESTINATION_ROOT: root,
    SWP_ARCHIVE_AGENT_ID: "test-agent-config",
    SWP_ARCHIVE_TOKEN_FILE: credentialFile,
  });
  assert.equal(configuration.destinationRoot, path.resolve(root));
  assert.equal(configuration.credentialProvider.description, "file");

  await assert.rejects(
    loadConfiguration({
      SWP_ARCHIVE_API_URL: "https://productions.example.invalid",
      SWP_ARCHIVE_DESTINATION_ROOT: "relative/archive",
      SWP_ARCHIVE_AGENT_ID: "test-agent-config",
      SWP_ARCHIVE_TOKEN_FILE: credentialFile,
    }),
    /absolute path/,
  );
  await assert.rejects(
    loadConfiguration({
      SWP_ARCHIVE_API_URL: "https://productions.example.invalid",
      SWP_ARCHIVE_DESTINATION_ROOT: root,
      SWP_ARCHIVE_AGENT_ID: "test-agent-config",
      SWP_ARCHIVE_TOKEN_FILE: credentialFile,
      SWP_ARCHIVE_TOKEN_STDIN: "true",
    }),
    /exactly one credential source/,
  );
});

test("path normalization accepts the documented archive layout", () => {
  assert.equal(
    normalizeManifestPath(
      "film-001-night-bus/10-call-sheets-production-packs/day-01/call-sheet.pdf",
    ),
    "film-001-night-bus/10-call-sheets-production-packs/day-01/call-sheet.pdf",
  );
});
