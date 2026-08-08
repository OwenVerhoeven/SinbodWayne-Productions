export type ArchiveServiceErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "INVALID_RANGE"
  | "LEASE_LOST"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INTEGRITY_FAILURE"
  | "CONFLICT"
  | "INTERNAL_ERROR";

const defaultStatuses: Readonly<Record<ArchiveServiceErrorCode, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  INVALID_RANGE: 416,
  LEASE_LOST: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  INTEGRITY_FAILURE: 409,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class ArchiveServiceError extends Error {
  readonly code: ArchiveServiceErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ArchiveServiceErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "ArchiveServiceError";
    this.code = code;
    this.status = options.status ?? defaultStatuses[code];
    this.details = options.details;
  }
}
