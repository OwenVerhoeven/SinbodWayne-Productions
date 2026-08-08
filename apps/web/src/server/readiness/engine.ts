import {
  opaqueIdSchema,
  type JsonValue,
  type ReadinessResult as DomainReadinessResult,
} from "@swp/domain";

export const OWNER_ONLY_READINESS_CODES = [
  "workspace_security",
  "legal_hold",
  "archive_integrity",
] as const;

export type OwnerOnlyReadinessCode = (typeof OWNER_ONLY_READINESS_CODES)[number];

export interface DefaultReadinessRule {
  readonly code: string;
  readonly title: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly scope: "project" | "shoot_day";
  readonly severity: "blocker" | "warning";
  readonly required: boolean;
  readonly ownerOnlyOverride: boolean;
  readonly resolutionSegment: string;
}

/**
 * The fixed launch profile has 19 gates. Closely coupled requirements are deliberately evaluated
 * together so a single green row cannot conceal a broken dependency (for example, an approved
 * script with an unresolved production sync).
 */
export const DEFAULT_READINESS_RULES = [
  {
    code: "development_approved",
    title: "Development package approved",
    category: "development",
    categoryLabel: "Development",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "development",
  },
  {
    code: "writing_approved_synced",
    title: "Current writing approved and synced",
    category: "writing",
    categoryLabel: "Writing",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "writing/screenplay",
  },
  {
    code: "breakdown_complete",
    title: "Scene breakdown complete",
    category: "breakdown",
    categoryLabel: "Breakdown",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "breakdown",
  },
  {
    code: "cast_ready",
    title: "Cast booked and cleared",
    category: "people",
    categoryLabel: "Cast & Crew",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "casting",
  },
  {
    code: "crew_ready",
    title: "Required crew confirmed",
    category: "people",
    categoryLabel: "Cast & Crew",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "people",
  },
  {
    code: "locations_ready",
    title: "Locations approved and available",
    category: "locations",
    categoryLabel: "Locations",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "locations",
  },
  {
    code: "budget_ready",
    title: "Budget approved and within policy",
    category: "finance",
    categoryLabel: "Finance",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "budget",
  },
  {
    code: "legal_rights_clearance",
    title: "Legal, rights and clearances complete",
    category: "legal_safety",
    categoryLabel: "Legal & Safety",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "legal",
  },
  {
    code: "legal_hold",
    title: "No unresolved legal-hold restriction",
    category: "legal_safety",
    categoryLabel: "Legal & Safety",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: true,
    resolutionSegment: "legal",
  },
  {
    code: "insurance_current",
    title: "Insurance is current",
    category: "legal_safety",
    categoryLabel: "Legal & Safety",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "legal",
  },
  {
    code: "safety_ready",
    title: "Risk and safety plans approved",
    category: "legal_safety",
    categoryLabel: "Legal & Safety",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "safety",
  },
  {
    code: "equipment_ready",
    title: "Equipment reserved and conflict-free",
    category: "resources",
    categoryLabel: "Equipment & Logistics",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "equipment",
  },
  {
    code: "department_resources_ready",
    title: "Props, wardrobe and art resources ready",
    category: "resources",
    categoryLabel: "Equipment & Logistics",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "resources",
  },
  {
    code: "logistics_ready",
    title: "Transport, catering and logistics ready",
    category: "resources",
    categoryLabel: "Equipment & Logistics",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "logistics",
  },
  {
    code: "schedule_ready",
    title: "Schedule approved and conflicts cleared",
    category: "scheduling",
    categoryLabel: "Scheduling",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "scheduling",
  },
  {
    code: "visual_plan_ready",
    title: "Visual and technical plan approved",
    category: "visual",
    categoryLabel: "Visual Planning",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "visual-planning",
  },
  {
    code: "issued_documents_ready",
    title: "Sides, call sheet and production pack issued",
    category: "documents",
    categoryLabel: "Documents",
    scope: "shoot_day",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: false,
    resolutionSegment: "documents",
  },
  {
    code: "archive_integrity",
    title: "Export and archive snapshot healthy",
    category: "integrity",
    categoryLabel: "Integrity",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: true,
    resolutionSegment: "archive",
  },
  {
    code: "workspace_security",
    title: "Workspace account boundary healthy",
    category: "integrity",
    categoryLabel: "Integrity",
    scope: "project",
    severity: "blocker",
    required: true,
    ownerOnlyOverride: true,
    resolutionSegment: "settings",
  },
] as const satisfies readonly DefaultReadinessRule[];

export interface SourceObservation {
  readonly loaded: boolean;
  readonly present: boolean;
  readonly satisfied: boolean;
  readonly description: string;
  readonly sourceLabel: string | null;
  readonly evidence: string | null;
  readonly ownerId: string | null;
  readonly dueAt: number | null;
  readonly sourceHash: string;
  /** Canonical, immutable evidence input whose digest is sourceHash. */
  readonly snapshot: JsonValue;
}

export type StoredResultKind = "pass" | "warning" | "blocker" | "unavailable";
export type EffectiveResultKind = StoredResultKind | "overridden";

export interface RuleRuntime {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly scope: "project" | "shoot_day";
  readonly severity: "blocker" | "warning";
  readonly required: boolean;
  readonly automatic: boolean;
  readonly ownerOnlyOverride: boolean;
  readonly resolutionHref: string;
  readonly sortRank: string;
}

export interface OverrideRuntime {
  readonly id: string;
  readonly ruleId: string;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export interface ViewResult {
  readonly id: string;
  readonly rule: RuleRuntime;
  readonly stored: StoredResultKind;
  readonly effective: EffectiveResultKind;
  readonly description: string;
  readonly owner: string | null;
  readonly dueAt: number | null;
  readonly sourceLabel: string | null;
  readonly evidence: string | null;
  readonly overrideId: string | null;
}

export interface ReadinessSummary {
  readonly blocking: number;
  readonly warnings: number;
  readonly passed: number;
  readonly notApplicable: number;
  readonly total: number;
  readonly score: number;
  readonly ready: boolean;
}

export function isOwnerOnlyReadinessCode(code: string): code is OwnerOnlyReadinessCode {
  return OWNER_ONLY_READINESS_CODES.some((restricted) => restricted === code);
}

export function resultFromObservation(
  rule: Pick<RuleRuntime, "required" | "severity">,
  observation: Pick<SourceObservation, "loaded" | "present" | "satisfied">,
): StoredResultKind {
  if (!observation.loaded || !observation.present) return "unavailable";
  if (observation.satisfied) return "pass";
  return rule.severity;
}

export function activeOverrideForRule(
  ruleId: string,
  overrides: readonly OverrideRuntime[],
  now: number,
): OverrideRuntime | undefined {
  return overrides
    .filter(
      (override) =>
        override.ruleId === ruleId &&
        override.revokedAt === null &&
        (override.expiresAt === null || override.expiresAt > now),
    )
    .at(-1);
}

export function effectiveResult(
  stored: StoredResultKind,
  override: OverrideRuntime | undefined,
): EffectiveResultKind {
  if (stored === "pass" || override === undefined) return stored;
  return "overridden";
}

export function summarizeReadiness(results: readonly ViewResult[]): ReadinessSummary {
  let blocking = 0;
  let warnings = 0;
  let passed = 0;
  let notApplicable = 0;
  let requiredTotal = 0;
  let requiredPassed = 0;

  for (const result of results) {
    if (!result.rule.required) {
      notApplicable += 1;
      continue;
    }
    requiredTotal += 1;
    if (result.effective === "pass" || result.effective === "overridden") {
      passed += 1;
      requiredPassed += 1;
    } else if (result.effective === "warning") {
      warnings += 1;
    } else {
      blocking += 1;
    }
  }

  return {
    blocking,
    warnings,
    passed,
    notApplicable,
    total: results.length,
    score: requiredTotal === 0 ? 0 : Math.floor((requiredPassed * 100) / requiredTotal),
    ready: blocking === 0,
  };
}

export function toDomainResult(result: ViewResult): DomainReadinessResult {
  const status =
    result.effective === "pass"
      ? "satisfied"
      : result.effective === "overridden"
        ? "overridden"
        : result.effective === "warning"
          ? "warning"
          : result.effective === "unavailable"
            ? "missing"
            : "blocked";
  return {
    ruleId: opaqueIdSchema.parse(result.rule.id),
    key: result.rule.code,
    category: result.rule.category,
    status,
    required: result.rule.required,
    severity: result.rule.severity,
    message: result.description,
    evidence: [],
    ...(result.overrideId === null ? {} : { overrideId: opaqueIdSchema.parse(result.overrideId) }),
  };
}

export interface SourceFingerprint {
  readonly ruleId: string;
  readonly sourceHash: string;
}

export interface StaleReason {
  readonly ruleId: string;
  readonly reason: string;
  readonly priorHash: string;
  readonly currentHash: string | null;
}

export function compareSourceFingerprints(input: {
  readonly prior: readonly SourceFingerprint[];
  readonly current: ReadonlyMap<string, string>;
  readonly ruleLabels: ReadonlyMap<string, string>;
}): readonly StaleReason[] {
  const reasons: StaleReason[] = [];
  for (const prior of input.prior) {
    const currentHash = input.current.get(prior.ruleId);
    if (currentHash === prior.sourceHash) continue;
    const label = input.ruleLabels.get(prior.ruleId) ?? "Readiness source";
    reasons.push({
      ruleId: prior.ruleId,
      priorHash: prior.sourceHash,
      currentHash: currentHash ?? null,
      reason:
        currentHash === undefined
          ? `${label}: source is no longer available.`
          : `${label}: source data changed after evaluation.`,
    });
  }
  return reasons.sort((left, right) => left.reason.localeCompare(right.reason));
}

export function domainIssueHasBlockingResult(results: readonly DomainReadinessResult[]): boolean {
  return results.some(
    (result) =>
      result.required &&
      result.severity === "blocker" &&
      result.status !== "satisfied" &&
      result.status !== "overridden",
  );
}
