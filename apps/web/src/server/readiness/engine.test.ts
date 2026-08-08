import { opaqueIdSchema } from "@swp/domain";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_READINESS_RULES,
  OWNER_ONLY_READINESS_CODES,
  activeOverrideForRule,
  compareSourceFingerprints,
  domainIssueHasBlockingResult,
  effectiveResult,
  isOwnerOnlyReadinessCode,
  resultFromObservation,
  summarizeReadiness,
  type RuleRuntime,
  type ViewResult,
} from "./engine";

const rule: RuleRuntime = {
  id: "019817b3-6c10-7000-8000-000000000001",
  code: "schedule_ready",
  title: "Schedule approved",
  category: "scheduling",
  categoryLabel: "Scheduling",
  scope: "shoot_day",
  severity: "blocker",
  required: true,
  automatic: true,
  ownerOnlyOverride: false,
  resolutionHref: "/projects/project/scheduling",
  sortRank: "a001",
};

function viewResult(
  effective: ViewResult["effective"],
  overrides: Partial<ViewResult> = {},
): ViewResult {
  return {
    id: "019817b3-6c10-7000-8000-000000000002",
    rule,
    stored: effective === "overridden" ? "blocker" : effective,
    effective,
    description: "Fixture result",
    owner: null,
    dueAt: null,
    sourceLabel: "Fixture",
    evidence: null,
    overrideId: effective === "overridden" ? "019817b3-6c10-7000-8000-000000000003" : null,
    ...overrides,
  };
}

describe("default readiness profile", () => {
  it("contains exactly 19 unique required gates covering project and shoot-day scope", () => {
    expect(DEFAULT_READINESS_RULES).toHaveLength(19);
    expect(new Set(DEFAULT_READINESS_RULES.map((item) => item.code)).size).toBe(19);
    expect(DEFAULT_READINESS_RULES.every((item) => item.required)).toBe(true);
    expect(new Set(DEFAULT_READINESS_RULES.map((item) => item.scope))).toEqual(
      new Set(["project", "shoot_day"]),
    );
  });

  it("restricts owner-only override policy to security, legal hold and archive integrity", () => {
    const restricted = DEFAULT_READINESS_RULES.filter((item) => item.ownerOnlyOverride).map(
      (item) => item.code,
    );
    expect(new Set(restricted)).toEqual(new Set(OWNER_ONLY_READINESS_CODES));
    expect(isOwnerOnlyReadinessCode("workspace_security")).toBe(true);
    expect(isOwnerOnlyReadinessCode("legal_hold")).toBe(true);
    expect(isOwnerOnlyReadinessCode("archive_integrity")).toBe(true);
    expect(isOwnerOnlyReadinessCode("legal_rights_clearance")).toBe(false);
  });
});

describe("readiness truth and effective overrides", () => {
  it("never turns missing or unloaded source data green", () => {
    expect(resultFromObservation(rule, { loaded: false, present: true, satisfied: true })).toBe(
      "unavailable",
    );
    expect(resultFromObservation(rule, { loaded: true, present: false, satisfied: true })).toBe(
      "unavailable",
    );
    expect(resultFromObservation(rule, { loaded: true, present: true, satisfied: false })).toBe(
      "blocker",
    );
    expect(resultFromObservation(rule, { loaded: true, present: true, satisfied: true })).toBe(
      "pass",
    );
  });

  it("applies only active, unrevoked overrides and never replaces a pass", () => {
    const active = {
      id: "active",
      ruleId: rule.id,
      expiresAt: 2_000,
      revokedAt: null,
    };
    const expired = { ...active, id: "expired", expiresAt: 999 };
    const revoked = { ...active, id: "revoked", revokedAt: 900 };
    expect(activeOverrideForRule(rule.id, [expired, revoked, active], 1_000)).toEqual(active);
    expect(activeOverrideForRule(rule.id, [expired, revoked], 1_000)).toBeUndefined();
    expect(effectiveResult("blocker", active)).toBe("overridden");
    expect(effectiveResult("pass", active)).toBe("pass");
  });

  it("keeps blocking, warning, pass, not-applicable and score totals deterministic", () => {
    const optional = { ...rule, id: "optional", required: false };
    const warning = { ...rule, id: "warning", severity: "warning" as const };
    const summary = summarizeReadiness([
      viewResult("pass"),
      viewResult("overridden", { id: "override" }),
      viewResult("blocker", { id: "blocker" }),
      viewResult("warning", { id: "warning", rule: warning, stored: "warning" }),
      viewResult("unavailable", { id: "optional", rule: optional, stored: "unavailable" }),
    ]);
    expect(summary).toEqual({
      blocking: 1,
      warnings: 1,
      passed: 2,
      notApplicable: 1,
      total: 5,
      score: 50,
      ready: false,
    });
  });
});

describe("snapshot staleness and issue guards", () => {
  it("identifies the exact changed or missing rule source", () => {
    const reasons = compareSourceFingerprints({
      prior: [
        { ruleId: "writing", sourceHash: "a".repeat(64) },
        { ruleId: "schedule", sourceHash: "b".repeat(64) },
      ],
      current: new Map([["writing", "c".repeat(64)]]),
      ruleLabels: new Map([
        ["writing", "Current writing approved and synced"],
        ["schedule", "Schedule approved and conflicts cleared"],
      ]),
    });
    expect(reasons).toEqual([
      {
        ruleId: "writing",
        priorHash: "a".repeat(64),
        currentHash: "c".repeat(64),
        reason: "Current writing approved and synced: source data changed after evaluation.",
      },
      {
        ruleId: "schedule",
        priorHash: "b".repeat(64),
        currentHash: null,
        reason: "Schedule approved and conflicts cleared: source is no longer available.",
      },
    ]);
  });

  it("refuses an immutable issue whenever a required blocker is not satisfied or overridden", () => {
    const base = {
      ruleId: opaqueIdSchema.parse("019817b3-6c10-7000-8000-000000000001"),
      key: "schedule_ready",
      category: "scheduling",
      required: true,
      severity: "blocker" as const,
      message: "Fixture",
      evidence: [],
    };
    expect(domainIssueHasBlockingResult([{ ...base, status: "blocked" }])).toBe(true);
    expect(domainIssueHasBlockingResult([{ ...base, status: "missing" }])).toBe(true);
    expect(domainIssueHasBlockingResult([{ ...base, status: "satisfied" }])).toBe(false);
    expect(
      domainIssueHasBlockingResult([
        {
          ...base,
          status: "overridden",
          overrideId: opaqueIdSchema.parse("019817b3-6c10-7000-8000-000000000003"),
        },
      ]),
    ).toBe(false);
  });
});
