import { z } from "zod";

import { DomainError } from "./errors";

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const minorUnitsSchema = z.number().int().safe();

export const moneySchema = z
  .object({
    currency: currencyCodeSchema,
    minor: minorUnitsSchema,
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;

export const budgetLineInputSchema = z
  .object({
    currency: currencyCodeSchema,
    rateMinor: minorUnitsSchema,
    quantityMilli: z.number().int().min(0).max(1_000_000_000),
    durationMilli: z.number().int().min(0).max(1_000_000_000),
    fringeBps: z.number().int().min(0).max(100_000),
    taxBps: z.number().int().min(0).max(100_000),
    markupBps: z.number().int().min(0).max(100_000),
  })
  .strict();

export type BudgetLineInput = z.infer<typeof budgetLineInputSchema>;

export interface BudgetLineTotal {
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly fringeMinor: number;
  readonly taxMinor: number;
  readonly markupMinor: number;
  readonly totalMinor: number;
}

function safeMinor(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError("INVALID_INPUT", "Money calculation exceeds the safe integer range.");
  }
  return Number(value);
}

function divideHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new DomainError("INVALID_INPUT", "Divisor must be positive.");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function applyBasisPoints(amountMinor: number, basisPoints: number): number {
  minorUnitsSchema.parse(amountMinor);
  if (!Number.isSafeInteger(basisPoints)) {
    throw new DomainError("INVALID_INPUT", "Basis points must be a safe integer.");
  }
  return safeMinor(divideHalfAwayFromZero(BigInt(amountMinor) * BigInt(basisPoints), 10_000n));
}

/**
 * Quantity and duration use a fixed scale of 1,000. Tax is calculated on subtotal plus fringe;
 * markup is calculated on subtotal plus fringe (not tax), so recalculation is deterministic.
 */
export function calculateBudgetLine(input: BudgetLineInput): BudgetLineTotal {
  const line = budgetLineInputSchema.parse(input);
  const subtotalMinor = safeMinor(
    divideHalfAwayFromZero(
      BigInt(line.rateMinor) * BigInt(line.quantityMilli) * BigInt(line.durationMilli),
      1_000_000n,
    ),
  );
  const fringeMinor = applyBasisPoints(subtotalMinor, line.fringeBps);
  const taxableMinor = subtotalMinor + fringeMinor;
  const taxMinor = applyBasisPoints(taxableMinor, line.taxBps);
  const markupMinor = applyBasisPoints(taxableMinor, line.markupBps);
  const totalMinor = safeMinor(
    BigInt(subtotalMinor) + BigInt(fringeMinor) + BigInt(taxMinor) + BigInt(markupMinor),
  );
  return {
    currency: line.currency,
    subtotalMinor,
    fringeMinor,
    taxMinor,
    markupMinor,
    totalMinor,
  };
}

export interface BudgetSummary {
  readonly currency: string;
  readonly netMinor: number;
  readonly contingencyMinor: number;
  readonly totalMinor: number;
}

export function summarizeBudget(
  lines: readonly BudgetLineTotal[],
  contingencyBps = 0,
): BudgetSummary {
  if (lines.length === 0) {
    throw new DomainError("INVALID_INPUT", "A budget summary requires at least one line.");
  }
  const currency = lines[0]!.currency;
  if (lines.some((line) => line.currency !== currency)) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Budget lines with different currencies require explicit conversion.",
    );
  }
  const netMinor = safeMinor(lines.reduce((sum, line) => sum + BigInt(line.totalMinor), 0n));
  const contingencyMinor = applyBasisPoints(netMinor, contingencyBps);
  return {
    currency,
    netMinor,
    contingencyMinor,
    totalMinor: safeMinor(BigInt(netMinor) + BigInt(contingencyMinor)),
  };
}

export function budgetVariance(approvedMinor: number, actualMinor: number): number {
  minorUnitsSchema.parse(approvedMinor);
  minorUnitsSchema.parse(actualMinor);
  return safeMinor(BigInt(actualMinor) - BigInt(approvedMinor));
}

/** Splits integer minor units without losing a cent, with ties resolved by input order. */
export function allocateMinorUnits(totalMinor: number, weights: readonly number[]): number[] {
  minorUnitsSchema.parse(totalMinor);
  if (
    totalMinor < 0 ||
    weights.length === 0 ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "Allocation needs a non-negative total and non-negative integer weights.",
    );
  }
  const weightTotal = weights.reduce((sum, value) => sum + BigInt(value), 0n);
  if (weightTotal === 0n)
    throw new DomainError("INVALID_INPUT", "At least one allocation weight must be positive.");

  const total = BigInt(totalMinor);
  const rows = weights.map((weight, index) => {
    const numerator = total * BigInt(weight);
    return { index, value: numerator / weightTotal, remainder: numerator % weightTotal };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.value, 0n);
  const priority = [...rows].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const row of priority) {
    if (remaining === 0n) break;
    rows[row.index]!.value += 1n;
    remaining -= 1n;
  }
  return rows.map((row) => safeMinor(row.value));
}
