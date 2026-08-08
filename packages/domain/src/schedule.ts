import { z } from "zod";

import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";
import { pageEighthsSchema, sumPageEighths, type PageEighths } from "./page-eighths";

export const scheduleTimingSchema = z
  .object({
    itemId: opaqueIdSchema,
    unit: z.string().min(1).max(100),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    pageEighths: pageEighthsSchema,
    prepMs: z.number().int().min(0),
    setupMs: z.number().int().min(0),
    shootMs: z.number().int().min(0),
    moveMs: z.number().int().min(0),
    mealMs: z.number().int().min(0),
  })
  .strict()
  .refine((item) => item.endMs > item.startMs, {
    message: "Schedule item must end after it starts.",
  });

export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

export interface ScheduleTotals {
  readonly pageEighths: PageEighths;
  readonly prepMs: number;
  readonly setupMs: number;
  readonly shootMs: number;
  readonly moveMs: number;
  readonly mealMs: number;
  readonly totalMs: number;
  readonly estimatedWrapMs: number;
}

function safeSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("INVALID_INPUT", `${label} exceeds the safe integer range.`);
  }
  return Number(total);
}

export function calculateScheduleTotals(
  items: readonly ScheduleTiming[],
  generalCallMs: number,
): ScheduleTotals {
  if (!Number.isSafeInteger(generalCallMs) || generalCallMs < 0) {
    throw new DomainError("INVALID_INPUT", "General call must be a non-negative UTC epoch value.");
  }
  const parsed = items.map((item) => scheduleTimingSchema.parse(item));
  const prepMs = safeSum(
    parsed.map((item) => item.prepMs),
    "Prep total",
  );
  const setupMs = safeSum(
    parsed.map((item) => item.setupMs),
    "Setup total",
  );
  const shootMs = safeSum(
    parsed.map((item) => item.shootMs),
    "Shoot total",
  );
  const moveMs = safeSum(
    parsed.map((item) => item.moveMs),
    "Move total",
  );
  const mealMs = safeSum(
    parsed.map((item) => item.mealMs),
    "Meal total",
  );
  const totalMs = safeSum([prepMs, setupMs, shootMs, moveMs, mealMs], "Schedule duration");
  const estimatedWrapMs = safeSum([generalCallMs, totalMs], "Estimated wrap");
  return {
    pageEighths: sumPageEighths(parsed.map((item) => item.pageEighths)),
    prepMs,
    setupMs,
    shootMs,
    moveMs,
    mealMs,
    totalMs,
    estimatedWrapMs,
  };
}

export interface ScheduleConstraint {
  readonly itemId: OpaqueId;
  readonly earliestStartMs?: number;
  readonly latestEndMs?: number;
}

export type ScheduleTimingConflict =
  | {
      readonly kind: "unit_overlap";
      readonly itemIds: readonly [OpaqueId, OpaqueId];
      readonly overlapMs: number;
    }
  | {
      readonly kind: "hard_window";
      readonly itemIds: readonly [OpaqueId];
      readonly boundary: "earliest_start" | "latest_end";
      readonly deltaMs: number;
    };

export function detectScheduleTimingConflicts(
  items: readonly ScheduleTiming[],
  constraints: readonly ScheduleConstraint[],
): readonly ScheduleTimingConflict[] {
  const parsed = items.map((item) => scheduleTimingSchema.parse(item));
  const byId = new Map(parsed.map((item) => [item.itemId, item]));
  if (byId.size !== parsed.length)
    throw new DomainError("INVALID_INPUT", "Schedule item IDs must be unique.");
  const conflicts: ScheduleTimingConflict[] = [];
  const units = new Map<string, ScheduleTiming[]>();
  for (const item of parsed) {
    const group = units.get(item.unit) ?? [];
    group.push(item);
    units.set(item.unit, group);
  }
  for (const group of units.values()) {
    const sorted = [...group].sort(
      (left, right) => left.startMs - right.startMs || left.itemId.localeCompare(right.itemId),
    );
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      const left = sorted[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const right = sorted[rightIndex]!;
        if (right.startMs >= left.endMs) break;
        conflicts.push({
          kind: "unit_overlap",
          itemIds: [left.itemId, right.itemId],
          overlapMs: Math.min(left.endMs, right.endMs) - right.startMs,
        });
      }
    }
  }
  for (const constraint of constraints) {
    const item = byId.get(constraint.itemId);
    if (item === undefined)
      throw new DomainError("INVALID_INPUT", "Schedule constraint references an unknown item.");
    if (constraint.earliestStartMs !== undefined && item.startMs < constraint.earliestStartMs) {
      conflicts.push({
        kind: "hard_window",
        itemIds: [item.itemId],
        boundary: "earliest_start",
        deltaMs: constraint.earliestStartMs - item.startMs,
      });
    }
    if (constraint.latestEndMs !== undefined && item.endMs > constraint.latestEndMs) {
      conflicts.push({
        kind: "hard_window",
        itemIds: [item.itemId],
        boundary: "latest_end",
        deltaMs: item.endMs - constraint.latestEndMs,
      });
    }
  }
  return conflicts;
}
