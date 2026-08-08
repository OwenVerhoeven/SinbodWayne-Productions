/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = resolve(process.cwd(), "migrations");
  for (const migration of readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))) {
    database.exec(readFileSync(resolve(directory, migration), "utf8"));
  }
  return database;
}

describe("external approval actor schema", () => {
  it("requires exactly one honest actor and keeps the decision immutable", () => {
    const db = migratedDatabase();
    const now = 1_800_000_000_000;
    db.prepare(
      "INSERT INTO workspaces (id, name, company_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws", "Workspace", "Company", now, now);
    db.prepare(
      "INSERT INTO user_identities (id, workspace_id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("user", "ws", "Owner", "Owner", "workspace_owner", now, now);
    db.prepare(
      "INSERT INTO projects (id, workspace_id, title, code, type, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("project", "ws", "Project", "APPROVAL", "short_film", "user", now, now);
    db.prepare(
      `INSERT INTO object_registry
        (id, workspace_id, project_id, object_type, domain_table, domain_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "object",
      "ws",
      "project",
      "report_snapshot",
      "report_snapshots",
      "report",
      "Report",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO approvals
        (id, workspace_id, project_id, object_id, title, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("approval", "ws", "project", "object", "Review report", now, now, now);
    db.prepare(
      `INSERT INTO share_links
        (id, workspace_id, project_id, public_locator, secret_digest, purpose, object_type,
         object_id, allowed_actions_json, field_projection_json, created_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "share",
      "ws",
      "project",
      "locator",
      "digest",
      "approver",
      "report_snapshot",
      "report",
      '["view","approve"]',
      '{"approvalId":"approval"}',
      "user",
      now + 60_000,
      now,
    );

    const insert = (
      id: string,
      actorUserId: string | null,
      shareLinkId: string | null,
      actorLabel: string | null,
    ) =>
      db
        .prepare(
          `INSERT INTO approval_decisions
          (id, workspace_id, project_id, approval_id, decision, actor_user_id,
           share_link_id, actor_label, created_at)
         VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
        )
        .run(id, "ws", "project", "approval", actorUserId, shareLinkId, actorLabel, now);

    expect(() => insert("decision_none", null, null, null)).toThrow(/CHECK/iu);
    expect(() => insert("decision_both", "user", "share", "Reviewer")).toThrow(/CHECK/iu);
    expect(() => insert("decision_unlabelled", null, "share", null)).toThrow(/CHECK/iu);
    expect(() => insert("decision_user", "user", null, null)).not.toThrow();
    expect(() => insert("decision_share", null, "share", "External reviewer")).not.toThrow();
    expect(() =>
      db
        .prepare("UPDATE approval_decisions SET comment = ? WHERE id = ?")
        .run("rewrite", "decision_share"),
    ).toThrow(/immutable/iu);
    expect(() =>
      db.prepare("DELETE FROM approval_decisions WHERE id = ?").run("decision_share"),
    ).toThrow(/immutable/iu);
    db.close();
  });
});
