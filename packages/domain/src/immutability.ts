import { z } from "zod";

import { canonicalJson, type JsonValue } from "./canonical";
import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

export function assertImmutableRecordUnchanged(
  before: JsonValue,
  after: JsonValue,
  label = "Issued record",
): void {
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new DomainError(
      "IMMUTABLE_RECORD",
      `${label} cannot be modified; create a superseding record.`,
    );
  }
}

export const immutableArtifactSchema = z
  .object({
    id: opaqueIdSchema,
    issueNumber: z.number().int().positive(),
    issuedAt: z.number().int().min(0),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    supersedesId: opaqueIdSchema.optional(),
  })
  .strict();

export type ImmutableArtifact = z.infer<typeof immutableArtifactSchema>;

export function assertValidSupersedingArtifact(
  previous: ImmutableArtifact,
  next: ImmutableArtifact,
): void {
  const prior = immutableArtifactSchema.parse(previous);
  const successor = immutableArtifactSchema.parse(next);
  if (successor.id === prior.id || successor.supersedesId !== prior.id) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Correction must have a new ID and point to the issue it supersedes.",
    );
  }
  if (successor.issueNumber !== prior.issueNumber + 1 || successor.issuedAt < prior.issuedAt) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Superseding issue number and timestamp must advance.",
    );
  }
}

export const approvalDecisionSchema = z
  .object({
    id: opaqueIdSchema,
    approvalId: opaqueIdSchema,
    state: z.enum([
      "requested",
      "approved",
      "changes_requested",
      "rejected",
      "expired",
      "superseded",
    ]),
    actorId: opaqueIdSchema,
    decidedAt: z.number().int().min(0),
    comment: z.string().max(10_000),
    pinnedObjectId: opaqueIdSchema,
    pinnedVersionId: opaqueIdSchema,
    supersedesDecisionId: opaqueIdSchema.optional(),
  })
  .strict();

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export function appendApprovalDecision(
  history: readonly ApprovalDecision[],
  decision: ApprovalDecision,
): readonly ApprovalDecision[] {
  const prior = history.map((row) => approvalDecisionSchema.parse(row));
  const next = approvalDecisionSchema.parse(decision);
  if (prior.some((row) => row.id === next.id)) {
    throw new DomainError("IMMUTABLE_RECORD", "Approval decision IDs are append-only.");
  }
  if (prior.some((row) => row.approvalId !== next.approvalId)) {
    throw new DomainError("INVARIANT_VIOLATION", "Approval history cannot mix approval requests.");
  }
  const latest = prior.at(-1);
  if (latest !== undefined) {
    if (next.decidedAt < latest.decidedAt || next.supersedesDecisionId !== latest.id) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Approval decision must supersede the current latest decision.",
      );
    }
    if (
      next.pinnedObjectId !== latest.pinnedObjectId ||
      next.pinnedVersionId !== latest.pinnedVersionId
    ) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "An approval history cannot switch its pinned object or version.",
      );
    }
  } else if (next.supersedesDecisionId !== undefined) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "First approval decision cannot supersede another decision.",
    );
  }
  return [...prior, next];
}

export const fileVersionSchema = z
  .object({
    id: opaqueIdSchema,
    fileId: opaqueIdSchema,
    versionNumber: z.number().int().positive(),
    objectKey: z.string().min(1).max(1_024),
    sizeBytes: z.number().int().min(0).safe(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mimeType: z.string().min(1).max(255),
    createdAt: z.number().int().min(0),
  })
  .strict();

export type FileVersion = z.infer<typeof fileVersionSchema>;

export function validateFileVersionSet(input: {
  readonly fileId: OpaqueId;
  readonly versions: readonly FileVersion[];
  readonly currentVersionId: OpaqueId;
}): void {
  const versions = input.versions.map((version) => fileVersionSchema.parse(version));
  if (versions.length === 0)
    throw new DomainError("INVARIANT_VIOLATION", "Logical file needs at least one version.");
  if (versions.some((version) => version.fileId !== input.fileId)) {
    throw new DomainError("INVARIANT_VIOLATION", "File version belongs to another logical file.");
  }
  if (new Set(versions.map((version) => version.id)).size !== versions.length) {
    throw new DomainError("INVARIANT_VIOLATION", "File version IDs must be unique.");
  }
  const numbers = versions
    .map((version) => version.versionNumber)
    .sort((left, right) => left - right);
  if (numbers.some((number, index) => number !== index + 1)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "File version numbers must form an unbroken sequence.",
    );
  }
  if (!versions.some((version) => version.id === input.currentVersionId)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Current file pointer must reference one immutable version.",
    );
  }
}

export const snapshotPinSchema = z
  .object({
    objectType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    objectId: opaqueIdSchema,
    versionId: opaqueIdSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type SnapshotPin = z.infer<typeof snapshotPinSchema>;

export function validateSnapshotPins(pins: readonly SnapshotPin[]): void {
  const parsed = pins.map((pin) => snapshotPinSchema.parse(pin));
  const keys = parsed.map((pin) => `${pin.objectType}:${pin.objectId}`);
  if (new Set(keys).size !== keys.length) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "A snapshot cannot pin two versions of the same object.",
    );
  }
}
