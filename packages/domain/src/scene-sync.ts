import { z } from "zod";

import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const downstreamLinkSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    objectId: opaqueIdSchema,
  })
  .strict();

export type DownstreamLink = z.infer<typeof downstreamLinkSchema>;

export const canonicalSceneSchema = z
  .object({
    id: opaqueIdSchema,
    displayNumber: z.string().min(1).max(24),
    order: z.number().int().min(0),
    slugline: z.string().min(1).max(500),
    contentFingerprint: fingerprintSchema,
    omitted: z.boolean(),
    archived: z.boolean(),
    downstreamLinks: z.array(downstreamLinkSchema),
  })
  .strict();

export type CanonicalScene = z.infer<typeof canonicalSceneSchema>;

export const incomingSceneSchema = z
  .object({
    draftSceneId: opaqueIdSchema,
    proposedSceneId: opaqueIdSchema,
    order: z.number().int().min(0),
    slugline: z.string().min(1).max(500),
    contentFingerprint: fingerprintSchema,
    priorSceneId: opaqueIdSchema.optional(),
    candidateSceneIds: z.array(opaqueIdSchema),
  })
  .strict();

export type IncomingScene = z.infer<typeof incomingSceneSchema>;

export type SceneMatchReason =
  | "manual"
  | "prior_identity"
  | "fingerprint"
  | "candidate"
  | "slugline"
  | "new"
  | "ambiguous_candidate"
  | "ambiguous_slugline"
  | "missing_prior_identity"
  | "duplicate_mapping";

export interface SceneSyncEntry {
  readonly draftSceneId: OpaqueId;
  readonly incomingOrder: number;
  readonly status: "matched" | "added" | "ambiguous";
  readonly canonicalSceneId?: OpaqueId;
  readonly candidateSceneIds: readonly OpaqueId[];
  readonly reason: SceneMatchReason;
  readonly revised: boolean;
  readonly moved: boolean;
  readonly assignedDisplayNumber?: string;
  readonly downstreamLinks: readonly DownstreamLink[];
}

export interface RemovedScenePreview {
  readonly canonicalSceneId: OpaqueId;
  readonly displayNumber: string;
  readonly downstreamLinks: readonly DownstreamLink[];
  readonly blockedByAmbiguousDraftIds: readonly OpaqueId[];
}

export interface SceneSyncPreview {
  readonly lockedNumbering: boolean;
  readonly entries: readonly SceneSyncEntry[];
  readonly removed: readonly RemovedScenePreview[];
  readonly hasUnresolvedMappings: boolean;
}

function normalizedSlugline(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("en-GB");
}

function assertUnique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new DomainError("INVALID_INPUT", `${label} must be unique.`);
  }
}

/** Returns indexes that participate in one deterministic longest increasing subsequence. */
function longestIncreasingSubsequencePositions(values: readonly number[]): Set<number> {
  if (values.length === 0) return new Set();
  const lengths = values.map(() => 1);
  const previous = values.map(() => -1);
  let bestIndex = 0;
  for (let current = 0; current < values.length; current += 1) {
    for (let candidate = 0; candidate < current; candidate += 1) {
      if (values[candidate]! < values[current]! && lengths[candidate]! + 1 > lengths[current]!) {
        lengths[current] = lengths[candidate]! + 1;
        previous[current] = candidate;
      }
    }
    if (lengths[current]! > lengths[bestIndex]!) bestIndex = current;
  }
  const positions = new Set<number>();
  for (let cursor = bestIndex; cursor >= 0; cursor = previous[cursor]!) {
    positions.add(cursor);
    if (previous[cursor] === -1) break;
  }
  return positions;
}

function letters(index: number): string {
  let remaining = index;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function numericPrefix(displayNumber: string): string {
  return /^(\d+)/.exec(displayNumber)?.[1] ?? "0";
}

function assignDisplayNumbers(
  entries: readonly SceneSyncEntry[],
  canonicalById: ReadonlyMap<OpaqueId, CanonicalScene>,
  locked: boolean,
): SceneSyncEntry[] {
  if (!locked) {
    return entries.map((entry, index) =>
      entry.status === "ambiguous" ? entry : { ...entry, assignedDisplayNumber: String(index + 1) },
    );
  }

  const used = new Set(
    [...canonicalById.values()].map((scene) => scene.displayNumber.toLocaleUpperCase("en-GB")),
  );
  let precedingBase = "0";
  const nextSuffixByBase = new Map<string, number>();
  return entries.map((entry) => {
    if (entry.status === "matched") {
      const display = canonicalById.get(entry.canonicalSceneId!)!.displayNumber;
      precedingBase = numericPrefix(display);
      return { ...entry, assignedDisplayNumber: display };
    }
    if (entry.status === "ambiguous") return entry;

    let suffixIndex = nextSuffixByBase.get(precedingBase) ?? 1;
    let display = `${precedingBase}${letters(suffixIndex)}`;
    while (used.has(display.toLocaleUpperCase("en-GB"))) {
      suffixIndex += 1;
      display = `${precedingBase}${letters(suffixIndex)}`;
    }
    nextSuffixByBase.set(precedingBase, suffixIndex + 1);
    used.add(display.toLocaleUpperCase("en-GB"));
    return { ...entry, assignedDisplayNumber: display };
  });
}

export function previewSceneSync(input: {
  readonly canonicalScenes: readonly CanonicalScene[];
  readonly incomingScenes: readonly IncomingScene[];
  readonly lockedNumbering: boolean;
  readonly manualMappings?: Readonly<Record<string, OpaqueId>>;
}): SceneSyncPreview {
  const canonicalScenes = input.canonicalScenes.map((scene) => canonicalSceneSchema.parse(scene));
  const incomingScenes = input.incomingScenes
    .map((scene) => incomingSceneSchema.parse(scene))
    .sort(
      (left, right) =>
        left.order - right.order || left.draftSceneId.localeCompare(right.draftSceneId),
    );
  assertUnique(
    canonicalScenes.map((scene) => scene.id),
    "Canonical scene IDs",
  );
  assertUnique(
    canonicalScenes.map((scene) => scene.order),
    "Canonical scene order values",
  );
  assertUnique(
    incomingScenes.map((scene) => scene.draftSceneId),
    "Draft scene IDs",
  );
  assertUnique(
    incomingScenes.map((scene) => scene.order),
    "Incoming scene order values",
  );

  const canonicalById = new Map(canonicalScenes.map((scene) => [scene.id, scene]));
  const matchedIds = new Set<OpaqueId>();
  const provisional: SceneSyncEntry[] = [];

  for (const incoming of incomingScenes) {
    const manual = input.manualMappings?.[incoming.draftSceneId];
    let candidates: OpaqueId[];
    let reason: SceneMatchReason;

    if (manual !== undefined) {
      if (!canonicalById.has(manual)) {
        throw new DomainError(
          "INVALID_INPUT",
          "A manual scene mapping targets an unknown canonical scene.",
          {
            draftSceneId: incoming.draftSceneId,
            canonicalSceneId: manual,
          },
        );
      }
      candidates = [manual];
      reason = "manual";
    } else if (incoming.priorSceneId !== undefined) {
      if (!canonicalById.has(incoming.priorSceneId)) {
        provisional.push({
          draftSceneId: incoming.draftSceneId,
          incomingOrder: incoming.order,
          status: "ambiguous",
          candidateSceneIds: [],
          reason: "missing_prior_identity",
          revised: false,
          moved: false,
          downstreamLinks: [],
        });
        continue;
      }
      candidates = [incoming.priorSceneId];
      reason = "prior_identity";
    } else {
      const fingerprintMatches = canonicalScenes
        .filter(
          (scene) =>
            !matchedIds.has(scene.id) && scene.contentFingerprint === incoming.contentFingerprint,
        )
        .map((scene) => scene.id);
      if (fingerprintMatches.length === 1) {
        candidates = fingerprintMatches;
        reason = "fingerprint";
      } else {
        const proposed = [...new Set(incoming.candidateSceneIds)].filter(
          (sceneId) => canonicalById.has(sceneId) && !matchedIds.has(sceneId),
        );
        if (proposed.length > 0) {
          candidates = proposed;
          reason = proposed.length === 1 ? "candidate" : "ambiguous_candidate";
        } else {
          const slugMatches = canonicalScenes
            .filter(
              (scene) =>
                !matchedIds.has(scene.id) &&
                normalizedSlugline(scene.slugline) === normalizedSlugline(incoming.slugline),
            )
            .map((scene) => scene.id);
          candidates = slugMatches;
          reason =
            slugMatches.length > 1
              ? "ambiguous_slugline"
              : slugMatches.length === 1
                ? "slugline"
                : "new";
        }
      }
    }

    if (candidates.length > 1) {
      provisional.push({
        draftSceneId: incoming.draftSceneId,
        incomingOrder: incoming.order,
        status: "ambiguous",
        candidateSceneIds: candidates,
        reason,
        revised: false,
        moved: false,
        downstreamLinks: candidates.flatMap(
          (candidate) => canonicalById.get(candidate)!.downstreamLinks,
        ),
      });
      continue;
    }

    const candidate = candidates[0];
    if (candidate !== undefined) {
      if (matchedIds.has(candidate)) {
        provisional.push({
          draftSceneId: incoming.draftSceneId,
          incomingOrder: incoming.order,
          status: "ambiguous",
          candidateSceneIds: [candidate],
          reason: "duplicate_mapping",
          revised: false,
          moved: false,
          downstreamLinks: canonicalById.get(candidate)!.downstreamLinks,
        });
        continue;
      }
      const canonical = canonicalById.get(candidate)!;
      matchedIds.add(candidate);
      provisional.push({
        draftSceneId: incoming.draftSceneId,
        incomingOrder: incoming.order,
        status: "matched",
        canonicalSceneId: candidate,
        candidateSceneIds: [candidate],
        reason,
        revised:
          canonical.contentFingerprint !== incoming.contentFingerprint ||
          normalizedSlugline(canonical.slugline) !== normalizedSlugline(incoming.slugline),
        moved: false,
        downstreamLinks: canonical.downstreamLinks,
      });
    } else {
      provisional.push({
        draftSceneId: incoming.draftSceneId,
        incomingOrder: incoming.order,
        status: "added",
        candidateSceneIds: [],
        reason: "new",
        revised: false,
        moved: false,
        downstreamLinks: [],
      });
    }
  }

  const orderedCanonical = [...canonicalScenes].sort((left, right) => left.order - right.order);
  const oldIndexById = new Map(orderedCanonical.map((scene, index) => [scene.id, index]));
  const matchedEntryPositions = provisional
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(
      (
        row,
      ): row is { entry: SceneSyncEntry & { canonicalSceneId: OpaqueId }; entryIndex: number } =>
        row.entry.status === "matched",
    );
  const oldIndexes = matchedEntryPositions.map((row) =>
    oldIndexById.get(row.entry.canonicalSceneId)!,
  );
  const stablePositions = longestIncreasingSubsequencePositions(oldIndexes);
  const movedEntryIndexes = new Set(
    matchedEntryPositions
      .filter((_, matchedPosition) => !stablePositions.has(matchedPosition))
      .map((row) => row.entryIndex),
  );
  const movementApplied = provisional.map((entry, index) =>
    movedEntryIndexes.has(index) ? { ...entry, moved: true } : entry,
  );
  const entries = assignDisplayNumbers(movementApplied, canonicalById, input.lockedNumbering);

  const ambiguousCandidates = new Map<OpaqueId, OpaqueId[]>();
  for (const entry of entries.filter((item) => item.status === "ambiguous")) {
    for (const candidate of entry.candidateSceneIds) {
      const drafts = ambiguousCandidates.get(candidate) ?? [];
      drafts.push(entry.draftSceneId);
      ambiguousCandidates.set(candidate, drafts);
    }
  }
  const removed = orderedCanonical
    .filter((scene) => !matchedIds.has(scene.id))
    .map((scene) => ({
      canonicalSceneId: scene.id,
      displayNumber: scene.displayNumber,
      downstreamLinks: scene.downstreamLinks,
      blockedByAmbiguousDraftIds: ambiguousCandidates.get(scene.id) ?? [],
    }));

  return {
    lockedNumbering: input.lockedNumbering,
    entries,
    removed,
    hasUnresolvedMappings: entries.some((entry) => entry.status === "ambiguous"),
  };
}

export type RemovedSceneDecision =
  | { readonly action: "omit" }
  | { readonly action: "archive" }
  | { readonly action: "remap"; readonly targetSceneId: OpaqueId };

export interface AppliedSceneSync {
  readonly scenes: readonly CanonicalScene[];
  readonly redirects: readonly { readonly fromSceneId: OpaqueId; readonly toSceneId: OpaqueId }[];
  readonly retainedDownstreamSceneIds: readonly OpaqueId[];
  readonly record: {
    readonly appliedAt: number;
    readonly entries: readonly SceneSyncEntry[];
    readonly removedDecisions: Readonly<Record<string, RemovedSceneDecision>>;
  };
}

export function applySceneSync(input: {
  readonly preview: SceneSyncPreview;
  readonly canonicalScenes: readonly CanonicalScene[];
  readonly incomingScenes: readonly IncomingScene[];
  readonly removedDecisions: Readonly<Record<string, RemovedSceneDecision>>;
  readonly appliedAt: number;
}): AppliedSceneSync {
  if (input.preview.hasUnresolvedMappings) {
    throw new DomainError(
      "SYNC_REQUIRES_REVIEW",
      "Ambiguous scene mappings must be resolved before apply.",
    );
  }
  if (!Number.isSafeInteger(input.appliedAt) || input.appliedAt < 0) {
    throw new DomainError(
      "INVALID_INPUT",
      "Applied timestamp must be a non-negative UTC epoch value.",
    );
  }
  const canonical = input.canonicalScenes.map((scene) => canonicalSceneSchema.parse(scene));
  const incoming = input.incomingScenes.map((scene) => incomingSceneSchema.parse(scene));
  const oldById = new Map(canonical.map((scene) => [scene.id, scene]));
  const incomingById = new Map(incoming.map((scene) => [scene.draftSceneId, scene]));
  const active: CanonicalScene[] = [];
  const activeIds = new Set<OpaqueId>();

  for (const entry of input.preview.entries) {
    const source = incomingById.get(entry.draftSceneId);
    if (source === undefined || entry.assignedDisplayNumber === undefined) {
      throw new DomainError(
        "INVARIANT_VIOLATION",
        "Sync preview no longer matches incoming scene data.",
      );
    }
    if (entry.status === "matched") {
      const prior = oldById.get(entry.canonicalSceneId!);
      if (prior === undefined)
        throw new DomainError("INVARIANT_VIOLATION", "Mapped scene no longer exists.");
      active.push({
        ...prior,
        order: source.order,
        displayNumber: entry.assignedDisplayNumber,
        slugline: source.slugline,
        contentFingerprint: source.contentFingerprint,
        omitted: false,
        archived: false,
      });
      activeIds.add(prior.id);
    } else if (entry.status === "added") {
      if (oldById.has(source.proposedSceneId) || activeIds.has(source.proposedSceneId)) {
        throw new DomainError(
          "INVARIANT_VIOLATION",
          "A proposed scene ID collides with the production graph.",
        );
      }
      active.push({
        id: source.proposedSceneId,
        order: source.order,
        displayNumber: entry.assignedDisplayNumber,
        slugline: source.slugline,
        contentFingerprint: source.contentFingerprint,
        omitted: false,
        archived: false,
        downstreamLinks: [],
      });
      activeIds.add(source.proposedSceneId);
    }
  }

  const retained: CanonicalScene[] = [];
  const redirects: { fromSceneId: OpaqueId; toSceneId: OpaqueId }[] = [];
  const retainedDownstreamSceneIds: OpaqueId[] = [];
  for (const removed of input.preview.removed) {
    const scene = oldById.get(removed.canonicalSceneId)!;
    const decision = input.removedDecisions[removed.canonicalSceneId];
    if (removed.downstreamLinks.length > 0 && decision === undefined) {
      throw new DomainError(
        "SYNC_REQUIRES_REVIEW",
        "Removed scene with downstream work needs an explicit decision.",
        {
          sceneId: removed.canonicalSceneId,
        },
      );
    }
    const resolved = decision ?? { action: "archive" as const };
    if (resolved.action === "remap") {
      if (!activeIds.has(resolved.targetSceneId) || resolved.targetSceneId === scene.id) {
        throw new DomainError(
          "INVALID_INPUT",
          "Removed scene can only remap to another active scene.",
        );
      }
      redirects.push({ fromSceneId: scene.id, toSceneId: resolved.targetSceneId });
      retained.push({ ...scene, archived: true, omitted: true });
    } else if (resolved.action === "omit") {
      retained.push({ ...scene, omitted: true, archived: false });
    } else {
      retained.push({ ...scene, omitted: true, archived: true });
    }
    if (scene.downstreamLinks.length > 0) retainedDownstreamSceneIds.push(scene.id);
  }

  return {
    scenes: [...active.sort((left, right) => left.order - right.order), ...retained],
    redirects,
    retainedDownstreamSceneIds,
    record: {
      appliedAt: input.appliedAt,
      entries: input.preview.entries,
      removedDecisions: input.removedDecisions,
    },
  };
}
