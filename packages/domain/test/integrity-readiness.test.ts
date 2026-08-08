import { describe, expect, it } from "vitest";

import {
  appendApprovalDecision,
  assertImmutableRecordUnchanged,
  assertValidSupersedingArtifact,
  beginIdempotentOperation,
  completeIdempotentOperation,
  createReadinessIssue,
  detectReadinessStaleness,
  evaluateReadiness,
  hashIdempotencyKey,
  validateFileVersionSet,
  validateSnapshotPins,
  type ApprovalDecision,
  type ReadinessOverride,
  type ReadinessRule,
  type SnapshotPin,
} from "../src";
import { fingerprint, id } from "./fixtures";

describe("append-only and immutable records", () => {
  it("requires corrections to create a valid superseding issue", () => {
    const prior = { id: id(1), issueNumber: 1, issuedAt: 100, contentHash: fingerprint("a") };
    expect(() => assertImmutableRecordUnchanged(prior, { ...prior })).not.toThrow();
    expect(() => assertImmutableRecordUnchanged(prior, { ...prior, issueNumber: 2 })).toThrowError(
      /cannot be modified/,
    );
    expect(() =>
      assertValidSupersedingArtifact(prior, {
        id: id(2),
        issueNumber: 2,
        issuedAt: 101,
        contentHash: fingerprint("b"),
        supersedesId: id(1),
      }),
    ).not.toThrow();
    expect(() =>
      assertValidSupersedingArtifact(prior, {
        id: id(2),
        issueNumber: 1,
        issuedAt: 101,
        contentHash: fingerprint("b"),
        supersedesId: id(1),
      }),
    ).toThrowError(/must advance/);
  });

  it("appends approval decisions against pinned versions without rewriting history", () => {
    const requested: ApprovalDecision = {
      id: id(10),
      approvalId: id(11),
      state: "requested",
      actorId: id(12),
      decidedAt: 100,
      comment: "Review requested.",
      pinnedObjectId: id(13),
      pinnedVersionId: id(14),
    };
    const approved: ApprovalDecision = {
      id: id(15),
      approvalId: id(11),
      state: "approved",
      actorId: id(16),
      decidedAt: 110,
      comment: "Approved.",
      pinnedObjectId: id(13),
      pinnedVersionId: id(14),
      supersedesDecisionId: id(10),
    };
    const history = appendApprovalDecision(appendApprovalDecision([], requested), approved);
    expect(history).toEqual([requested, approved]);
    expect(() =>
      appendApprovalDecision(history, { ...approved, id: id(17), supersedesDecisionId: id(10) }),
    ).toThrowError(/latest decision/);
  });

  it("validates immutable file-version chains and exact snapshot pins", () => {
    const versions = [1, 2].map((versionNumber) => ({
      id: id(20 + versionNumber),
      fileId: id(20),
      versionNumber,
      objectKey: `files/v${versionNumber}`,
      sizeBytes: versionNumber,
      sha256: fingerprint(String(versionNumber)),
      mimeType: "application/pdf",
      createdAt: 100 + versionNumber,
    }));
    expect(() =>
      validateFileVersionSet({ fileId: id(20), versions, currentVersionId: id(22) }),
    ).not.toThrow();
    expect(() =>
      validateFileVersionSet({
        fileId: id(20),
        versions: [{ ...versions[1]!, versionNumber: 3 }],
        currentVersionId: id(22),
      }),
    ).toThrowError(/unbroken sequence/);
    expect(() =>
      validateSnapshotPins([
        { objectType: "file", objectId: id(20), versionId: id(21), contentHash: fingerprint("1") },
        { objectType: "file", objectId: id(20), versionId: id(22), contentHash: fingerprint("2") },
      ]),
    ).toThrowError(/two versions/);
  });
});

describe("Ready to Shoot evaluation and immutable issues", () => {
  const ownerRule: ReadinessRule = {
    id: id(30),
    key: "archive_integrity",
    category: "Archive integrity",
    required: true,
    severity: "blocker",
    automatic: true,
    ownerOnlyOverride: true,
  };
  const permitRule: ReadinessRule = {
    id: id(31),
    key: "location_permit",
    category: "Legal",
    required: true,
    severity: "blocker",
    automatic: true,
    ownerOnlyOverride: false,
  };
  const pin = (versionSequence: number, hashCharacter = "a"): SnapshotPin => ({
    objectType: "schedule_revision",
    objectId: id(40),
    versionId: id(versionSequence),
    contentHash: fingerprint(hashCharacter),
  });
  const source = (satisfied: boolean, evidence: readonly SnapshotPin[] = []) => ({
    loaded: true,
    satisfied,
    message: satisfied ? "Complete" : "Not complete",
    evidence,
  });

  it("treats missing and unloaded data as non-green blockers", () => {
    const evaluation = evaluateReadiness({
      rules: [ownerRule, permitRule],
      sources: { [id(30)]: { ...source(true), loaded: false } },
      overrides: [],
      scopeId: id(32),
      now: 1_000,
    });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.scorePercent).toBe(0);
    expect(evaluation.results.map((result) => result.status)).toEqual(["unloaded", "missing"]);
  });

  it("enforces owner-only overrides while allowing a producer to override an ordinary blocker with evidence", () => {
    const producerOwnerOverride: ReadinessOverride = {
      id: id(33),
      ruleId: id(30),
      actorId: id(34),
      actorRole: "producer",
      scope: "project",
      scopeId: id(32),
      reason: "Documented exception for this controlled fixture.",
      createdAt: 900,
    };
    expect(() =>
      evaluateReadiness({
        rules: [ownerRule],
        sources: { [id(30)]: source(false) },
        overrides: [producerOwnerOverride],
        scopeId: id(32),
        now: 1_000,
      }),
    ).toThrowError(/only be overridden by the owner/);

    const permittedOverride: ReadinessOverride = {
      ...producerOwnerOverride,
      id: id(35),
      ruleId: id(31),
    };
    const evaluation = evaluateReadiness({
      rules: [ownerRule, permitRule],
      sources: { [id(30)]: source(true), [id(31)]: source(false) },
      overrides: [permittedOverride],
      scopeId: id(32),
      now: 1_000,
    });
    expect(evaluation.ready).toBe(true);
    expect(evaluation.scorePercent).toBe(100);
    expect(evaluation.results[1]).toMatchObject({ status: "overridden", overrideId: id(35) });
  });

  it("requires actor/date evidence for manual checks", () => {
    const manualRule = { ...permitRule, id: id(36), automatic: false };
    expect(() =>
      evaluateReadiness({
        rules: [manualRule],
        sources: { [id(36)]: source(true) },
        overrides: [],
        scopeId: id(32),
        now: 1_000,
      }),
    ).toThrowError(/named actor, date, and evidence/);
  });

  it("freezes a hash and reports exact source changes as stale", async () => {
    const evaluation = evaluateReadiness({
      rules: [ownerRule],
      sources: { [id(30)]: source(true, [pin(41)]) },
      overrides: [],
      scopeId: id(32),
      now: 1_000,
    });
    const issue = await createReadinessIssue({
      id: id(42),
      issueNumber: 1,
      issuedAt: 1_000,
      actorId: id(43),
      scopeId: id(32),
      results: evaluation.results,
      sourcePins: [pin(41)],
    });
    expect(issue.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detectReadinessStaleness(issue, [pin(41)])).toEqual({ stale: false, changes: [] });
    const stale = detectReadinessStaleness(issue, [pin(44, "b")]);
    expect(stale.stale).toBe(true);
    expect(stale.changes[0]).toMatchObject({
      kind: "changed",
      objectId: id(40),
      priorVersionId: id(41),
      currentVersionId: id(44),
    });
  });
});

describe("idempotent issue, export, and archive actions", () => {
  it("replays the same completed request and rejects key reuse with a changed request", async () => {
    const keyHash = await hashIdempotencyKey("fixture-operation-key-0001");
    const requestHash = fingerprint("a");
    const begun = beginIdempotentOperation({
      keyHash,
      scope: "archive:project-1",
      requestHash,
      now: 100,
      expiresAt: 1_000,
    });
    expect(begun.action).toBe("execute");
    if (begun.action !== "execute") throw new Error("Expected execution.");
    const completed = completeIdempotentOperation(begun.record, { jobId: "job-fixture" });
    const replay = beginIdempotentOperation({
      existing: completed,
      keyHash,
      scope: "archive:project-1",
      requestHash,
      now: 200,
      expiresAt: 1_000,
    });
    expect(replay).toMatchObject({ action: "replay", response: { jobId: "job-fixture" } });
    expect(() =>
      beginIdempotentOperation({
        existing: completed,
        keyHash,
        scope: "archive:project-1",
        requestHash: fingerprint("b"),
        now: 200,
        expiresAt: 1_000,
      }),
    ).toThrowError(/different operation/);
    expect(() => completeIdempotentOperation(completed, { jobId: "replacement" })).toThrowError(
      /cannot be replaced/,
    );
  });
});
