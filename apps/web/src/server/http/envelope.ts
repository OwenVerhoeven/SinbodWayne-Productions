import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv } from "./types";

export function ok<T>(
  context: Context<AppEnv>,
  data: T,
  status: ContentfulStatusCode = 200,
  meta?: Record<string, unknown>,
) {
  return context.json(meta ? { data, meta } : { data }, status);
}

export function errorEnvelope(
  context: Context<AppEnv>,
  input: { code: string; message: string; details?: unknown },
  status: ContentfulStatusCode,
) {
  return context.json(
    {
      error: {
        code: input.code,
        message: input.message,
        requestId: context.get("requestId"),
        ...(input.details === undefined ? {} : { details: input.details }),
      },
    },
    status,
  );
}
