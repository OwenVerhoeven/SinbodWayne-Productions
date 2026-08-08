import { z } from "zod";

export const ARCHIVE_SERVICE_SCOPE = "archive:pull";
export const ARCHIVE_LEASE_MINIMUM_MS = 30_000;
export const ARCHIVE_LEASE_MAXIMUM_MS = 900_000;

const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const leaseRequestSchema = z
  .object({
    agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
    leaseDurationMs: z.number().int().min(ARCHIVE_LEASE_MINIMUM_MS).max(ARCHIVE_LEASE_MAXIMUM_MS),
  })
  .strict();

export const heartbeatRequestSchema = z
  .object({
    manifestHash: sha256Schema,
  })
  .strict();

export const itemAcknowledgementSchema = z
  .object({
    byteSize: z.number().int().min(0).safe(),
    sha256: sha256Schema,
    destinationPath: z.string().min(1).max(1_024),
  })
  .strict();

export const manifestAcknowledgementSchema = z
  .object({
    manifestHash: sha256Schema,
    itemCount: z.number().int().min(0).max(100_000),
  })
  .strict();

export const failureAcknowledgementSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    retryable: z.boolean(),
  })
  .strict();

export const archiveWorkflowPayloadSchema = z
  .object({
    archiveJobId: identifierSchema,
  })
  .strict();

export type LeaseRequest = z.infer<typeof leaseRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type ItemAcknowledgementInput = z.infer<typeof itemAcknowledgementSchema>;
export type ManifestAcknowledgementInput = z.infer<typeof manifestAcknowledgementSchema>;
export type FailureAcknowledgementInput = z.infer<typeof failureAcknowledgementSchema>;
export type ArchiveWorkflowPayload = z.infer<typeof archiveWorkflowPayloadSchema>;

export interface ArchiveServicePrincipal {
  readonly credentialId: string;
  readonly workspaceId: string;
}

export interface ArchiveManifestItemContract {
  readonly id: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly logicalFileId?: string;
  readonly fileVersionId?: string;
  readonly sourceRevisionIds?: readonly string[];
}

export interface ArchiveManifestContract {
  readonly schemaVersion: string;
  readonly projectId: string;
  readonly exportSnapshotId: string;
  readonly manifestHash: string;
  readonly items: readonly ArchiveManifestItemContract[];
}

export interface ArchiveLeaseContract {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly manifest: ArchiveManifestContract;
}

export interface ArchiveLeaseContext {
  readonly jobId: string;
  readonly attemptId: string;
  readonly credentialId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly exportSnapshotId: string;
  readonly manifestHash: string;
  readonly agentId: string;
  readonly expiresAt: number;
}

export interface ArchiveContentDescriptor {
  readonly objectKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly relativePath: string;
}

export type ArchiveJobStatus = "requested" | "running" | "verifying" | "verified" | "failed";

export interface ArchiveDownload {
  readonly status: 200 | 206;
  readonly body: ReadableStream;
  readonly byteSize: number;
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly mimeType: string;
  readonly sha256: string;
  readonly filename: string;
}
