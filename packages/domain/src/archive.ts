import { z } from "zod";

import { hashCanonicalJson, sha256Hex, type JsonValue } from "./canonical";
import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

const windowsDevicePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safeRelativeArchivePath(input: string): string {
  if (input.length === 0 || input.length > 1_024) {
    throw new DomainError("INVALID_INPUT", "Archive destination path length is invalid.");
  }
  if (/^[/\\]/.test(input) || /^[a-zA-Z]:/.test(input) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    throw new DomainError("INVALID_INPUT", "Archive destination must be a relative path.");
  }
  const hasControlCharacter = [...input].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (input.includes("\\") || /%(?:2e|2f|5c|00)/i.test(input) || hasControlCharacter) {
    throw new DomainError(
      "INVALID_INPUT",
      "Archive destination contains an unsafe encoded or control character.",
    );
  }
  const normalized = input.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new DomainError(
      "INVALID_INPUT",
      "Archive destination contains an empty or traversal segment.",
    );
  }
  for (const segment of segments) {
    if (
      segment.length > 255 ||
      /[<>:"|?*]/.test(segment) ||
      /[. ]$/.test(segment) ||
      windowsDevicePattern.test(segment)
    ) {
      throw new DomainError(
        "INVALID_INPUT",
        "Archive destination contains a cross-platform unsafe segment.",
        {
          segment,
        },
      );
    }
  }
  return segments.join("/");
}

export const archiveManifestItemSchema = z
  .object({
    id: opaqueIdSchema,
    safeRelativePath: z.string().min(1).max(1_024),
    sizeBytes: z.number().int().min(0).safe(),
    mimeType: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileVersionId: opaqueIdSchema.optional(),
    sourceRevisionId: opaqueIdSchema.optional(),
  })
  .strict();

export type ArchiveManifestItem = z.infer<typeof archiveManifestItemSchema>;

export const archiveManifestSchema = z
  .object({
    schemaVersion: z.string().regex(/^\d+\.\d+$/),
    snapshotId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    createdAt: z.number().int().min(0),
    items: z.array(archiveManifestItemSchema),
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

type UnhashedManifest = Omit<ArchiveManifest, "manifestHash">;

function validateUnhashedManifest(manifest: UnhashedManifest): void {
  if (new Set(manifest.items.map((item) => item.id)).size !== manifest.items.length) {
    throw new DomainError("INVARIANT_VIOLATION", "Archive manifest item IDs must be unique.");
  }
  const exactPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const item of manifest.items) {
    archiveManifestItemSchema.parse(item);
    const safePath = safeRelativeArchivePath(item.safeRelativePath);
    if (safePath !== item.safeRelativePath) {
      throw new DomainError("INVARIANT_VIOLATION", "Manifest path must already be normalized.");
    }
    const folded = safePath.toLocaleLowerCase("en-GB");
    if (exactPaths.has(safePath) || foldedPaths.has(folded)) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Archive paths must not collide, including on case-insensitive filesystems.",
      );
    }
    exactPaths.add(safePath);
    foldedPaths.add(folded);
  }
}

export async function createArchiveManifest(input: UnhashedManifest): Promise<ArchiveManifest> {
  validateUnhashedManifest(input);
  const sortedInput: UnhashedManifest = {
    ...input,
    items: [...input.items].sort((left, right) =>
      left.safeRelativePath === right.safeRelativePath
        ? 0
        : left.safeRelativePath < right.safeRelativePath
          ? -1
          : 1,
    ),
  };
  const manifestHash = await hashCanonicalJson(sortedInput as unknown as JsonValue);
  return { ...sortedInput, manifestHash };
}

export async function validateArchiveManifest(manifest: ArchiveManifest): Promise<void> {
  const parsed = archiveManifestSchema.parse(manifest);
  const { manifestHash, ...unhashed } = parsed;
  validateUnhashedManifest(unhashed);
  const expected = await hashCanonicalJson(unhashed as unknown as JsonValue);
  if (expected !== manifestHash) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Archive manifest hash does not match its contents.",
    );
  }
}

export async function verifyArchiveItem(
  expected: Pick<ArchiveManifestItem, "sizeBytes" | "sha256">,
  bytes: Uint8Array,
): Promise<{ readonly verified: true }> {
  if (bytes.byteLength !== expected.sizeBytes) {
    throw new DomainError("INVARIANT_VIOLATION", "Archive item size mismatch.", {
      expected: expected.sizeBytes,
      actual: bytes.byteLength,
    });
  }
  const actualHash = await sha256Hex(bytes);
  if (actualHash !== expected.sha256) {
    throw new DomainError("INVARIANT_VIOLATION", "Archive item checksum mismatch.");
  }
  return { verified: true };
}

export interface ArchiveAcknowledgement {
  readonly jobId: OpaqueId;
  readonly itemId: OpaqueId;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly verifiedAt: number;
}

export function acknowledgeArchiveItem(
  prior: ArchiveAcknowledgement | undefined,
  next: ArchiveAcknowledgement,
): ArchiveAcknowledgement {
  if (prior === undefined) return next;
  if (
    prior.jobId !== next.jobId ||
    prior.itemId !== next.itemId ||
    prior.sizeBytes !== next.sizeBytes ||
    prior.sha256 !== next.sha256
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Archive item acknowledgement conflicts with the prior acknowledgement.",
    );
  }
  return prior;
}
