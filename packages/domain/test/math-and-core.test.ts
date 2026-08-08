import { describe, expect, it } from "vitest";

import {
  DEFAULT_FRAME_RATE,
  DomainError,
  allocateMinorUnits,
  assertSameTenant,
  budgetVariance,
  calculateBudgetLine,
  canonicalJson,
  checkOptimisticWrite,
  compareRanks,
  firstRank,
  formatPageEighths,
  formatTimecode,
  framesFromMilliseconds,
  millisecondsFromFrames,
  pageEighthsFromParts,
  parsePageEighths,
  parseTimecode,
  rankBetween,
  rebalanceRanks,
  sha256Hex,
  sumPageEighths,
  summarizeBudget,
  uuidV7From,
} from "../src";
import { id } from "./fixtures";

describe("opaque identifiers and references", () => {
  it("creates deterministic RFC UUIDv7 values from explicit entropy", () => {
    const random = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const value = uuidV7From(1_700_000_000_000, random);
    expect(value).toMatch(/^[0-9a-f-]{36}$/);
    expect(value[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(value[19]);
    expect(uuidV7From(1_700_000_000_000, random)).toBe(value);
  });

  it("rejects cross-workspace and cross-project object references", () => {
    const reference = {
      workspaceId: id(1),
      projectId: id(2),
      objectType: "scene",
      objectId: id(3),
    };
    expect(() => assertSameTenant(reference, id(1), id(2))).not.toThrow();
    expect(() => assertSameTenant(reference, id(4), id(2))).toThrowError(DomainError);
    expect(() => assertSameTenant(reference, id(1), id(5))).toThrowError(/another project/);
  });
});

describe("page-eighth arithmetic", () => {
  it("stores, carries, formats, and totals exact eighths without floats", () => {
    expect(pageEighthsFromParts(1, 10)).toBe(18);
    expect(parsePageEighths("1 3/8")).toBe(11);
    expect(parsePageEighths("7/8")).toBe(7);
    expect(parsePageEighths("2")).toBe(16);
    expect(formatPageEighths(19)).toBe("2 3/8");
    expect(sumPageEighths([3, 7, 8])).toBe(18);
  });

  it("rejects non-canonical displayed fractions and negative values", () => {
    expect(() => parsePageEighths("1 8/8")).toThrowError(/between 0\/8 and 7\/8/);
    expect(() => pageEighthsFromParts(-1, 0)).toThrowError(DomainError);
  });
});

describe("frame and SMPTE calculations", () => {
  it("round-trips non-drop frame durations deterministically", () => {
    expect(framesFromMilliseconds(1_000, DEFAULT_FRAME_RATE)).toBe(24);
    expect(millisecondsFromFrames(24, DEFAULT_FRAME_RATE)).toBe(1_000);
    expect(formatTimecode(24 * 3_661 + 12, DEFAULT_FRAME_RATE)).toBe("01:01:01:12");
    expect(parseTimecode("01:01:01:12", DEFAULT_FRAME_RATE)).toBe(24 * 3_661 + 12);
  });

  it("handles 29.97 drop-frame labels and rejects skipped labels", () => {
    const rate = { numerator: 30_000, denominator: 1_001, dropFrame: true } as const;
    expect(formatTimecode(17_982, rate)).toBe("00:10:00;00");
    expect(parseTimecode("00:10:00;00", rate)).toBe(17_982);
    expect(parseTimecode("00:01:00;02", rate)).toBe(1_800);
    expect(() => parseTimecode("00:01:00;00", rate)).toThrowError(/omitted/);
    expect(() => parseTimecode("00:01:00:02", rate)).toThrowError(/separator/);
  });
});

describe("integer money and budget math", () => {
  it("calculates quantity, duration, fringe, tax, markup, contingency, and variance in minor units", () => {
    const total = calculateBudgetLine({
      currency: "EUR",
      rateMinor: 10_000,
      quantityMilli: 1_500,
      durationMilli: 2_000,
      fringeBps: 1_000,
      taxBps: 2_100,
      markupBps: 500,
    });
    expect(total).toEqual({
      currency: "EUR",
      subtotalMinor: 30_000,
      fringeMinor: 3_000,
      taxMinor: 6_930,
      markupMinor: 1_650,
      totalMinor: 41_580,
    });
    expect(summarizeBudget([total], 1_000)).toEqual({
      currency: "EUR",
      netMinor: 41_580,
      contingencyMinor: 4_158,
      totalMinor: 45_738,
    });
    expect(budgetVariance(40_000, 41_580)).toBe(1_580);
  });

  it("preserves every cent during weighted allocation and refuses implicit currency conversion", () => {
    expect(allocateMinorUnits(100, [1, 1, 1])).toEqual([34, 33, 33]);
    const eur = calculateBudgetLine({
      currency: "EUR",
      rateMinor: 100,
      quantityMilli: 1_000,
      durationMilli: 1_000,
      fringeBps: 0,
      taxBps: 0,
      markupBps: 0,
    });
    expect(() => summarizeBudget([eur, { ...eur, currency: "GBP" }])).toThrowError(
      /explicit conversion/,
    );
  });
});

describe("stable ranks and optimistic writes", () => {
  it("creates lexical ranks between values and rebalances deterministically", () => {
    const middle = firstRank();
    const before = rankBetween(undefined, middle);
    const after = rankBetween(middle, undefined);
    expect(compareRanks(before, middle)).toBe(-1);
    expect(compareRanks(middle, after)).toBe(-1);
    const rebalanced = rebalanceRanks(["a", "b", "c"]);
    expect([...rebalanced.values()]).toEqual([...rebalanced.values()].sort());
  });

  it("returns recoverable field-level conflict evidence and never silently accepts a stale write", () => {
    const result = checkOptimisticWrite({
      expectedVersion: 2,
      currentVersion: 3,
      base: { title: "Old", notes: "Base" },
      current: { title: "Current", notes: "Base" },
      attempted: { title: "Mine", notes: "Draft" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.overlappingPaths).toEqual(["$.title"]);
      expect(result.current).toEqual({ title: "Current", notes: "Base" });
      expect(result.attempted).toEqual({ title: "Mine", notes: "Draft" });
    }
  });
});

describe("canonical hashing", () => {
  it("sorts object keys without changing array order", async () => {
    expect(canonicalJson({ b: 2, a: [2, 1] })).toBe('{"a":[2,1],"b":2}');
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
