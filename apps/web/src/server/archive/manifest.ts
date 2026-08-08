import { safeRelativeArchivePath } from "@swp/domain";

import { ArchiveServiceError } from "./errors";
import { sha256Hex, timingSafeHexEqual } from "./crypto";
import type { ArchiveManifestContract, ArchiveManifestItemContract } from "./types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function orderedItem(item: ArchiveManifestItemContract): Record<string, unknown> {
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

export function canonicalArchiveManifestJson(
  manifest: Omit<ArchiveManifestContract, "manifestHash">,
): string {
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

export async function archiveManifestDigest(
  manifest: Omit<ArchiveManifestContract, "manifestHash">,
): Promise<string> {
  return sha256Hex(canonicalArchiveManifestJson(manifest));
}

export async function validateArchiveManifestContract(
  manifest: ArchiveManifestContract,
): Promise<void> {
  if (
    !IDENTIFIER.test(manifest.schemaVersion) ||
    !IDENTIFIER.test(manifest.projectId) ||
    !IDENTIFIER.test(manifest.exportSnapshotId) ||
    !SHA256.test(manifest.manifestHash)
  ) {
    throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest metadata is invalid.");
  }
  if (manifest.items.length === 0) {
    throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest contains no items.");
  }
  const itemIds = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const item of manifest.items) {
    let normalizedPath: string;
    try {
      normalizedPath = safeRelativeArchivePath(item.relativePath);
    } catch {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest path is unsafe.");
    }
    const foldedPath = normalizedPath.toLocaleLowerCase("en-US");
    if (
      normalizedPath !== item.relativePath ||
      !IDENTIFIER.test(item.id) ||
      itemIds.has(item.id) ||
      foldedPaths.has(foldedPath) ||
      !Number.isSafeInteger(item.byteSize) ||
      item.byteSize < 0 ||
      !item.mimeType ||
      item.mimeType.length > 255 ||
      /[\r\n]/u.test(item.mimeType) ||
      !SHA256.test(item.sha256)
    ) {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest item is invalid.");
    }
    itemIds.add(item.id);
    foldedPaths.add(foldedPath);
  }
  const { manifestHash, ...unsigned } = manifest;
  const actual = await archiveManifestDigest(unsigned);
  if (!timingSafeHexEqual(actual, manifestHash)) {
    throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest hash does not match.");
  }
}
