import { createUuidV7 } from "@swp/domain";

import type { ActorContext } from "./http/types";

export function auditStatement(
  db: D1Database,
  input: {
    workspaceId: string;
    projectId?: string;
    actor?: ActorContext;
    action: string;
    objectType: string;
    objectId?: string;
    requestId: string;
    details?: Record<string, unknown>;
    occurredAt?: number;
  },
) {
  return db
    .prepare(
      `INSERT INTO audit_events
      (id, workspace_id, project_id, actor_type, actor_id, action, object_type, object_id, request_id, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      createUuidV7(),
      input.workspaceId,
      input.projectId ?? null,
      input.actor ? "user" : "system",
      input.actor?.userId ?? null,
      input.action,
      input.objectType,
      input.objectId ?? null,
      input.requestId,
      JSON.stringify({
        ...(input.details ?? {}),
        ...(input.actor ? { sessionId: input.actor.sessionId } : {}),
      }),
      input.occurredAt ?? Date.now(),
    );
}
