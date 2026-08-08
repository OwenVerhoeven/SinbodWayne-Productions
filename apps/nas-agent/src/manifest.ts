import { createHash } from "node:crypto";

import { ArchiveAgentError } from "./errors.ts";
import { normalizeManifestPath } from "./path-policy.ts";
import type { ArchiveManifest, ArchiveManifestItem } from "./types.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function orderedItem(item: ArchiveManifestItem): Record<string, unknown> {
  return {
    id: item.id,
    relativePath: item.relativePath,
    byteSize: item.byteSize,
    mimeType: item.mimeType,
    sha256: item.sha256.toLowerCase(),
    logicalFileId: item.logicalFileId ?? null,
    fileVersionId: item.fileVersionId ?? null,
    sourceRevisionIds: [...(item.sourceRevisionIds ?? [])].sort(),
  };
}

export function canonicalManifestJson(manifest: Omit<ArchiveManifest, "manifestHash">): string {
  const items = [...manifest.items]
    .sort((left, right) => {
      if (left.id !== right.id) return left.id < right.id ? -1 : 1;
      if (left.relativePath === right.relativePath) return 0;
      return left.relativePath < right.relativePath ? -1 : 1;
    })
    .map(orderedItem);

  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    projectId: manifest.projectId,
    exportSnapshotId: manifest.exportSnapshotId,
    items,
  });
}

export function manifestDigest(manifest: Omit<ArchiveManifest, "manifestHash">): string {
  return createHash("sha256").update(canonicalManifestJson(manifest), "utf8").digest("hex");
}

export function validateManifest(manifest: ArchiveManifest): void {
  if (!Array.isArray(manifest.items) || manifest.items.length > 100_000) {
    throw new ArchiveAgentError(
      "INVALID_MANIFEST",
      "Manifest item collection is invalid or too large",
    );
  }
  if (!IDENTIFIER.test(manifest.schemaVersion)) {
    throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest schema version is invalid");
  }
  if (!IDENTIFIER.test(manifest.projectId) || !IDENTIFIER.test(manifest.exportSnapshotId)) {
    throw new ArchiveAgentError(
      "INVALID_MANIFEST",
      "Manifest project or snapshot identity is invalid",
    );
  }
  if (!SHA256_HEX.test(manifest.manifestHash.toLowerCase())) {
    throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest digest is invalid");
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of manifest.items) {
    if (!IDENTIFIER.test(item.id) || ids.has(item.id)) {
      throw new ArchiveAgentError(
        "INVALID_MANIFEST",
        "Manifest contains an invalid or duplicate item identity",
      );
    }
    if (
      (item.logicalFileId !== undefined && !IDENTIFIER.test(item.logicalFileId)) ||
      (item.fileVersionId !== undefined && !IDENTIFIER.test(item.fileVersionId)) ||
      (item.sourceRevisionIds !== undefined &&
        (!Array.isArray(item.sourceRevisionIds) ||
          item.sourceRevisionIds.length > 10_000 ||
          item.sourceRevisionIds.some(
            (identity: unknown) => typeof identity !== "string" || !IDENTIFIER.test(identity),
          )))
    ) {
      throw new ArchiveAgentError(
        "INVALID_MANIFEST",
        "Manifest contains an invalid source identity",
      );
    }
    if (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0) {
      throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest contains an invalid byte size");
    }
    if (!SHA256_HEX.test(item.sha256.toLowerCase())) {
      throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest contains an invalid item digest");
    }
    if (!item.mimeType || item.mimeType.length > 255 || /[\r\n]/.test(item.mimeType)) {
      throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest contains an invalid media type");
    }
    const portablePath = normalizeManifestPath(item.relativePath).toLocaleLowerCase("en-US");
    if (paths.has(portablePath)) {
      throw new ArchiveAgentError(
        "INVALID_MANIFEST",
        "Manifest contains a duplicate destination path",
      );
    }
    ids.add(item.id);
    paths.add(portablePath);
  }

  const computed = manifestDigest({
    schemaVersion: manifest.schemaVersion,
    projectId: manifest.projectId,
    exportSnapshotId: manifest.exportSnapshotId,
    items: manifest.items,
  });
  if (computed !== manifest.manifestHash.toLowerCase()) {
    throw new ArchiveAgentError("INVALID_MANIFEST", "Manifest checksum verification failed");
  }
}
