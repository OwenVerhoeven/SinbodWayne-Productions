export type ArchiveErrorCode =
  | "CHECKSUM_MISMATCH"
  | "CONFIGURATION_INVALID"
  | "DESTINATION_CONFLICT"
  | "DOWNLOAD_INTERRUPTED"
  | "INSUFFICIENT_SPACE"
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "LEASE_LOST"
  | "MISSING_OBJECT"
  | "PATH_ESCAPE"
  | "SERVICE_UNAVAILABLE"
  | "SIZE_MISMATCH"
  | "UNEXPECTED";

export class ArchiveAgentError extends Error {
  readonly code: ArchiveErrorCode;
  readonly retryable: boolean;

  constructor(code: ArchiveErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchiveAgentError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asArchiveAgentError(error: unknown): ArchiveAgentError {
  if (error instanceof ArchiveAgentError) {
    return error;
  }

  if (error instanceof Error && "code" in error) {
    const systemCode = String(error.code);
    if (["ENOSPC", "EDQUOT"].includes(systemCode)) {
      return new ArchiveAgentError(
        "INSUFFICIENT_SPACE",
        "Archive destination has no available space",
        true,
        {
          cause: error,
        },
      );
    }
    if (
      ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(
        systemCode,
      )
    ) {
      return new ArchiveAgentError(
        "SERVICE_UNAVAILABLE",
        "Archive service connection failed",
        true,
        {
          cause: error,
        },
      );
    }
  }

  return new ArchiveAgentError("UNEXPECTED", "Unexpected archive-agent failure", false, {
    cause: error,
  });
}
