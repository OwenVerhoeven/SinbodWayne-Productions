export type DomainErrorCode =
  | "INVALID_INPUT"
  | "INVARIANT_VIOLATION"
  | "VERSION_CONFLICT"
  | "IMMUTABLE_RECORD"
  | "IDEMPOTENCY_CONFLICT"
  | "AUTHORIZATION_DENIED"
  | "SYNC_REQUIRES_REVIEW"
  | "RANK_SPACE_EXHAUSTED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError("INVARIANT_VIOLATION", message, details);
  }
}
