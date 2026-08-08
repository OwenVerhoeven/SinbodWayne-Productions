import { z } from "zod";

import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

export const resourceTypeSchema = z.enum(["cast", "crew", "location", "equipment", "vehicle"]);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const resourceAssignmentSchema = z
  .object({
    assignmentId: opaqueIdSchema,
    scheduleItemId: opaqueIdSchema,
    resourceType: resourceTypeSchema,
    resourceId: opaqueIdSchema,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    locationId: opaqueIdSchema.optional(),
    unit: z.string().min(1).max(100),
    minimumTurnaroundMs: z.number().int().min(0),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: "Assignment must end after it starts.",
  });

export type ResourceAssignment = z.infer<typeof resourceAssignmentSchema>;

export interface AvailabilityWindow {
  readonly resourceType: ResourceType;
  readonly resourceId: OpaqueId;
  readonly startMs: number;
  readonly endMs: number;
}

export interface TravelDuration {
  readonly fromLocationId: OpaqueId;
  readonly toLocationId: OpaqueId;
  readonly durationMs: number;
}

export type ResourceConflict =
  | {
      readonly kind: "overlap";
      readonly severity: "blocker";
      readonly resourceType: ResourceType;
      readonly resourceId: OpaqueId;
      readonly assignmentIds: readonly [OpaqueId, OpaqueId];
      readonly overlapMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly severity: "blocker";
      readonly resourceType: ResourceType;
      readonly resourceId: OpaqueId;
      readonly assignmentIds: readonly [OpaqueId];
    }
  | {
      readonly kind: "turnaround";
      readonly severity: "warning";
      readonly resourceType: ResourceType;
      readonly resourceId: OpaqueId;
      readonly assignmentIds: readonly [OpaqueId, OpaqueId];
      readonly actualGapMs: number;
      readonly requiredGapMs: number;
    }
  | {
      readonly kind: "travel";
      readonly severity: "blocker";
      readonly resourceType: ResourceType;
      readonly resourceId: OpaqueId;
      readonly assignmentIds: readonly [OpaqueId, OpaqueId];
      readonly actualGapMs: number;
      readonly requiredGapMs: number;
    };

function key(type: ResourceType, id: OpaqueId): string {
  return `${type}:${id}`;
}

export function detectResourceConflicts(input: {
  readonly assignments: readonly ResourceAssignment[];
  readonly availability: readonly AvailabilityWindow[];
  readonly travelDurations: readonly TravelDuration[];
}): readonly ResourceConflict[] {
  const assignments = input.assignments.map((assignment) =>
    resourceAssignmentSchema.parse(assignment),
  );
  if (
    new Set(assignments.map((assignment) => assignment.assignmentId)).size !== assignments.length
  ) {
    throw new DomainError("INVALID_INPUT", "Assignment IDs must be unique.");
  }
  const availability = new Map<string, AvailabilityWindow[]>();
  for (const window of input.availability) {
    if (
      !Number.isSafeInteger(window.startMs) ||
      !Number.isSafeInteger(window.endMs) ||
      window.endMs <= window.startMs
    ) {
      throw new DomainError("INVALID_INPUT", "Availability window is invalid.");
    }
    const windows = availability.get(key(window.resourceType, window.resourceId)) ?? [];
    windows.push(window);
    availability.set(key(window.resourceType, window.resourceId), windows);
  }
  const travel = new Map(
    input.travelDurations.flatMap((row) => {
      if (!Number.isSafeInteger(row.durationMs) || row.durationMs < 0) {
        throw new DomainError("INVALID_INPUT", "Travel duration must be a non-negative integer.");
      }
      return [
        [`${row.fromLocationId}:${row.toLocationId}`, row.durationMs] as const,
        [`${row.toLocationId}:${row.fromLocationId}`, row.durationMs] as const,
      ];
    }),
  );
  const grouped = new Map<string, ResourceAssignment[]>();
  for (const assignment of assignments) {
    const groupKey = key(assignment.resourceType, assignment.resourceId);
    const group = grouped.get(groupKey) ?? [];
    group.push(assignment);
    grouped.set(groupKey, group);
  }

  const conflicts: ResourceConflict[] = [];
  for (const [groupKey, unsorted] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const group = [...unsorted].sort(
      (left, right) =>
        left.startMs - right.startMs || left.assignmentId.localeCompare(right.assignmentId),
    );
    const windows = availability.get(groupKey);
    if (windows !== undefined) {
      for (const assignment of group) {
        if (
          !windows.some(
            (window) => assignment.startMs >= window.startMs && assignment.endMs <= window.endMs,
          )
        ) {
          conflicts.push({
            kind: "unavailable",
            severity: "blocker",
            resourceType: assignment.resourceType,
            resourceId: assignment.resourceId,
            assignmentIds: [assignment.assignmentId],
          });
        }
      }
    }

    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      const left = group[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const right = group[rightIndex]!;
        if (right.startMs >= left.endMs) break;
        conflicts.push({
          kind: "overlap",
          severity: "blocker",
          resourceType: left.resourceType,
          resourceId: left.resourceId,
          assignmentIds: [left.assignmentId, right.assignmentId],
          overlapMs: Math.min(left.endMs, right.endMs) - right.startMs,
        });
      }
    }

    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!;
      const current = group[index]!;
      if (current.startMs < previous.endMs) continue;
      const gap = current.startMs - previous.endMs;
      const requiredTurnaround = Math.max(
        previous.minimumTurnaroundMs,
        current.minimumTurnaroundMs,
      );
      if (gap < requiredTurnaround) {
        conflicts.push({
          kind: "turnaround",
          severity: "warning",
          resourceType: current.resourceType,
          resourceId: current.resourceId,
          assignmentIds: [previous.assignmentId, current.assignmentId],
          actualGapMs: gap,
          requiredGapMs: requiredTurnaround,
        });
      }
      if (
        previous.locationId !== undefined &&
        current.locationId !== undefined &&
        previous.locationId !== current.locationId
      ) {
        const requiredTravel = travel.get(`${previous.locationId}:${current.locationId}`);
        if (requiredTravel !== undefined && gap < requiredTravel) {
          conflicts.push({
            kind: "travel",
            severity: "blocker",
            resourceType: current.resourceType,
            resourceId: current.resourceId,
            assignmentIds: [previous.assignmentId, current.assignmentId],
            actualGapMs: gap,
            requiredGapMs: requiredTravel,
          });
        }
      }
    }
  }
  return conflicts;
}
