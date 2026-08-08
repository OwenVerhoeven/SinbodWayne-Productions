export class HttpError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

  constructor(status: HttpError["status"], code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
