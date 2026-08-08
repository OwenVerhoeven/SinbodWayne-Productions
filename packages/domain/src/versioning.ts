import { z } from "zod";

import type { JsonValue } from "./canonical";

export const optimisticVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export interface OptimisticWrite<T extends JsonValue> {
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly base: T;
  readonly current: T;
  readonly attempted: T;
}

export type OptimisticWriteResult<T extends JsonValue> =
  | { readonly ok: true; readonly nextVersion: number; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "VERSION_CONFLICT";
      readonly expectedVersion: number;
      readonly currentVersion: number;
      readonly base: T;
      readonly current: T;
      readonly attempted: T;
      readonly currentChangedPaths: readonly string[];
      readonly attemptedChangedPaths: readonly string[];
      readonly overlappingPaths: readonly string[];
    };

function changedPaths(base: JsonValue, other: JsonValue, path = "$"): string[] {
  if (Object.is(base, other)) return [];
  if (
    base === null ||
    other === null ||
    typeof base !== "object" ||
    typeof other !== "object" ||
    Array.isArray(base) !== Array.isArray(other)
  ) {
    return [path];
  }

  if (Array.isArray(base) && Array.isArray(other)) {
    const paths: string[] = [];
    const length = Math.max(base.length, other.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= base.length || index >= other.length) paths.push(`${path}[${index}]`);
      else paths.push(...changedPaths(base[index]!, other[index]!, `${path}[${index}]`));
    }
    return paths;
  }

  const left = base as { readonly [key: string]: JsonValue };
  const right = other as { readonly [key: string]: JsonValue };
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => {
    if (!(key in left) || !(key in right)) return [`${path}.${key}`];
    return changedPaths(left[key]!, right[key]!, `${path}.${key}`);
  });
}

export function checkOptimisticWrite<T extends JsonValue>(
  input: OptimisticWrite<T>,
): OptimisticWriteResult<T> {
  optimisticVersionSchema.parse(input.expectedVersion);
  optimisticVersionSchema.parse(input.currentVersion);
  if (input.expectedVersion === input.currentVersion) {
    return { ok: true, nextVersion: input.currentVersion + 1, value: input.attempted };
  }
  const currentChangedPaths = changedPaths(input.base, input.current);
  const attemptedChangedPaths = changedPaths(input.base, input.attempted);
  const attemptedSet = new Set(attemptedChangedPaths);
  const overlappingPaths = currentChangedPaths.filter((path) => attemptedSet.has(path));
  return {
    ok: false,
    code: "VERSION_CONFLICT",
    expectedVersion: input.expectedVersion,
    currentVersion: input.currentVersion,
    base: input.base,
    current: input.current,
    attempted: input.attempted,
    currentChangedPaths,
    attemptedChangedPaths,
    overlappingPaths,
  };
}
