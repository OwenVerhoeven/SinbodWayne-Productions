export interface ArchiveManifestItem {
  readonly id: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly logicalFileId?: string;
  readonly fileVersionId?: string;
  readonly sourceRevisionIds?: readonly string[];
}

export interface ArchiveManifest {
  readonly schemaVersion: string;
  readonly projectId: string;
  readonly exportSnapshotId: string;
  readonly manifestHash: string;
  readonly items: readonly ArchiveManifestItem[];
}

export interface ArchiveLease {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly manifest: ArchiveManifest;
}

export interface DownloadResponse {
  readonly status: number;
  readonly contentLength?: number;
  readonly contentRange?: string;
  readonly body: AsyncIterable<Uint8Array> | null;
}

export interface ItemAcknowledgement {
  readonly byteSize: number;
  readonly sha256: string;
  readonly destinationPath: string;
}

export interface ManifestAcknowledgement {
  readonly manifestHash: string;
  readonly itemCount: number;
}

export interface JobFailure {
  readonly code: string;
  readonly retryable: boolean;
}

export interface ArchiveServiceClient {
  leaseNextJob(
    agentId: string,
    leaseDurationMs: number,
    signal?: AbortSignal,
  ): Promise<ArchiveLease | null>;
  heartbeat(lease: ArchiveLease, signal?: AbortSignal): Promise<void>;
  downloadItem(
    lease: ArchiveLease,
    item: ArchiveManifestItem,
    offset: number,
    signal?: AbortSignal,
  ): Promise<DownloadResponse>;
  acknowledgeItem(
    lease: ArchiveLease,
    item: ArchiveManifestItem,
    acknowledgement: ItemAcknowledgement,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void>;
  acknowledgeManifest(
    lease: ArchiveLease,
    acknowledgement: ManifestAcknowledgement,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void>;
  failJob(
    lease: ArchiveLease,
    failure: JobFailure,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface SpaceProbe {
  availableBytes(destinationRoot: string): Promise<bigint | null>;
}

export interface AgentLogger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ArchiveAgentOptions {
  readonly agentId: string;
  readonly destinationRoot: string;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly downloadAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly minimumFreeSpaceBytes: bigint;
}

export type RunResult =
  | { readonly kind: "idle" }
  | { readonly kind: "verified"; readonly jobId: string; readonly itemCount: number }
  | {
      readonly kind: "failed";
      readonly jobId: string;
      readonly code: string;
      readonly retryable: boolean;
    };
