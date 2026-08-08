import { describe, expect, it } from "vitest";

import {
  acknowledgeArchiveItem,
  createArchiveManifest,
  projectCallSheetForRecipient,
  safeRelativeArchivePath,
  validateArchiveManifest,
  verifyArchiveItem,
  type ArchiveAcknowledgement,
  type IssuedCallSheet,
} from "../src";
import { fingerprint, id } from "./fixtures";

describe("NAS archive manifest safety", () => {
  const helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  it("normalizes only safe relative destinations and rejects traversal or platform escapes", () => {
    expect(safeRelativeArchivePath("05-locations/scout photos/entrance.jpg")).toBe(
      "05-locations/scout photos/entrance.jpg",
    );
    for (const unsafe of [
      "../secret",
      "folder/../secret",
      "/absolute/file",
      "C:\\archive\\file",
      "folder\\file",
      "folder/%2e%2e/secret",
      "folder//file",
      "manifest/NUL.txt",
      "folder/trailing. ",
    ]) {
      expect(() => safeRelativeArchivePath(unsafe), unsafe).toThrow();
    }
  });

  it("creates a stable sorted manifest hash and detects tampering and case collisions", async () => {
    const manifest = await createArchiveManifest({
      schemaVersion: "1.0",
      snapshotId: id(1),
      projectId: id(2),
      createdAt: 100,
      items: [
        {
          id: id(4),
          safeRelativePath: "11-data-exports/z.txt",
          sizeBytes: 5,
          mimeType: "text/plain",
          sha256: helloHash,
        },
        {
          id: id(3),
          safeRelativePath: "00-project-development/a.txt",
          sizeBytes: 5,
          mimeType: "text/plain",
          sha256: helloHash,
        },
      ],
    });
    expect(manifest.items.map((item) => item.safeRelativePath)).toEqual([
      "00-project-development/a.txt",
      "11-data-exports/z.txt",
    ]);
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(validateArchiveManifest(manifest)).resolves.toBeUndefined();
    await expect(validateArchiveManifest({ ...manifest, createdAt: 101 })).rejects.toThrow(
      /hash does not match/,
    );

    await expect(
      createArchiveManifest({
        schemaVersion: "1.0",
        snapshotId: id(1),
        projectId: id(2),
        createdAt: 100,
        items: [
          {
            id: id(3),
            safeRelativePath: "Files/A.txt",
            sizeBytes: 5,
            mimeType: "text/plain",
            sha256: helloHash,
          },
          {
            id: id(4),
            safeRelativePath: "files/a.txt",
            sizeBytes: 5,
            mimeType: "text/plain",
            sha256: helloHash,
          },
        ],
      }),
    ).rejects.toThrow(/case-insensitive/);
  });

  it("blocks missing bytes, size mismatch, and checksum mismatch from verification", async () => {
    await expect(
      verifyArchiveItem({ sizeBytes: 5, sha256: helloHash }, new TextEncoder().encode("hello")),
    ).resolves.toEqual({
      verified: true,
    });
    await expect(
      verifyArchiveItem({ sizeBytes: 6, sha256: helloHash }, new TextEncoder().encode("hello")),
    ).rejects.toThrow(/size mismatch/);
    await expect(
      verifyArchiveItem(
        { sizeBytes: 5, sha256: fingerprint("a") },
        new TextEncoder().encode("hello"),
      ),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it("acknowledges retries idempotently but rejects mismatched duplicates", () => {
    const acknowledgement: ArchiveAcknowledgement = {
      jobId: id(10),
      itemId: id(11),
      sizeBytes: 5,
      sha256: helloHash,
      verifiedAt: 100,
    };
    expect(acknowledgeArchiveItem(undefined, acknowledgement)).toBe(acknowledgement);
    expect(acknowledgeArchiveItem(acknowledgement, { ...acknowledgement, verifiedAt: 200 })).toBe(
      acknowledgement,
    );
    expect(() =>
      acknowledgeArchiveItem(acknowledgement, { ...acknowledgement, sha256: fingerprint("b") }),
    ).toThrowError(/conflicts/);
  });
});

describe("recipient-isolated call-sheet projection", () => {
  const sheet: IssuedCallSheet = {
    issueId: id(20),
    issueNumber: 1,
    contentHash: fingerprint("c"),
    projectTitle: "Night Bus",
    companyName: "Sinbod Wayne",
    shootDate: "2026-10-12",
    confidentiality: "Private production information",
    publicSections: [
      { key: "safety", title: "Safety", body: "Meet at the signed assembly point." },
    ],
    recipients: [
      {
        recipientId: id(21),
        recipientIssueId: id(22),
        displayName: "Alex Example",
        roleLabel: "Cast",
        email: "alex@example.test",
        phone: "+31 000 000 001",
        rateMinor: 12_500,
        calls: [
          { label: "General", time: "07:00" },
          { label: "Makeup", time: "07:20" },
        ],
        privateNote: "Use the north entrance.",
        attachments: [{ fileVersionId: id(23), displayName: "Alex sides.pdf" }],
      },
      {
        recipientId: id(24),
        recipientIssueId: id(25),
        displayName: "Blair Example",
        roleLabel: "Camera",
        email: "blair@example.test",
        rateMinor: 18_000,
        calls: [{ label: "Pre-call", time: "06:30" }],
        privateNote: "Collect the camera van key.",
        attachments: [],
      },
    ],
    producerPrivateNotes: "Do not distribute the budget variance.",
    financeSummaryMinor: 999_999,
    legalPrivateNotes: "Agreement review detail.",
  };

  it("returns only the selected variant and an explicit public allow-list", () => {
    const projection = projectCallSheetForRecipient(sheet, id(22));
    expect(projection.recipient).toMatchObject({
      displayName: "Alex Example",
      privateNote: "Use the north entrance.",
    });
    expect(projection.recipient.calls).toContainEqual({ label: "General", time: "07:00" });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("Blair Example");
    expect(serialized).not.toContain("blair@example.test");
    expect(serialized).not.toContain("alex@example.test");
    expect(serialized).not.toContain("18000");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("Agreement review detail");
    expect(serialized).not.toContain("Do not distribute");
  });

  it("uses a generic denial for unknown recipient variants", () => {
    expect(() => projectCallSheetForRecipient(sheet, id(99))).toThrowError(
      "Recipient view is unavailable.",
    );
  });
});
