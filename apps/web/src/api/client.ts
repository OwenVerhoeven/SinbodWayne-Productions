import { z } from "zod";

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

const apiSuccessSchema = z.object({
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export class ApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;
  readonly details: unknown;

  constructor(input: {
    code: string;
    message: string;
    requestId: string;
    status: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "ApiError";
    this.code = input.code;
    this.requestId = input.requestId;
    this.status = input.status;
    this.details = input.details;
  }
}

let csrfToken: string | undefined;

export function setCsrfToken(value: string | undefined): void {
  csrfToken = value;
}

function requestHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase()) && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  return headers;
}

export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: requestHeaders(init),
  });

  const raw: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(raw);
    if (parsed.success) {
      throw new ApiError({
        code: parsed.data.error.code,
        details: parsed.data.error.details,
        message: parsed.data.error.message,
        requestId: parsed.data.error.requestId,
        status: response.status,
      });
    }
    throw new ApiError({
      code: "unexpected_response",
      message: "The server returned an unexpected response.",
      requestId: response.headers.get("X-Request-ID") ?? "unavailable",
      status: response.status,
    });
  }

  const envelope = apiSuccessSchema.parse(raw);
  return schema.parse(envelope.data);
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
