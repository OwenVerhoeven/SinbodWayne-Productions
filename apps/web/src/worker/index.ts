import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

import { errorEnvelope, ok } from "../server/http/envelope";
import { HttpError } from "../server/http/errors";
import { assertAppRequestAllowed } from "../server/auth/policy";
import { requireActor } from "../server/auth/session";
import { requestContext, structuredError } from "../server/http/security";
import { applicationBindings, type AppEnv } from "../server/http/types";
import {
  PRIVATE_OBJECT_MAX_BYTES,
  PRIVATE_OBJECT_TOTAL_BUDGET_BYTES,
} from "../server/storage/private-object-store";
import { appRoutes } from "../server/routes/app";
import { archiveServiceRoutes } from "../server/routes/service-archive";
import { authRoutes } from "../server/routes/auth";
import { dashboardRoutes } from "../server/routes/dashboard";
import { collaborationRoutes } from "../server/routes/collaboration";
import { ideaRoutes } from "../server/routes/ideas";
import { fileRoutes } from "../server/routes/files";
import { operationsPrintRoutes, operationsRoutes } from "../server/routes/operations";
import { planningControlRoutes } from "../server/routes/planning-controls";
import { printRoutes } from "../server/routes/print";
import { projectArchiveRoutes } from "../server/routes/project-archive";
import { projectRoutes } from "../server/routes/projects";
import { readinessRoutes } from "../server/routes/readiness";
import { recordRoutes } from "../server/routes/records";
import { screenplayRoutes } from "../server/routes/screenplay";
import { publicShareRoutes, shareManagementRoutes } from "../server/routes/shares";

const app = new Hono<AppEnv>();

app.use("*", requestContext);
app.use("/api/v1/app/*", requireActor, async (context, next) => {
  assertAppRequestAllowed(context.get("actor"), context.req.method, context.req.header("Upgrade"));
  await next();
});

app.get("/api/v1/health", async (context) => {
  await context.env.DB.prepare("SELECT 1 AS healthy").first();
  return ok(context, {
    status: "healthy" as const,
    database: "available" as const,
    files: "configured" as const,
    fileStorage: "workers_kv_free" as const,
    maximumFileBytes: PRIVATE_OBJECT_MAX_BYTES,
    storageBudgetBytes: PRIVATE_OBJECT_TOTAL_BUDGET_BYTES,
    archive: "configured" as const,
  });
});

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/public/shares", publicShareRoutes);
app.route("/api/v1/app/ideas", ideaRoutes);
app.route("/api/v1/app/print", operationsPrintRoutes);
app.route("/api/v1/app/print", printRoutes);
app.route("/api/v1/app", appRoutes);
app.route("/api/v1/app/projects", projectRoutes);
app.route("/api/v1/app/projects/:projectId/dashboard", dashboardRoutes);
app.route("/api/v1/app/projects/:projectId/collaboration", collaborationRoutes);
app.route("/api/v1/app/projects/:projectId/records", recordRoutes);
app.route("/api/v1/app/projects/:projectId/screenplay", screenplayRoutes);
app.route("/api/v1/app/projects/:projectId/files", fileRoutes);
app.route("/api/v1/app/projects/:projectId/shares", shareManagementRoutes);
app.route("/api/v1/app/projects/:projectId/readiness", readinessRoutes);
app.route("/api/v1/app/projects/:projectId/operations", operationsRoutes);
app.route("/api/v1/app/projects/:projectId/planning-controls", planningControlRoutes);
app.route("/api/v1/app/projects/:projectId/archive", projectArchiveRoutes);
app.route("/api/v1/service/archive", archiveServiceRoutes);

app.notFound((context) => {
  if (new URL(context.req.url).pathname.startsWith("/api/")) {
    return errorEnvelope(
      context,
      { code: "route_not_found", message: "The requested API route was not found." },
      404,
    );
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

app.onError((error, context) => {
  const requestId = context.get("requestId") || crypto.randomUUID();
  structuredError(error, requestId, new URL(context.req.url).pathname);
  if (error instanceof HttpError) {
    return errorEnvelope(
      context,
      {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      error.status,
    );
  }
  if (error instanceof ZodError) {
    return errorEnvelope(
      context,
      {
        code: "validation_failed",
        message: "The request did not pass validation.",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        },
      },
      422,
    );
  }
  return errorEnvelope(
    context,
    { code: "internal_error", message: "The request could not be completed." },
    500 as ContentfulStatusCode,
  );
});

const worker: ExportedHandler<CloudflareBindings> = {
  fetch(request, bindings, executionContext) {
    return app.fetch(request, applicationBindings(bindings), executionContext);
  },
};

export default worker;
export { ArchiveWorkflow } from "./archive-workflow";
export { ProjectCollaborationHub } from "./project-collaboration-hub";
