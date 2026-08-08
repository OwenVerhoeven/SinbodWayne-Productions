import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { ArchiveAgentError, asArchiveAgentError } from "./errors.ts";
import { NullLogger } from "./logger.ts";
import { validateManifest } from "./manifest.ts";
import { DestinationGuard } from "./path-policy.ts";
import { HostSpaceProbe } from "./space.ts";
import type {
  AgentLogger,
  ArchiveAgentOptions,
  ArchiveLease,
  ArchiveManifestItem,
  ArchiveServiceClient,
  DownloadResponse,
  RunResult,
  SpaceProbe,
} from "./types.ts";

interface ArchiveAgentDependencies {
  readonly logger?: AgentLogger;
  readonly spaceProbe?: SpaceProbe;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface PreparedItem {
  readonly item: ArchiveManifestItem;
  readonly destination: string;
  readonly partial: string;
  readonly alreadyVerified: boolean;
  readonly remainingBytes: bigint;
}

interface DownloadOutcome {
  readonly resumedFrom: number;
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new ArchiveAgentError("DOWNLOAD_INTERRUPTED", "Archive operation was cancelled", true);
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        new ArchiveAgentError("DOWNLOAD_INTERRUPTED", "Archive operation was cancelled", true),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function pathState(filename: string): Promise<{ size: number; isFile: boolean } | null> {
  try {
    const stats = await lstat(filename);
    if (stats.isSymbolicLink()) {
      throw new ArchiveAgentError("PATH_ESCAPE", "Archive path is a symbolic link or junction");
    }
    return { size: stats.size, isFile: stats.isFile() };
  } catch (error) {
    if (hasCode(error, ["ENOENT"])) {
      return null;
    }
    throw error;
  }
}

async function sha256File(filename: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function digestMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function verifyFile(filename: string, item: ArchiveManifestItem): Promise<boolean> {
  const state = await pathState(filename);
  if (state === null) {
    return false;
  }
  if (!state.isFile) {
    throw new ArchiveAgentError(
      "DESTINATION_CONFLICT",
      "Archive destination is not a regular file",
    );
  }
  if (state.size !== item.byteSize) {
    return false;
  }
  return digestMatches(await sha256File(filename), item.sha256.toLowerCase());
}

function stableIdempotencyKey(
  purpose: string,
  lease: ArchiveLease,
  item?: ArchiveManifestItem,
): string {
  const digest = createHash("sha256")
    .update("swp-nas-agent-v1\0", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(lease.jobId, "utf8")
    .update("\0", "utf8")
    .update(lease.manifest.manifestHash, "utf8")
    .update("\0", "utf8")
    .update(item?.id ?? "", "utf8")
    .update("\0", "utf8")
    .update(item?.sha256 ?? "", "utf8")
    .digest("hex");
  return `swp-nas-v1-${digest}`;
}

export class ArchiveAgent {
  readonly client: ArchiveServiceClient;
  readonly options: ArchiveAgentOptions;
  readonly logger: AgentLogger;
  readonly spaceProbe: SpaceProbe;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    client: ArchiveServiceClient,
    options: ArchiveAgentOptions,
    dependencies: ArchiveAgentDependencies = {},
  ) {
    this.client = client;
    this.options = options;
    this.logger = dependencies.logger ?? new NullLogger();
    this.spaceProbe = dependencies.spaceProbe ?? new HostSpaceProbe();
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  async runOnce(signal?: AbortSignal): Promise<RunResult> {
    const lease = await this.client.leaseNextJob(
      this.options.agentId,
      this.options.leaseDurationMs,
      signal,
    );
    if (lease === null) {
      return { kind: "idle" };
    }

    try {
      const itemCount = await this.processLease(lease, signal);
      return { kind: "verified", jobId: lease.jobId, itemCount };
    } catch (error) {
      const failure = asArchiveAgentError(error);
      try {
        await this.client.failJob(
          lease,
          { code: failure.code, retryable: failure.retryable },
          stableIdempotencyKey(`failure:${failure.code}`, lease),
          signal,
        );
      } catch {
        this.logger.warn("archive_job_failure_ack_failed", {
          jobId: lease.jobId,
          code: failure.code,
        });
      }
      this.logger.error("archive_job_failed", {
        jobId: lease.jobId,
        code: failure.code,
        retryable: failure.retryable,
      });
      return {
        kind: "failed",
        jobId: lease.jobId,
        code: failure.code,
        retryable: failure.retryable,
      };
    }
  }

  async processLease(lease: ArchiveLease, signal?: AbortSignal): Promise<number> {
    validateManifest(lease.manifest);
    const expiry = Date.parse(lease.leaseExpiresAt);
    if (
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(lease.leaseExpiresAt) ||
      !lease.leaseExpiresAt.endsWith("Z") ||
      !Number.isFinite(expiry) ||
      expiry <= this.now().getTime() ||
      lease.jobId.length === 0 ||
      lease.jobId.length > 200 ||
      lease.leaseToken.length < 16 ||
      lease.leaseToken.length > 16_384
    ) {
      throw new ArchiveAgentError(
        "LEASE_LOST",
        "Archive service returned an invalid or expired lease",
        true,
      );
    }

    const heartbeatController = new AbortController();
    const signals = signal ? [signal, heartbeatController.signal] : [heartbeatController.signal];
    const operationSignal = AbortSignal.any(signals);
    await this.client.heartbeat(lease, operationSignal);
    let consecutiveHeartbeatFailures = 0;
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.client
        .heartbeat(lease, operationSignal)
        .then(() => {
          consecutiveHeartbeatFailures = 0;
        })
        .catch(() => {
          consecutiveHeartbeatFailures += 1;
          this.logger.warn("archive_heartbeat_failed", {
            jobId: lease.jobId,
            consecutiveFailures: consecutiveHeartbeatFailures,
          });
          if (consecutiveHeartbeatFailures >= 2) {
            heartbeatController.abort(
              new ArchiveAgentError("LEASE_LOST", "Archive lease heartbeat failed", true),
            );
          }
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.options.heartbeatIntervalMs);
    heartbeatTimer.unref();

    try {
      const guard = await DestinationGuard.open(this.options.destinationRoot);
      const prepared = await this.prepareItems(guard, lease);
      await this.assertAvailableSpace(guard.root, prepared);

      for (const entry of prepared) {
        if (operationSignal.aborted) {
          throw new ArchiveAgentError("LEASE_LOST", "Archive lease is no longer active", true);
        }
        const outcome = entry.alreadyVerified
          ? { resumedFrom: entry.item.byteSize }
          : await this.downloadAndInstall(guard, lease, entry, operationSignal);

        await this.client.acknowledgeItem(
          lease,
          entry.item,
          {
            byteSize: entry.item.byteSize,
            sha256: entry.item.sha256.toLowerCase(),
            destinationPath: entry.item.relativePath,
          },
          stableIdempotencyKey("item-verified", lease, entry.item),
          operationSignal,
        );
        this.logger.info("archive_item_verified", {
          jobId: lease.jobId,
          itemId: entry.item.id,
          resumedFrom: outcome.resumedFrom,
        });
      }

      await this.client.acknowledgeManifest(
        lease,
        {
          manifestHash: lease.manifest.manifestHash,
          itemCount: prepared.length,
        },
        stableIdempotencyKey("manifest-verified", lease),
        operationSignal,
      );
      this.logger.info("archive_manifest_verified", {
        jobId: lease.jobId,
        itemCount: prepared.length,
      });
      return prepared.length;
    } catch (error) {
      if (heartbeatController.signal.aborted && !signal?.aborted) {
        throw new ArchiveAgentError("LEASE_LOST", "Archive lease heartbeat failed", true, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      heartbeatController.abort();
    }
  }

  async prepareItems(guard: DestinationGuard, lease: ArchiveLease): Promise<PreparedItem[]> {
    const prepared: PreparedItem[] = [];
    for (const item of lease.manifest.items) {
      const destination = (await guard.ensureManifestParent(item.relativePath)).absolute;
      const partial = await guard.stagingFile(lease.jobId, item.relativePath);
      const destinationState = await pathState(destination);
      let alreadyVerified = false;
      if (destinationState !== null) {
        if (!destinationState.isFile || !(await verifyFile(destination, item))) {
          throw new ArchiveAgentError(
            "DESTINATION_CONFLICT",
            "An existing archive destination does not match the immutable manifest",
          );
        }
        alreadyVerified = true;
      }

      let remainingBytes = 0n;
      if (!alreadyVerified) {
        const partialState = await pathState(partial);
        if (partialState !== null && !partialState.isFile) {
          throw new ArchiveAgentError("PATH_ESCAPE", "Archive staging path is not a regular file");
        }
        if (partialState === null) {
          remainingBytes = BigInt(item.byteSize);
        } else if (partialState.size < item.byteSize) {
          remainingBytes = BigInt(item.byteSize - partialState.size);
        } else if (partialState.size === item.byteSize && (await verifyFile(partial, item))) {
          remainingBytes = 0n;
        } else {
          remainingBytes = BigInt(item.byteSize);
        }
      }
      prepared.push({ item, destination, partial, alreadyVerified, remainingBytes });
    }
    return prepared;
  }

  async assertAvailableSpace(
    destinationRoot: string,
    prepared: readonly PreparedItem[],
  ): Promise<void> {
    const available = await this.spaceProbe.availableBytes(destinationRoot);
    if (available === null) {
      this.logger.warn("archive_space_preflight_unavailable");
      return;
    }
    const remaining = prepared.reduce((total, entry) => total + entry.remainingBytes, 0n);
    const required = remaining + this.options.minimumFreeSpaceBytes;
    if (available < required) {
      throw new ArchiveAgentError(
        "INSUFFICIENT_SPACE",
        "Archive destination does not have enough available space",
        true,
      );
    }
    this.logger.debug("archive_space_preflight_passed", {
      availableBytes: available.toString(),
      requiredBytes: required.toString(),
    });
  }

  async downloadAndInstall(
    guard: DestinationGuard,
    lease: ArchiveLease,
    entry: PreparedItem,
    signal?: AbortSignal,
  ): Promise<DownloadOutcome> {
    let highestResumeOffset = 0;
    let lastFailure: ArchiveAgentError | null = null;

    for (let attempt = 1; attempt <= this.options.downloadAttempts; attempt += 1) {
      try {
        const state = await pathState(entry.partial);
        if (state !== null && !state.isFile) {
          throw new ArchiveAgentError("PATH_ESCAPE", "Archive staging path is not a regular file");
        }
        let offset = state?.size ?? 0;
        if (offset > entry.item.byteSize) {
          await unlink(entry.partial);
          throw new ArchiveAgentError(
            "SIZE_MISMATCH",
            "Staged object exceeds the manifest size",
            true,
          );
        }
        if (state !== null && offset === entry.item.byteSize) {
          if (await verifyFile(entry.partial, entry.item)) {
            highestResumeOffset = Math.max(highestResumeOffset, offset);
            await this.installVerifiedFile(guard, entry);
            return { resumedFrom: highestResumeOffset };
          }
          await unlink(entry.partial);
          offset = 0;
          throw new ArchiveAgentError(
            "CHECKSUM_MISMATCH",
            "Staged object checksum does not match",
            true,
          );
        }

        highestResumeOffset = Math.max(highestResumeOffset, offset);
        const response = await this.client.downloadItem(lease, entry.item, offset, signal);
        const writeOffset = await this.validateDownloadResponse(
          response,
          offset,
          entry.item.byteSize,
          entry.partial,
        );
        await this.writeResponseBody(response, entry.partial, writeOffset, entry.item.byteSize);

        const completed = await pathState(entry.partial);
        if (completed === null || completed.size !== entry.item.byteSize) {
          throw new ArchiveAgentError(
            "DOWNLOAD_INTERRUPTED",
            "Archive object download ended before completion",
            true,
          );
        }
        if (!(await verifyFile(entry.partial, entry.item))) {
          await unlink(entry.partial);
          throw new ArchiveAgentError(
            "CHECKSUM_MISMATCH",
            "Downloaded object checksum does not match",
            true,
          );
        }

        await this.installVerifiedFile(guard, entry);
        return { resumedFrom: highestResumeOffset };
      } catch (error) {
        const failure = asArchiveAgentError(error);
        lastFailure = failure;
        if (!failure.retryable || attempt >= this.options.downloadAttempts || signal?.aborted) {
          throw failure;
        }
        const delay = Math.min(this.options.retryBaseDelayMs * 2 ** (attempt - 1), 30_000);
        this.logger.warn("archive_item_retry", {
          jobId: lease.jobId,
          itemId: entry.item.id,
          attempt,
          code: failure.code,
        });
        await this.sleep(delay, signal);
      }
    }

    throw (
      lastFailure ??
      new ArchiveAgentError("DOWNLOAD_INTERRUPTED", "Archive object could not be downloaded", true)
    );
  }

  async validateDownloadResponse(
    response: DownloadResponse,
    requestedOffset: number,
    expectedSize: number,
    partial: string,
  ): Promise<number> {
    if (response.status === 404) {
      throw new ArchiveAgentError("MISSING_OBJECT", "Archive source object is missing");
    }
    if (response.status === 416 && requestedOffset === expectedSize) {
      return requestedOffset;
    }
    if (response.status === 200) {
      if (requestedOffset > 0) {
        const handle = await open(partial, "w");
        await handle.close();
      }
      if (response.contentLength !== undefined && response.contentLength !== expectedSize) {
        throw new ArchiveAgentError(
          "SIZE_MISMATCH",
          "Archive source object length does not match manifest",
          true,
        );
      }
      return 0;
    }
    if (response.status === 206) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.contentRange ?? "");
      if (
        match === null ||
        Number(match[1]) !== requestedOffset ||
        Number(match[3]) !== expectedSize ||
        Number(match[2]) < requestedOffset
      ) {
        throw new ArchiveAgentError(
          "SIZE_MISMATCH",
          "Archive service returned an invalid byte range",
          true,
        );
      }
      return requestedOffset;
    }
    throw new ArchiveAgentError(
      "SERVICE_UNAVAILABLE",
      `Archive object request returned HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
    );
  }

  async writeResponseBody(
    response: DownloadResponse,
    partial: string,
    writeOffset: number,
    expectedSize: number,
  ): Promise<void> {
    if (response.body === null) {
      throw new ArchiveAgentError(
        "DOWNLOAD_INTERRUPTED",
        "Archive object response did not contain a body",
        true,
      );
    }
    const handle = await open(partial, writeOffset === 0 ? "w" : "r+");
    let position = writeOffset;
    try {
      for await (const chunk of response.body) {
        if (!(chunk instanceof Uint8Array)) {
          throw new ArchiveAgentError(
            "DOWNLOAD_INTERRUPTED",
            "Archive object stream produced invalid data",
            true,
          );
        }
        if (position + chunk.byteLength > expectedSize) {
          throw new ArchiveAgentError(
            "SIZE_MISMATCH",
            "Archive source object exceeds manifest size",
            true,
          );
        }
        let chunkOffset = 0;
        while (chunkOffset < chunk.byteLength) {
          const result = await handle.write(
            chunk,
            chunkOffset,
            chunk.byteLength - chunkOffset,
            position,
          );
          if (result.bytesWritten === 0) {
            throw new ArchiveAgentError(
              "DOWNLOAD_INTERRUPTED",
              "Archive destination stopped accepting data",
              true,
            );
          }
          chunkOffset += result.bytesWritten;
          position += result.bytesWritten;
        }
      }
      await handle.truncate(position);
      await handle.sync();
    } catch (error) {
      if (error instanceof ArchiveAgentError) {
        throw error;
      }
      throw new ArchiveAgentError(
        "DOWNLOAD_INTERRUPTED",
        "Archive object stream was interrupted",
        true,
        {
          cause: error,
        },
      );
    } finally {
      await handle.close();
    }
  }

  async installVerifiedFile(guard: DestinationGuard, entry: PreparedItem): Promise<void> {
    await guard.ensureManifestParent(entry.item.relativePath);
    const existing = await pathState(entry.destination);
    if (existing !== null) {
      if (!(await verifyFile(entry.destination, entry.item))) {
        throw new ArchiveAgentError(
          "DESTINATION_CONFLICT",
          "Archive destination appeared with content that does not match the manifest",
        );
      }
      await unlink(entry.partial).catch((error: unknown) => {
        if (!hasCode(error, ["ENOENT"])) throw error;
      });
      return;
    }

    try {
      await link(entry.partial, entry.destination);
      await unlink(entry.partial);
    } catch (error) {
      if (hasCode(error, ["EEXIST"])) {
        if (!(await verifyFile(entry.destination, entry.item))) {
          throw new ArchiveAgentError(
            "DESTINATION_CONFLICT",
            "Archive destination changed during installation",
          );
        }
        await unlink(entry.partial).catch(() => undefined);
      } else if (hasCode(error, ["EPERM", "EOPNOTSUPP", "ENOTSUP"])) {
        await this.renameFallback(entry);
      } else if (hasCode(error, ["EXDEV"])) {
        throw new ArchiveAgentError(
          "DESTINATION_CONFLICT",
          "Staging and final archive paths must be on the same filesystem",
          false,
          { cause: error },
        );
      } else {
        throw error;
      }
    }
    await this.fsyncFileAndParent(entry.destination);
  }

  async renameFallback(entry: PreparedItem): Promise<void> {
    if ((await pathState(entry.destination)) !== null) {
      throw new ArchiveAgentError(
        "DESTINATION_CONFLICT",
        "Archive destination changed during installation",
      );
    }
    try {
      await rename(entry.partial, entry.destination);
    } catch (error) {
      if (
        hasCode(error, ["EEXIST", "ENOTEMPTY", "EPERM"]) &&
        (await verifyFile(entry.destination, entry.item))
      ) {
        await unlink(entry.partial).catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  async fsyncFileAndParent(filename: string): Promise<void> {
    const file = await open(filename, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      const directory = await open(path.dirname(filename), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!hasCode(error, ["EINVAL", "EISDIR", "EPERM", "ENOTSUP", "EOPNOTSUPP"])) {
        throw error;
      }
      this.logger.warn("archive_directory_fsync_unavailable");
    }
  }
}

export const archiveAgentInternals = {
  stableIdempotencyKey,
  sha256File,
  verifyFile,
};
