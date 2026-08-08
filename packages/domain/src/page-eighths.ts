import { z } from "zod";

import { DomainError } from "./errors";

export const pageEighthsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type PageEighths = z.infer<typeof pageEighthsSchema>;

export function pageEighthsFromParts(pages: number, eighths = 0): PageEighths {
  if (!Number.isSafeInteger(pages) || pages < 0 || !Number.isSafeInteger(eighths) || eighths < 0) {
    throw new DomainError("INVALID_INPUT", "Page and eighth values must be non-negative integers.");
  }
  const total = pages * 8 + eighths;
  return pageEighthsSchema.parse(total);
}

export function parsePageEighths(value: string): PageEighths {
  const input = value.trim();
  const match = /^(?:(\d+)\s+)?(?:(\d+)\/8)?$/.exec(input);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    if (/^\d+$/.test(input)) {
      return pageEighthsFromParts(Number(input));
    }
    throw new DomainError("INVALID_INPUT", `Invalid page-eighth value: ${value}`);
  }

  const pages = Number(match[1] ?? 0);
  const eighths = Number(match[2] ?? 0);
  if (eighths > 7) {
    throw new DomainError(
      "INVALID_INPUT",
      "A displayed page fraction must be between 0/8 and 7/8.",
    );
  }
  return pageEighthsFromParts(pages, eighths);
}

export function formatPageEighths(total: PageEighths): string {
  pageEighthsSchema.parse(total);
  const pages = Math.floor(total / 8);
  const eighths = total % 8;
  if (eighths === 0) return String(pages);
  if (pages === 0) return `${eighths}/8`;
  return `${pages} ${eighths}/8`;
}

export function sumPageEighths(values: readonly PageEighths[]): PageEighths {
  const total = values.reduce((sum, value) => sum + pageEighthsSchema.parse(value), 0);
  return pageEighthsSchema.parse(total);
}

export function comparePageEighths(left: PageEighths, right: PageEighths): -1 | 0 | 1 {
  pageEighthsSchema.parse(left);
  pageEighthsSchema.parse(right);
  return left === right ? 0 : left < right ? -1 : 1;
}
