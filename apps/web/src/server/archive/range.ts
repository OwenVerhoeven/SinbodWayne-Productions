import { ArchiveServiceError } from "./errors";

export interface ResolvedByteRange {
  readonly start: number;
  readonly end: number;
  readonly length: number;
  readonly partial: boolean;
}

export function resolveArchiveByteRange(header: string | null, total: number): ResolvedByteRange {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive object size is invalid.");
  }
  if (header === null) {
    return { start: 0, end: Math.max(0, total - 1), length: total, partial: false };
  }
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
  if (match === null || total === 0) {
    throw new ArchiveServiceError("INVALID_RANGE", "The requested byte range is not satisfiable.", {
      details: { total },
    });
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? total - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= total ||
    requestedEnd < start
  ) {
    throw new ArchiveServiceError("INVALID_RANGE", "The requested byte range is not satisfiable.", {
      details: { total },
    });
  }
  const end = Math.min(requestedEnd, total - 1);
  return { start, end, length: end - start + 1, partial: true };
}
