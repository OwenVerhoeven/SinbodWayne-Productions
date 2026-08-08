import { createMiddleware } from "hono/factory";

import { HttpError } from "./errors";
import type { AppEnv } from "./types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const requestContext = createMiddleware<AppEnv>(async (context, next) => {
  const incoming = context.req.header("X-Request-ID");
  const requestId =
    incoming && /^[A-Za-z0-9_-]{8,80}$/.test(incoming) ? incoming : crypto.randomUUID();
  context.set("requestId", requestId);
  try {
    await next();
  } finally {
    context.header("X-Request-ID", requestId);
    context.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self' wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self'",
    );
    context.header("Cross-Origin-Opener-Policy", "same-origin");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    if (new URL(context.req.url).protocol === "https:") {
      context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  }
});

export const requireSameOrigin = createMiddleware<AppEnv>(async (context, next) => {
  if (SAFE_METHODS.has(context.req.method)) {
    await next();
    return;
  }
  const url = new URL(context.req.url);
  const expectedOrigin =
    url.hostname === "127.0.0.1" || url.hostname === "localhost"
      ? url.origin
      : context.env.APP_ORIGIN;
  const origin = context.req.header("Origin");
  const fetchSite = context.req.header("Sec-Fetch-Site");
  if (
    origin !== expectedOrigin ||
    (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
  ) {
    throw new HttpError(403, "origin_denied", "The request origin is not permitted.");
  }
  await next();
});

export const requireJson = createMiddleware<AppEnv>(async (context, next) => {
  if (!SAFE_METHODS.has(context.req.method)) {
    const type = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      throw new HttpError(
        415,
        "unsupported_content_type",
        "This endpoint accepts application/json.",
      );
    }
  }
  await next();
});

export function structuredError(error: unknown, requestId: string, path: string): void {
  const safe =
    error instanceof HttpError
      ? { name: error.name, code: error.code, status: error.status }
      : error instanceof Error
        ? { name: error.name }
        : { name: "UnknownError" };
  console.error(
    JSON.stringify({ level: "error", message: "request_failed", requestId, path, error: safe }),
  );
}
