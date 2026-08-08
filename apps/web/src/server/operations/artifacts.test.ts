import { describe, expect, it } from "vitest";

import {
  buildCallSheetIssue,
  buildProductionPackManifest,
  calculateRevisionConflicts,
  calculateRevisionTotals,
  canonicalJson,
  safeRelativePath,
} from "./artifacts";

const ids = {
  itemA: "018e9920-3030-7000-8000-000000000001",
  itemB: "018e9920-3030-7000-8000-000000000002",
  resource: "018e9920-3030-7000-8000-000000000003",
  recipientA: "018e9920-3030-7000-8000-000000000004",
  recipientB: "018e9920-3030-7000-8000-000000000005",
  recipientIssueA: "018e9920-3030-7000-8000-000000000006",
  recipientIssueB: "018e9920-3030-7000-8000-000000000007",
  issue: "018e9920-3030-7000-8000-000000000008",
  project: "018e9920-3030-7000-8000-000000000009",
  draft: "018e9920-3030-7000-8000-00000000000a",
  entry: "018e9920-3030-7000-8000-00000000000b",
} as const;

describe("operations artifacts", () => {
  it("totals integer eighths and every timing bucket without floating point drift", () => {
    const totals = calculateRevisionTotals([
      {
        id: ids.itemA,
        unit: "Main",
        pageEighths: 7,
        prepDurationMs: 60_000,
        setupDurationMs: 120_000,
        shootDurationMs: 600_000,
        moveDurationMs: 0,
        mealDurationMs: 0,
      },
      {
        id: ids.itemB,
        unit: "Main",
        pageEighths: 10,
        prepDurationMs: 0,
        setupDurationMs: 0,
        shootDurationMs: 0,
        moveDurationMs: 300_000,
        mealDurationMs: 1_800_000,
      },
    ]);
    expect(totals.pageEighths).toBe(17);
    expect(totals.totalMs).toBe(2_880_000);
    expect(totals.estimatedWrapOffsetMs).toBe(2_880_000);
  });

  it("detects the same-resource overlap as a blocker", () => {
    const conflicts = calculateRevisionConflicts({
      assignments: [
        {
          assignmentId: ids.itemA,
          scheduleItemId: ids.itemA,
          resourceType: "equipment",
          resourceId: ids.resource,
          startMs: 1_000,
          endMs: 5_000,
          unit: "Main",
          minimumTurnaroundMs: 0,
        },
        {
          assignmentId: ids.itemB,
          scheduleItemId: ids.itemB,
          resourceType: "equipment",
          resourceId: ids.resource,
          startMs: 4_000,
          endMs: 8_000,
          unit: "Second",
          minimumTurnaroundMs: 0,
        },
      ],
      availability: [],
      travelDurations: [],
    });
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "overlap", severity: "blocker", overlapMs: 1_000 }),
    ]);
  });

  it("builds recipient variants without leaking another recipient", async () => {
    const issued = await buildCallSheetIssue({
      issueId: ids.issue,
      issueNumber: 1,
      projectTitle: "North Window",
      companyName: "Sinbod Wayne",
      shootDate: "2026-10-12",
      confidentiality: "Private",
      sections: [{ key: "schedule", title: "Schedule", body: "07:00 General call" }],
      recipients: [
        {
          recipientId: ids.recipientA,
          recipientIssueId: ids.recipientIssueA,
          displayName: "Avery Lane",
          roleLabel: "Director",
          calls: [{ label: "General", time: "07:00" }],
          privateNote: "Use gate A",
        },
        {
          recipientId: ids.recipientB,
          recipientIssueId: ids.recipientIssueB,
          displayName: "Morgan Vale",
          roleLabel: "Sound mixer",
          calls: [{ label: "General", time: "07:30" }],
          privateNote: "Collect radio pack",
        },
      ],
    });
    const a = issued.variants.get(ids.recipientIssueA)?.json ?? "";
    expect(a).toContain("Avery Lane");
    expect(a).toContain("Use gate A");
    expect(a).not.toContain("Morgan Vale");
    expect(a).not.toContain("Collect radio pack");
    expect(issued.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("orders and hashes a deterministic pinned production-pack manifest", async () => {
    const input = {
      issueId: ids.issue,
      issueNumber: 2,
      projectId: ids.project,
      draftId: ids.draft,
      createdAt: 1_700_000_000_000,
      entries: [
        {
          id: ids.entry,
          sectionType: "call-sheet",
          title: "Call Sheet",
          relativePath: "call-sheet/call-sheet.pdf",
          sortRank: "b",
          objectId: null,
          fileVersionId: null,
          revisionOrIssueId: ids.issue,
          byteSize: null,
          mimeType: null,
          sha256: null,
        },
      ],
    } as const;
    const first = await buildProductionPackManifest(input);
    const second = await buildProductionPackManifest(input);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.json).toBe(canonicalJson(first.manifest));
  });

  it("normalizes a pack destination path and blocks traversal semantics", () => {
    expect(safeRelativePath("07 Legal/Safety", "../Location: Release")).toBe(
      "07-legal-safety/location-release.pdf",
    );
  });
});
