import { createUuidV7 } from "@swp/domain";

import { HttpError } from "../http/errors";

export function parseIfMatch(value?: string): number {
  const match = value?.match(/^(?:W\/)?"(\d+)"$/u);
  if (!match?.[1])
    throw new HttpError(409, "version_required", "A current record version is required.");
  return Number(match[1]);
}

export function versionGuard(
  db: D1Database,
  table: string,
  recordId: string,
  workspaceId: string,
  projectId: string | undefined,
  expectedVersion: number,
) {
  const guardId = createUuidV7();
  const lookup =
    projectId === undefined
      ? `(SELECT version FROM ${table} WHERE id = ?3 AND workspace_id = ?4)`
      : `(SELECT version FROM ${table} WHERE id = ?3 AND workspace_id = ?4 AND project_id = ?5)`;
  return {
    guardId,
    insert: db
      .prepare(
        `INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at)
       VALUES (?1, ?2, COALESCE(${lookup}, -1), ?${projectId === undefined ? 5 : 6})`,
      )
      .bind(
        ...(projectId === undefined
          ? [guardId, expectedVersion, recordId, workspaceId, Date.now()]
          : [guardId, expectedVersion, recordId, workspaceId, projectId, Date.now()]),
      ),
    remove: db.prepare("DELETE FROM optimistic_mutation_guards WHERE id = ?1").bind(guardId),
  };
}
