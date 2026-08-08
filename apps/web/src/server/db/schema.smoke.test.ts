/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationDirectory = resolve(process.cwd(), "migrations");

const requiredTables = [
  "workspaces",
  "user_identities",
  "password_credentials",
  "sessions",
  "workspace_memberships",
  "project_memberships",
  "permission_grants",
  "share_links",
  "service_credentials",
  "audit_events",
  "notifications",
  "projects",
  "series",
  "seasons",
  "ideas",
  "project_briefs",
  "development_documents",
  "development_revisions",
  "outlines",
  "beats",
  "story_events",
  "character_profiles",
  "relationships",
  "world_notes",
  "research_items",
  "approvals",
  "screenplays",
  "script_revisions",
  "script_block_revisions",
  "scenes",
  "scene_revisions",
  "scene_mappings",
  "script_syncs",
  "script_comments",
  "av_scripts",
  "av_revisions",
  "av_segments",
  "av_rows",
  "documents",
  "document_revisions",
  "templates",
  "scene_breakdowns",
  "breakdown_overrides",
  "element_categories",
  "elements",
  "element_aliases",
  "scene_element_tags",
  "procurement_records",
  "report_definitions",
  "report_snapshots",
  "sides_issues",
  "people",
  "contact_points",
  "person_project_roles",
  "departments",
  "role_definitions",
  "availability",
  "characters",
  "cast_assignments",
  "contact_lists",
  "casting_roles",
  "candidates",
  "auditions",
  "candidate_ratings",
  "messages",
  "announcements",
  "locations",
  "sets",
  "scout_visits",
  "scout_media_groups",
  "location_availability",
  "location_scene_links",
  "boards",
  "board_groups",
  "board_items",
  "annotation_layers",
  "storyboards",
  "storyboard_frames",
  "shot_lists",
  "shots",
  "shot_source_ranges",
  "camera_setups",
  "technical_look_plans",
  "budgets",
  "budget_versions",
  "budget_accounts",
  "budget_lines",
  "vendors",
  "quotes",
  "purchase_orders",
  "invoices",
  "expenses",
  "payment_records",
  "requirements",
  "agreements",
  "releases",
  "permits",
  "insurance_records",
  "clearances",
  "risk_assessments",
  "hazards",
  "control_measures",
  "safety_plans",
  "legal_holds",
  "equipment_items",
  "equipment_kits",
  "kit_members",
  "reservations",
  "rentals",
  "transport_plans",
  "travel_records",
  "accommodation_records",
  "catering_plans",
  "logistics_plans",
  "task_boards",
  "task_columns",
  "task_cards",
  "checklists",
  "calendars",
  "calendar_revisions",
  "calendar_rows",
  "calendar_events",
  "event_dependencies",
  "comments",
  "mentions",
  "activities",
  "schedules",
  "schedule_revisions",
  "schedule_items",
  "scene_segments",
  "shoot_days",
  "resource_conflicts",
  "call_sheet_drafts",
  "call_sheet_sections",
  "call_sheet_recipients",
  "call_sheet_issues",
  "call_sheet_recipient_issues",
  "delivery_events",
  "confirmations",
  "production_pack_drafts",
  "production_pack_issues",
  "readiness_profiles",
  "readiness_rules",
  "readiness_evaluations",
  "readiness_results",
  "readiness_overrides",
  "readiness_issues",
  "files",
  "file_versions",
  "file_links",
  "folders",
  "upload_sessions",
  "export_snapshots",
  "archive_jobs",
  "archive_manifest_items",
  "archive_acknowledgements",
] as const;

const genericRecordTables = [
  "ideas",
  "project_briefs",
  "development_documents",
  "lookbooks",
  "av_scripts",
  "documents",
  "scene_breakdowns",
  "elements",
  "report_definitions",
  "boards",
  "storyboards",
  "shot_lists",
  "technical_look_plans",
  "people",
  "casting_roles",
  "locations",
  "budgets",
  "requirements",
  "equipment_items",
  "logistics_plans",
  "task_cards",
  "calendar_events",
  "schedules",
  "shoot_days",
  "messages",
  "files",
  "call_sheet_drafts",
  "production_pack_drafts",
  "export_snapshots",
] as const;

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    database.exec(readFileSync(resolve(migrationDirectory, migration), "utf8"));
  }
  return database;
}

describe("D1 schema migrations", () => {
  it("creates every required entity table plus indexes and guards", () => {
    const database = migratedDatabase();
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')")
        .all()
        .map((row) => String(row.name)),
    );
    expect(requiredTables.filter((table) => !tables.has(table))).toEqual([]);
    expect(tables.size).toBeGreaterThanOrEqual(150);

    const indexCount = Number(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index'").get()
        ?.count,
    );
    const triggerCount = Number(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()
        ?.count,
    );
    expect(indexCount).toBeGreaterThanOrEqual(65);
    expect(triggerCount).toBeGreaterThanOrEqual(75);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("enforces case-sensitive identities, mutation guards, and immutable evidence", () => {
    const database = migratedDatabase();
    const now = 1_800_000_000_000;
    database
      .prepare(
        "INSERT INTO workspaces (id, name, company_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ws_test", "Test workspace", "Test company", now, now);
    database
      .prepare(
        "INSERT INTO user_identities (id, workspace_id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user_upper", "ws_test", "CaseUser", "Case user", "workspace_owner", now, now);
    database
      .prepare(
        "INSERT INTO user_identities (id, workspace_id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user_lower", "ws_test", "caseuser", "Second case user", "producer", now, now);
    expect(() =>
      database
        .prepare(
          "INSERT INTO user_identities (id, workspace_id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("user_duplicate", "ws_test", "CaseUser", "Duplicate", "producer", now, now),
    ).toThrow();

    database
      .prepare(
        `INSERT INTO projects (
      id, workspace_id, title, code, type, owner_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "project_test",
        "ws_test",
        "Schema test",
        "SCHEMA",
        "short_film",
        "user_upper",
        now,
        now,
      );

    expect(() =>
      database
        .prepare(
          "INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("guard_bad", 1, 2, now),
    ).toThrow(/CHECK/iu);
    database
      .prepare(
        "INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("guard_ok", 1, 1, now);
    database.prepare("DELETE FROM optimistic_mutation_guards WHERE id = ?").run("guard_ok");
    expect(() =>
      database
        .prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
        .run("Bypass", now + 1, "project_test"),
    ).toThrow(/version_step/iu);
    database
      .prepare("UPDATE projects SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run("Advanced", now + 1, "project_test");

    database
      .prepare(
        "INSERT INTO audit_events (id, workspace_id, actor_type, action, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("audit_test", "ws_test", "system", "schema.checked", "{}", now);
    expect(() =>
      database
        .prepare("UPDATE audit_events SET action = ? WHERE id = ?")
        .run("rewritten", "audit_test"),
    ).toThrow(/immutable/iu);
    expect(() =>
      database.prepare("DELETE FROM audit_events WHERE id = ?").run("audit_test"),
    ).toThrow(/immutable/iu);
    database.close();
  });

  it("supports the allowlisted generic-record contract on real module tables", () => {
    const database = migratedDatabase();
    const now = 1_800_000_000_000;
    database
      .prepare(
        "INSERT INTO workspaces (id, name, company_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ws_records", "Record workspace", "Record company", now, now);
    database
      .prepare(
        "INSERT INTO user_identities (id, workspace_id, username, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user_records", "ws_records", "RecordUser", "Record user", "workspace_owner", now, now);
    database
      .prepare(
        "INSERT INTO projects (id, workspace_id, title, code, type, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "project_records",
        "ws_records",
        "Record project",
        "RECORD",
        "short_film",
        "user_records",
        now,
        now,
      );

    for (const [position, table] of genericRecordTables.entries()) {
      database
        .prepare(
          `INSERT INTO ${table} (
            id, workspace_id, project_id, title, status, summary,
            owner_user_id, sort_rank, details_json, created_by,
            created_at, updated_at, version, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
        )
        .run(
          `record_${position}`,
          "ws_records",
          "project_records",
          `Record ${position}`,
          "draft",
          null,
          "user_records",
          `a${String(position).padStart(3, "0")}`,
          "{}",
          "user_records",
          now,
          now,
        );
      expect(
        database.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(`record_${position}`)
          ?.version,
      ).toBe(1);
    }
    database.close();
  });
});
