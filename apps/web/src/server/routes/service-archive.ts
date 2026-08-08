import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";

import { ArchiveServiceError } from "../archive/errors";
import { ArchiveCoordinator, type ArchiveCoordinatorContract } from "../archive/service";
import {
  failureAcknowledgementSchema,
  heartbeatRequestSchema,
  itemAcknowledgementSchema,
  leaseRequestSchema,
  manifestAcknowledgementSchema,
  type ArchiveServicePrincipal,
} from "../archive/types";
import type { ApplicationBindings } from "../http/types";

const MAX_JSON_BODY_BYTES = 16_384;
const routeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

type ArchiveRouteVariables = {
  archiveCoordinator: ArchiveCoordinatorContract;
  archivePrincipal: ArchiveServicePrincipal;
  requestId: string;
};

type ArchiveRouteEnvironment = {
  Bindings: ApplicationBindings;
  Variables: ArchiveRouteVariables;
};

export interface ArchiveServiceRouteOptions {
  readonly coordinatorFactory?: (
    bindings: Pick<ApplicationBindings, "DB" | "FILES">,
  ) => ArchiveCoordinatorContract;
  readonly now?: () => number;
  readonly requestId?: () => string;
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{16,512})$/u.exec(header ?? "");
  if (match?.[1] === undefined) {
    throw new ArchiveServiceError(
      "AUTHENTICATION_REQUIRED",
      "Archive service authentication failed.",
    );
  }
  return match[1];
}

function requiredHeader(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value.length > 512) {
    throw new ArchiveServiceError("INVALID_REQUEST", `${label} is required.`);
  }
  return value;
}

function routeId(value: string): string {
  if (!routeIdentifier.test(value)) {
    throw new ArchiveServiceError("INVALID_REQUEST", "The route identifier is invalid.");
  }
  return value;
}

async function boundedJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ArchiveServiceError("INVALID_REQUEST", "Content-Type must be application/json.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new ArchiveServiceError("INVALID_REQUEST", "The request body is too large.", {
      status: 413,
    });
  }
  if (request.body === null) {
    throw new ArchiveServiceError("INVALID_REQUEST", "A JSON request body is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new ArchiveServiceError("INVALID_REQUEST", "The request body is too large.", {
          status: 413,
        });
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ArchiveServiceError("INVALID_REQUEST", "The request body is not valid JSON.");
  }
}

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await boundedJson(request));
}

function errorPayload(error: ArchiveServiceError, requestId: string) {
  return {
    ok: false as const,
    error: {
      code: error.code,
      message: error.message,
    },
    requestId,
  };
}

export function createArchiveServiceRoutes(
  options: ArchiveServiceRouteOptions = {},
): Hono<ArchiveRouteEnvironment> {
  const now = options.now ?? Date.now;
  const requestIdFactory = options.requestId ?? (() => crypto.randomUUID());
  const coordinatorFactory =
    options.coordinatorFactory ?? ((bindings) => ArchiveCoordinator.fromBindings(bindings));
  const app = new Hono<ArchiveRouteEnvironment>();

  app.onError((cause, context) => {
    const requestId = context.get("requestId") || requestIdFactory();
    const error =
      cause instanceof ArchiveServiceError
        ? cause
        : cause instanceof ZodError
          ? new ArchiveServiceError("INVALID_REQUEST", "The request did not pass validation.")
          : new ArchiveServiceError("INTERNAL_ERROR", "The archive service request failed.");
    if (error.code === "AUTHENTICATION_REQUIRED") {
      context.header("WWW-Authenticate", 'Bearer realm="archive-agent"');
    }
    if (error.code === "INVALID_RANGE" && typeof error.details?.total === "number") {
      context.header("Content-Range", `bytes */${error.details.total}`);
    }
    if (error.code === "RATE_LIMITED" && typeof error.details?.retryAfterSeconds === "number") {
      context.header("Retry-After", String(error.details.retryAfterSeconds));
    }
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Request-Id", requestId);
    return context.json(errorPayload(error, requestId), error.status as ContentfulStatusCode);
  });

  app.use("*", async (context, next) => {
    const requestId = requestIdFactory();
    context.set("requestId", requestId);
    const coordinator = coordinatorFactory(context.env);
    context.set("archiveCoordinator", coordinator);
    const principal = await coordinator.authenticate(
      bearerToken(context.req.header("Authorization")),
      now(),
    );
    await coordinator.consumeRateLimit(principal, now());
    context.set("archivePrincipal", principal);
    await next();
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Request-Id", requestId);
  });

  app.post("/jobs/lease", async (context) => {
    const request = await parseBody(context.req.raw, leaseRequestSchema);
    const lease = await context
      .get("archiveCoordinator")
      .lease(context.get("archivePrincipal"), request, now());
    return context.json({ ok: true as const, data: lease, requestId: context.get("requestId") });
  });

  app.post("/jobs/:jobId/heartbeat", async (context) => {
    const body = await parseBody(context.req.raw, heartbeatRequestSchema);
    const result = await context
      .get("archiveCoordinator")
      .heartbeat(
        context.get("archivePrincipal"),
        routeId(context.req.param("jobId")),
        requiredHeader(context.req.header("X-Archive-Lease"), "X-Archive-Lease"),
        body.manifestHash,
        now(),
      );
    return context.json({ ok: true as const, data: result, requestId: context.get("requestId") });
  });

  app.get("/jobs/:jobId/items/:itemId/content", async (context) => {
    const download = await context
      .get("archiveCoordinator")
      .download(
        context.get("archivePrincipal"),
        routeId(context.req.param("jobId")),
        routeId(context.req.param("itemId")),
        requiredHeader(context.req.header("X-Archive-Lease"), "X-Archive-Lease"),
        context.req.header("Range") ?? null,
        now(),
      );
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${download.filename}"`,
      "Content-Length": String(download.byteSize),
      "Content-Type": download.mimeType,
      ETag: `"${download.sha256}"`,
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": context.get("requestId"),
    });
    if (download.status === 206) {
      headers.set("Content-Range", `bytes ${download.start}-${download.end}/${download.total}`);
    }
    return new Response(download.body, { status: download.status, headers });
  });

  app.post("/jobs/:jobId/items/:itemId/acknowledgements", async (context) => {
    const body = await parseBody(context.req.raw, itemAcknowledgementSchema);
    const result = await context
      .get("archiveCoordinator")
      .acknowledgeItem(
        context.get("archivePrincipal"),
        routeId(context.req.param("jobId")),
        routeId(context.req.param("itemId")),
        requiredHeader(context.req.header("X-Archive-Lease"), "X-Archive-Lease"),
        requiredHeader(context.req.header("Idempotency-Key"), "Idempotency-Key"),
        body,
        now(),
      );
    return context.json({ ok: true as const, data: result, requestId: context.get("requestId") });
  });

  app.post("/jobs/:jobId/acknowledgements", async (context) => {
    const body = await parseBody(context.req.raw, manifestAcknowledgementSchema);
    const result = await context
      .get("archiveCoordinator")
      .acknowledgeManifest(
        context.get("archivePrincipal"),
        routeId(context.req.param("jobId")),
        requiredHeader(context.req.header("X-Archive-Lease"), "X-Archive-Lease"),
        requiredHeader(context.req.header("Idempotency-Key"), "Idempotency-Key"),
        body,
        now(),
      );
    return context.json({ ok: true as const, data: result, requestId: context.get("requestId") });
  });

  app.post("/jobs/:jobId/failures", async (context) => {
    const body = await parseBody(context.req.raw, failureAcknowledgementSchema);
    const result = await context
      .get("archiveCoordinator")
      .recordFailure(
        context.get("archivePrincipal"),
        routeId(context.req.param("jobId")),
        requiredHeader(context.req.header("X-Archive-Lease"), "X-Archive-Lease"),
        requiredHeader(context.req.header("Idempotency-Key"), "Idempotency-Key"),
        body,
        now(),
      );
    return context.json({ ok: true as const, data: result, requestId: context.get("requestId") });
  });

  return app;
}

export const archiveServiceRoutes = createArchiveServiceRoutes();
