import type { ActorContext } from "../http/types";
import { HttpError } from "../http/errors";

export type PolicyAction =
  | "workspace.manage_accounts"
  | "workspace.transfer_ownership"
  | "workspace.delete_permanently"
  | "archive.remove_cloud_copy"
  | "legal_hold.manage"
  | "readiness.override_owner_only"
  | "project.create"
  | "project.edit"
  | "project.sensitive"
  | "artifact.issue";

const ownerOnly = new Set<PolicyAction>([
  "workspace.manage_accounts",
  "workspace.transfer_ownership",
  "workspace.delete_permanently",
  "archive.remove_cloud_copy",
  "legal_hold.manage",
  "readiness.override_owner_only",
]);

export function assertAllowed(actor: ActorContext, action: PolicyAction): void {
  if (actor.role === "viewer") {
    throw new HttpError(403, "read_only_account", "This account has view-only access.");
  }
  if (ownerOnly.has(action) && actor.role !== "workspace_owner") {
    throw new HttpError(403, "permission_denied", "Your role does not allow this action.");
  }
}

export function assertAppRequestAllowed(
  actor: ActorContext,
  method: string,
  upgrade?: string,
): void {
  if (actor.role !== "viewer") return;
  if (upgrade?.toLowerCase() === "websocket") {
    throw new HttpError(
      403,
      "read_only_account",
      "Live collaboration is unavailable to view-only accounts.",
    );
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    throw new HttpError(403, "read_only_account", "This account has view-only access.");
  }
}

export async function assertProjectAccess(
  db: D1Database,
  actor: ActorContext,
  projectId: string,
  access: "view" | "edit" = "view",
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT pm.status, p.archived_at
       FROM projects p
       JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?1
      WHERE p.id = ?2 AND p.workspace_id = ?3
      LIMIT 1`,
    )
    .bind(actor.userId, projectId, actor.workspaceId)
    .first<{ status: string; archived_at: number | null }>();
  if (!row || row.status !== "active")
    throw new HttpError(404, "not_found", "The requested project was not found.");
  if (access === "edit" && row.archived_at !== null)
    throw new HttpError(409, "record_archived", "Restore the project before editing it.");
}
