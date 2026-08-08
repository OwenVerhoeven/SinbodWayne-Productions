import { z } from "zod";

import { hashCanonicalJson, type JsonValue } from "./canonical";
import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";
import { snapshotPinSchema, type SnapshotPin } from "./immutability";

export const readinessRuleSchema = z
  .object({
    id: opaqueIdSchema,
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/),
    category: z.string().min(1).max(100),
    required: z.boolean(),
    severity: z.enum(["blocker", "warning"]),
    automatic: z.boolean(),
    ownerOnlyOverride: z.boolean(),
  })
  .strict();

export type ReadinessRule = z.infer<typeof readinessRuleSchema>;

export interface ReadinessSourceState {
  readonly loaded: boolean;
  readonly satisfied: boolean;
  readonly message: string;
  readonly ownerId?: OpaqueId;
  readonly dueAt?: number;
  readonly evidence: readonly SnapshotPin[];
  readonly manualActorId?: OpaqueId;
  readonly manualRecordedAt?: number;
}

export const readinessOverrideSchema = z
  .object({
    id: opaqueIdSchema,
    ruleId: opaqueIdSchema,
    actorId: opaqueIdSchema,
    actorRole: z.enum(["workspace_owner", "producer"]),
    scope: z.enum(["project", "shoot_day"]),
    scopeId: opaqueIdSchema,
    reason: z.string().min(10).max(5_000),
    createdAt: z.number().int().min(0),
    expiresAt: z.number().int().min(0).optional(),
  })
  .strict();

export type ReadinessOverride = z.infer<typeof readinessOverrideSchema>;

export interface ReadinessResult {
  readonly ruleId: OpaqueId;
  readonly key: string;
  readonly category: string;
  readonly status: "satisfied" | "blocked" | "warning" | "overridden" | "missing" | "unloaded";
  readonly required: boolean;
  readonly severity: "blocker" | "warning";
  readonly message: string;
  readonly evidence: readonly SnapshotPin[];
  readonly overrideId?: OpaqueId;
}

export interface ReadinessEvaluation {
  readonly ready: boolean;
  readonly scorePercent: number;
  readonly results: readonly ReadinessResult[];
  readonly blockingCount: number;
  readonly warningCount: number;
}

function activeOverride(
  rule: ReadinessRule,
  overrides: readonly ReadinessOverride[],
  scopeId: OpaqueId,
  now: number,
): ReadinessOverride | undefined {
  return overrides
    .filter(
      (override) =>
        override.ruleId === rule.id &&
        override.scopeId === scopeId &&
        (override.expiresAt === undefined || override.expiresAt > now),
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
}

export function assertReadinessOverrideAuthorized(
  rule: ReadinessRule,
  override: ReadinessOverride,
): void {
  readinessRuleSchema.parse(rule);
  readinessOverrideSchema.parse(override);
  if (override.ruleId !== rule.id)
    throw new DomainError("INVALID_INPUT", "Override targets a different rule.");
  if (rule.ownerOnlyOverride && override.actorRole !== "workspace_owner") {
    throw new DomainError(
      "AUTHORIZATION_DENIED",
      "This readiness category can only be overridden by the owner.",
    );
  }
}

export function evaluateReadiness(input: {
  readonly rules: readonly ReadinessRule[];
  readonly sources: Readonly<Record<string, ReadinessSourceState | undefined>>;
  readonly overrides: readonly ReadinessOverride[];
  readonly scopeId: OpaqueId;
  readonly now: number;
}): ReadinessEvaluation {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new DomainError("INVALID_INPUT", "Evaluation timestamp must be a UTC epoch integer.");
  }
  const rules = input.rules.map((rule) => readinessRuleSchema.parse(rule));
  const overrides = input.overrides.map((override) => readinessOverrideSchema.parse(override));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new DomainError("INVALID_INPUT", "Readiness rule IDs must be unique.");
  }
  const results: ReadinessResult[] = rules.map((rule) => {
    const source = input.sources[rule.id];
    if (source === undefined) {
      return {
        ruleId: rule.id,
        key: rule.key,
        category: rule.category,
        status: "missing",
        required: rule.required,
        severity: rule.severity,
        message: "Source data is missing.",
        evidence: [],
      };
    }
    for (const pin of source.evidence) snapshotPinSchema.parse(pin);
    if (!source.loaded) {
      return {
        ruleId: rule.id,
        key: rule.key,
        category: rule.category,
        status: "unloaded",
        required: rule.required,
        severity: rule.severity,
        message: source.message || "Source data was not loaded.",
        evidence: source.evidence,
      };
    }
    if (
      !rule.automatic &&
      source.satisfied &&
      (source.manualActorId === undefined ||
        source.manualRecordedAt === undefined ||
        source.evidence.length === 0)
    ) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "A satisfied manual readiness check needs a named actor, date, and evidence.",
      );
    }
    if (source.satisfied) {
      return {
        ruleId: rule.id,
        key: rule.key,
        category: rule.category,
        status: "satisfied",
        required: rule.required,
        severity: rule.severity,
        message: source.message,
        evidence: source.evidence,
      };
    }
    const override = activeOverride(rule, overrides, input.scopeId, input.now);
    if (override !== undefined) {
      assertReadinessOverrideAuthorized(rule, override);
      return {
        ruleId: rule.id,
        key: rule.key,
        category: rule.category,
        status: "overridden",
        required: rule.required,
        severity: rule.severity,
        message: source.message,
        evidence: source.evidence,
        overrideId: override.id,
      };
    }
    return {
      ruleId: rule.id,
      key: rule.key,
      category: rule.category,
      status: rule.severity === "blocker" ? "blocked" : "warning",
      required: rule.required,
      severity: rule.severity,
      message: source.message,
      evidence: source.evidence,
    };
  });

  const required = results.filter((result) => result.required);
  const fulfilled = required.filter(
    (result) => result.status === "satisfied" || result.status === "overridden",
  );
  const blockingCount = results.filter(
    (result) =>
      result.required &&
      result.severity === "blocker" &&
      result.status !== "satisfied" &&
      result.status !== "overridden",
  ).length;
  const warningCount = results.filter((result) => result.status === "warning").length;
  return {
    ready: blockingCount === 0,
    scorePercent:
      required.length === 0 ? 0 : Math.floor((fulfilled.length * 100) / required.length),
    results,
    blockingCount,
    warningCount,
  };
}

export interface ReadinessIssue {
  readonly id: OpaqueId;
  readonly issueNumber: number;
  readonly issuedAt: number;
  readonly actorId: OpaqueId;
  readonly scopeId: OpaqueId;
  readonly results: readonly ReadinessResult[];
  readonly sourcePins: readonly SnapshotPin[];
  readonly manifestHash: string;
  readonly supersedesId?: OpaqueId;
}

export async function createReadinessIssue(
  input: Omit<ReadinessIssue, "manifestHash">,
): Promise<ReadinessIssue> {
  if (
    input.results.some(
      (result) =>
        result.required &&
        result.severity === "blocker" &&
        !["satisfied", "overridden"].includes(result.status),
    )
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "A readiness issue cannot be frozen while required blockers remain.",
    );
  }
  const hashInput = {
    id: input.id,
    issueNumber: input.issueNumber,
    issuedAt: input.issuedAt,
    actorId: input.actorId,
    scopeId: input.scopeId,
    results: input.results,
    sourcePins: input.sourcePins,
    ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
  } as unknown as JsonValue;
  return { ...input, manifestHash: await hashCanonicalJson(hashInput) };
}

export interface ReadinessStaleness {
  readonly stale: boolean;
  readonly changes: readonly {
    readonly objectType: string;
    readonly objectId: OpaqueId;
    readonly priorVersionId?: OpaqueId;
    readonly currentVersionId?: OpaqueId;
    readonly kind: "changed" | "removed" | "added";
  }[];
}

export function detectReadinessStaleness(
  issue: Pick<ReadinessIssue, "sourcePins">,
  currentPins: readonly SnapshotPin[],
): ReadinessStaleness {
  const oldMap = new Map(issue.sourcePins.map((pin) => [`${pin.objectType}:${pin.objectId}`, pin]));
  const newMap = new Map(currentPins.map((pin) => [`${pin.objectType}:${pin.objectId}`, pin]));
  const changes: ReadinessStaleness["changes"][number][] = [];
  for (const [key, prior] of oldMap) {
    const current = newMap.get(key);
    if (current === undefined) {
      changes.push({
        objectType: prior.objectType,
        objectId: prior.objectId,
        priorVersionId: prior.versionId,
        kind: "removed",
      });
    } else if (current.versionId !== prior.versionId || current.contentHash !== prior.contentHash) {
      changes.push({
        objectType: prior.objectType,
        objectId: prior.objectId,
        priorVersionId: prior.versionId,
        currentVersionId: current.versionId,
        kind: "changed",
      });
    }
  }
  for (const [key, current] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({
        objectType: current.objectType,
        objectId: current.objectId,
        currentVersionId: current.versionId,
        kind: "added",
      });
    }
  }
  changes.sort((left, right) =>
    `${left.objectType}:${left.objectId}`.localeCompare(`${right.objectType}:${right.objectId}`),
  );
  return { stale: changes.length > 0, changes };
}
