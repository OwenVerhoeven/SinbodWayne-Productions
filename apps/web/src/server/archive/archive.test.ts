import { describe, expect, it } from "vitest";

import { sha256Hex, timingSafeHexEqual } from "./crypto";
import { ArchiveServiceError } from "./errors";
import {
  archiveManifestDigest,
  canonicalArchiveManifestJson,
  validateArchiveManifestContract,
} from "./manifest";
import { resolveArchiveByteRange } from "./range";
import type { ArchiveManifestContract } from "./types";

async function fixtureManifest(): Promise<ArchiveManifestContract> {
  const unsigned = {
    schemaVersion: "1.0.0",
    projectId: "project-01",
    exportSnapshotId: "snapshot-01",
    items: [
      {
        id: "item-b",
        relativePath: "11-data-exports/project.json",
        byteSize: 3,
        mimeType: "application/json",
        sha256: await sha256Hex(new TextEncoder().encode("two")),
        sourceRevisionIds: ["revision-b", "revision-a"],
      },
      {
        id: "item-a",
        relativePath: "00-project-development/brief.pdf",
        byteSize: 3,
        mimeType: "application/pdf",
        sha256: await sha256Hex(new TextEncoder().encode("one")),
        logicalFileId: "file-01",
        fileVersionId: "version-01",
      },
    ],
  } as const;
  return { ...unsigned, manifestHash: await archiveManifestDigest(unsigned) };
}

describe("archive service integrity helpers", () => {
  it("uses the NAS agent's canonical manifest key and sort order", async () => {
    const manifest = await fixtureManifest();
    const unsigned = {
      schemaVersion: manifest.schemaVersion,
      projectId: manifest.projectId,
      exportSnapshotId: manifest.exportSnapshotId,
      items: manifest.items,
    };
    const parsed = JSON.parse(canonicalArchiveManifestJson(unsigned)) as {
      items: Array<Record<string, unknown>>;
    };

    expect(parsed.items.map((item) => item.id)).toEqual(["item-a", "item-b"]);
    expect(parsed.items[0]).toEqual({
      id: "item-a",
      relativePath: "00-project-development/brief.pdf",
      byteSize: 3,
      mimeType: "application/pdf",
      sha256: manifest.items[1]?.sha256,
      logicalFileId: "file-01",
      fileVersionId: "version-01",
      sourceRevisionIds: [],
    });
    expect(parsed.items[1]?.sourceRevisionIds).toEqual(["revision-a", "revision-b"]);
    await expect(validateArchiveManifestContract(manifest)).resolves.toBeUndefined();
  });

  it("rejects traversal, portable path collisions and a changed digest", async () => {
    const manifest = await fixtureManifest();
    await expect(
      validateArchiveManifestContract({
        ...manifest,
        items: [{ ...manifest.items[0]!, relativePath: "../escape" }],
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
    await expect(
      validateArchiveManifestContract({
        ...manifest,
        items: [
          manifest.items[0]!,
          { ...manifest.items[1]!, relativePath: manifest.items[0]!.relativePath.toUpperCase() },
        ],
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
    await expect(
      validateArchiveManifestContract({ ...manifest, manifestHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });

  it("compares valid digest encodings without accepting malformed input", async () => {
    const digest = await sha256Hex("archive-token");
    expect(timingSafeHexEqual(digest, digest)).toBe(true);
    expect(timingSafeHexEqual(digest, "0".repeat(64))).toBe(false);
    expect(timingSafeHexEqual(digest, "not-a-digest")).toBe(false);
  });
});

describe("archive byte ranges", () => {
  it("supports full and resumable open-ended downloads", () => {
    expect(resolveArchiveByteRange(null, 100)).toEqual({
      start: 0,
      end: 99,
      length: 100,
      partial: false,
    });
    expect(resolveArchiveByteRange("bytes=40-", 100)).toEqual({
      start: 40,
      end: 99,
      length: 60,
      partial: true,
    });
    expect(resolveArchiveByteRange("bytes=40-200", 100)).toEqual({
      start: 40,
      end: 99,
      length: 60,
      partial: true,
    });
  });

  it.each(["bytes=-20", "bytes=100-", "items=0-2", "bytes=20-10", "bytes=0-1,4-5"])(
    "rejects unsupported or unsatisfiable range %s",
    (header) => {
      expect(() => resolveArchiveByteRange(header, 100)).toThrowError(ArchiveServiceError);
    },
  );
});
