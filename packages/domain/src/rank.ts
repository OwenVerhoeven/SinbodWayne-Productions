import { DomainError } from "./errors";

const WIDTH = 20;
const MIN = 0n;
const MAX = 36n ** BigInt(WIDTH) - 1n;

function encode(value: bigint): string {
  if (value < MIN || value > MAX)
    throw new DomainError("INVALID_INPUT", "Rank is outside the supported range.");
  return value.toString(36).padStart(WIDTH, "0");
}

function decode(value: string): bigint {
  if (!new RegExp(`^[0-9a-z]{${WIDTH}}$`).test(value)) {
    throw new DomainError("INVALID_INPUT", "Rank must be a canonical fixed-width base-36 string.");
  }
  let result = 0n;
  for (const character of value) {
    result = result * 36n + BigInt(parseInt(character, 36));
  }
  return result;
}

export const firstRank = (): string => encode(MAX / 2n);

export function rankBetween(lower?: string, upper?: string): string {
  const lowerValue = lower === undefined ? MIN : decode(lower);
  const upperValue = upper === undefined ? MAX : decode(upper);
  if (lowerValue >= upperValue) {
    throw new DomainError("INVALID_INPUT", "Lower rank must sort before upper rank.");
  }
  const midpoint = (lowerValue + upperValue) / 2n;
  if (midpoint === lowerValue || midpoint === upperValue) {
    throw new DomainError(
      "RANK_SPACE_EXHAUSTED",
      "No rank remains between adjacent values; rebalance is required.",
    );
  }
  return encode(midpoint);
}

export function rebalanceRanks<T extends string>(idsInOrder: readonly T[]): ReadonlyMap<T, string> {
  if (new Set(idsInOrder).size !== idsInOrder.length) {
    throw new DomainError("INVALID_INPUT", "Cannot rebalance duplicate identifiers.");
  }
  const spacing = MAX / BigInt(idsInOrder.length + 1);
  if (spacing === 0n)
    throw new DomainError("RANK_SPACE_EXHAUSTED", "Too many values to rebalance.");
  return new Map(idsInOrder.map((id, index) => [id, encode(spacing * BigInt(index + 1))]));
}

export function compareRanks(left: string, right: string): -1 | 0 | 1 {
  const leftValue = decode(left);
  const rightValue = decode(right);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}
