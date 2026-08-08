import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { hashCanonicalJson, type JsonValue } from "@swp/domain";
import { getPlatformProxy } from "wrangler";

import {
  DEFAULT_READINESS_RULES,
  resultFromObservation,
  type RuleRuntime,
} from "../src/server/readiness/engine";
import { loadReadinessSources } from "../src/server/readiness/sources";
import {
  buildTestSeedSql,
  createTestSeedCredentials,
  createTestSeedObjects,
  fixtureId,
  localSeedPersistencePath,
  testSeedPersistencePath,
} from "./lib/seed";
import {
  applyLocalMigrations,
  executeD1SqlFile,
  getLocalKvObject,
  putLocalKvObject,
  queryD1,
} from "./lib/wrangler-runner";

type SeedTarget = "test" | "local";

const READINESS_TIME = Date.UTC(2026, 6, 7, 12, 0, 0);

async function finaliseReadinessFixture(database: D1Database): Promise<void> {
  const workspaceId = fixtureId("workspace");
  const projectId = fixtureId("project");
  const shootDayId = fixtureId("shoot-day");
  const ownerId = fixtureId("owner");
  const projectRegistryId = fixtureId("registry:project");
  const profileId = fixtureId("readiness-profile:launch");
  const profileVersionId = fixtureId("readiness-profile-version:launch");

  const existing = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM readiness_issues WHERE state = 'ready') AS issues,
        (SELECT COUNT(*) FROM readiness_results) AS results,
        (SELECT COUNT(*) FROM readiness_sources) AS sources,
        (SELECT COUNT(*) FROM readiness_rules
          WHERE readiness_profile_version_id = ?1) AS rules`,
    )
    .bind(profileVersionId)
    .first<{ issues: number; results: number; sources: number; rules: number }>();
  const expectedEvidenceCount = DEFAULT_READINESS_RULES.length * 2;
  if (
    existing?.issues === 2 &&
    existing.results === expectedEvidenceCount &&
    existing.sources === expectedEvidenceCount &&
    existing.rules === DEFAULT_READINESS_RULES.length
  ) {
    return;
  }
  if ((existing?.issues ?? 0) > 0) {
    throw new Error(
      "The isolated fixture contains an incomplete immutable readiness issue; reset its local test state before reseeding.",
    );
  }

  await database.batch([
    database.prepare("DELETE FROM readiness_stale_events"),
    database.prepare("DELETE FROM readiness_issue_sources"),
    database.prepare("DELETE FROM readiness_issue_results"),
    database.prepare("DELETE FROM readiness_issues"),
    database.prepare("DELETE FROM readiness_sources"),
    database.prepare("DELETE FROM readiness_results"),
    database.prepare("DELETE FROM readiness_evaluations"),
    database.prepare("DELETE FROM readiness_overrides"),
    database.prepare("DELETE FROM readiness_rules"),
    database.prepare("DELETE FROM readiness_profile_versions"),
    database.prepare("DELETE FROM readiness_profiles"),
  ]);

  const configuration: JsonValue = {
    schemaVersion: "1",
    projectType: "short_film",
    rules: DEFAULT_READINESS_RULES.map((rule) => ({ ...rule })),
  };
  const profileStatements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO readiness_profiles
          (id, workspace_id, project_id, title, status, summary, owner_user_id, sort_rank,
           project_type, current_version_id, details_json, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Ready to Shoot', 'active', ?4, ?5, 'a0', 'short_film', ?6,
                 '{}', 1, NULL, ?7, ?7)`,
      )
      .bind(
        profileId,
        workspaceId,
        projectId,
        "Complete deterministic pre-production readiness profile",
        ownerId,
        profileVersionId,
        READINESS_TIME,
      ),
    database
      .prepare(
        `INSERT INTO readiness_profile_versions
          (id, workspace_id, project_id, readiness_profile_id, version_number, name,
           configuration_json, content_hash, author_user_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, 'Launch readiness profile', ?5, ?6, ?7, ?8)`,
      )
      .bind(
        profileVersionId,
        workspaceId,
        projectId,
        profileId,
        JSON.stringify(configuration),
        await hashCanonicalJson(configuration),
        ownerId,
        READINESS_TIME,
      ),
  ];

  const runtimeRules: RuleRuntime[] = DEFAULT_READINESS_RULES.map((rule, index) => {
    const ruleId = fixtureId(`readiness-rule:launch:${rule.code}`);
    profileStatements.push(
      database
        .prepare(
          `INSERT INTO readiness_rules
            (id, workspace_id, project_id, readiness_profile_version_id, code, title, category,
             scope, evaluation_type, severity, required, owner_only_override,
             rule_definition_json, sort_rank, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'automatic', ?9, 1, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          ruleId,
          workspaceId,
          projectId,
          profileVersionId,
          rule.code,
          rule.title,
          rule.category,
          rule.scope,
          rule.severity,
          rule.ownerOnlyOverride ? 1 : 0,
          JSON.stringify({
            categoryLabel: rule.categoryLabel,
            resolutionSegment: rule.resolutionSegment,
          }),
          `a${String(index).padStart(3, "0")}`,
          READINESS_TIME,
        ),
    );
    return {
      id: ruleId,
      code: rule.code,
      title: rule.title,
      category: rule.category,
      categoryLabel: rule.categoryLabel,
      scope: rule.scope,
      severity: rule.severity,
      required: rule.required,
      automatic: true,
      ownerOnlyOverride: rule.ownerOnlyOverride,
      resolutionHref: `/projects/${projectId}/${rule.resolutionSegment}`,
      sortRank: `a${String(index).padStart(3, "0")}`,
    };
  });
  await database.batch(profileStatements);

  for (const [scopeIndex, scopedShootDayId] of [null, shootDayId].entries()) {
    const scopeLabel = scopedShootDayId === null ? "project" : "shoot-day";
    const evaluatedAt = READINESS_TIME + scopeIndex * 60_000;
    const evaluationId = fixtureId(`readiness-evaluation:${scopeLabel}:ready`);
    const issueId = fixtureId(`readiness-issue:${scopeLabel}`);
    const sources = await loadReadinessSources(
      {
        db: database,
        workspaceId,
        projectId,
        shootDayId: scopedShootDayId,
        projectOwnerId: ownerId,
        now: evaluatedAt,
      },
      runtimeRules,
    );
    const statements: D1PreparedStatement[] = [
      database
        .prepare(
          `INSERT INTO readiness_evaluations
            (id, workspace_id, project_id, shoot_day_id, readiness_profile_version_id, state,
             source_watermark, started_by_user_id, started_at, completed_at, error_code)
           VALUES (?1, ?2, ?3, ?4, ?5, 'complete', ?6, ?7, ?6, ?6, NULL)`,
        )
        .bind(
          evaluationId,
          workspaceId,
          projectId,
          scopedShootDayId,
          profileVersionId,
          evaluatedAt,
          ownerId,
        ),
    ];
    const manifestResults: JsonValue[] = [];

    for (const rule of runtimeRules) {
      const source = sources.get(rule.id);
      if (!source) throw new Error(`Missing readiness source for ${rule.code}.`);
      const resultId = fixtureId(`readiness-result:${scopeLabel}:${rule.code}`);
      const stored = resultFromObservation(rule, source);
      const overrideId =
        stored === "pass" ? null : fixtureId(`readiness-override:${scopeLabel}:${rule.code}`);
      const effectiveResult = overrideId === null ? "pass" : "overridden";
      const sourcePin = {
        objectId: projectRegistryId,
        revisionId: rule.id,
        contentHash: source.sourceHash,
      };
      statements.push(
        database
          .prepare(
            `INSERT INTO readiness_results
              (id, workspace_id, project_id, readiness_evaluation_id, readiness_rule_id, result,
               owner_user_id, due_at, explanation, evidence_json, resolution_object_id, evaluated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11)`,
          )
          .bind(
            resultId,
            workspaceId,
            projectId,
            evaluationId,
            rule.id,
            stored,
            source.ownerId,
            source.dueAt,
            source.description,
            JSON.stringify({
              sourceLabel: source.sourceLabel,
              evidence: source.evidence,
              sourceHash: source.sourceHash,
              resolutionHref: rule.resolutionHref,
              present: source.present,
              snapshot: source.snapshot,
            }),
            evaluatedAt,
          ),
        database
          .prepare(
            `INSERT INTO readiness_sources
              (id, readiness_result_id, object_id, revision_or_version_id, source_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            fixtureId(`readiness-source:${scopeLabel}:${rule.code}`),
            resultId,
            projectRegistryId,
            rule.id,
            source.sourceHash,
            evaluatedAt,
          ),
      );
      if (overrideId !== null) {
        statements.push(
          database
            .prepare(
              `INSERT INTO readiness_overrides
                (id, workspace_id, project_id, shoot_day_id, readiness_rule_id, scope, reason,
                 actor_user_id, expires_at, evidence_object_id, created_at, revoked_at,
                 revoked_by_user_id, revoke_reason)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, NULL, NULL, NULL)`,
            )
            .bind(
              overrideId,
              workspaceId,
              projectId,
              scopedShootDayId,
              rule.id,
              scopeLabel,
              `Authorised fictional-fixture override: ${source.description}`,
              ownerId,
              projectRegistryId,
              evaluatedAt + 500,
            ),
        );
      }
      const snapshot: JsonValue = {
        ruleId: rule.id,
        code: rule.code,
        title: rule.title,
        category: rule.category,
        required: rule.required,
        severity: rule.severity,
        result: effectiveResult,
        explanation: source.description,
        owner: source.ownerId,
        dueAt: source.dueAt,
        sourceLabel: source.sourceLabel,
        evidence: source.evidence,
        overrideId,
        sourcePin,
        sourceSnapshot: source.snapshot,
      };
      manifestResults.push(snapshot);
      statements.push(
        database
          .prepare(
            `INSERT INTO readiness_issue_results
              (id, readiness_issue_id, readiness_rule_id, result, snapshot_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            fixtureId(`readiness-issue-result:${scopeLabel}:${rule.code}`),
            issueId,
            rule.id,
            effectiveResult,
            JSON.stringify(snapshot),
            evaluatedAt + 1_000,
          ),
        database
          .prepare(
            `INSERT INTO readiness_issue_sources
              (id, readiness_issue_id, object_id, revision_or_version_id, source_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            fixtureId(`readiness-issue-source:${scopeLabel}:${rule.code}`),
            issueId,
            projectRegistryId,
            rule.id,
            source.sourceHash,
            evaluatedAt + 1_000,
          ),
      );
    }

    const manifest: JsonValue = {
      schemaVersion: "1",
      issueId,
      issueNumber: 1,
      issuedAt: evaluatedAt + 1_000,
      actorId: ownerId,
      workspaceId,
      projectId,
      shootDayId: scopedShootDayId,
      evaluationId,
      readinessProfileVersionId: profileVersionId,
      supersedesIssueId: null,
      results: manifestResults,
    };
    statements.splice(
      1,
      0,
      database
        .prepare(
          `INSERT INTO readiness_issues
            (id, workspace_id, project_id, shoot_day_id, readiness_evaluation_id, issue_number,
             title, state, manifest_json, manifest_hash, issued_by_user_id, issued_at,
             supersedes_issue_id)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'ready', ?7, ?8, ?9, ?10, NULL)`,
        )
        .bind(
          issueId,
          workspaceId,
          projectId,
          scopedShootDayId,
          evaluationId,
          scopedShootDayId === null
            ? "Night Bus to Noord — Ready to Shoot 1"
            : "Night Bus to Noord — Shoot-day Ready to Shoot 1",
          JSON.stringify(manifest),
          await hashCanonicalJson(manifest),
          ownerId,
          evaluatedAt + 1_000,
        ),
    );
    await database.batch(statements);
  }

  await database.batch([
    database
      .prepare(
        `UPDATE projects SET phase = 'ready_to_shoot', readiness_state = 'ready',
             readiness_score = 100, version = version + 1, updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3`,
      )
      .bind(READINESS_TIME + 120_000, projectId, workspaceId),
    database
      .prepare(
        `UPDATE shoot_days SET readiness_state = 'ready', version = version + 1, updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3 AND project_id = ?4`,
      )
      .bind(READINESS_TIME + 120_000, shootDayId, workspaceId, projectId),
  ]);
}

async function assertIsolatedSeedTarget(persistencePath: string): Promise<void> {
  const rows = await queryD1(
    "local",
    `SELECT
      (SELECT COUNT(*) FROM workspaces) AS workspaces,
      (SELECT COUNT(*) FROM user_identities) AS users,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM workspaces WHERE id <> '${fixtureId("workspace")}') AS unexpectedWorkspaces,
      (SELECT COUNT(*) FROM user_identities WHERE id NOT IN ('${fixtureId("owner")}', '${fixtureId("producer")}')) AS unexpectedUsers,
      (SELECT COUNT(*) FROM projects WHERE id <> '${fixtureId("project")}') AS unexpectedProjects;`,
    { persistTo: persistencePath },
  );
  const result = rows[0];
  if (
    result === undefined ||
    Number(result.workspaces) > 1 ||
    Number(result.users) > 2 ||
    Number(result.projects) > 1 ||
    Number(result.unexpectedWorkspaces) !== 0 ||
    Number(result.unexpectedUsers) !== 0 ||
    Number(result.unexpectedProjects) !== 0
  ) {
    throw new Error(
      "Seed target is not an isolated fictional-fixture database; no fixture records were written.",
    );
  }
}

function parseTarget(args: readonly string[]): SeedTarget {
  if (args.length !== 2 || args[0] !== "--target" || (args[1] !== "test" && args[1] !== "local")) {
    throw new Error(
      "Usage: seed.ts --target test|local. This utility never accepts a remote target.",
    );
  }
  return args[1];
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const persistencePath = target === "test" ? testSeedPersistencePath : localSeedPersistencePath;
  await applyLocalMigrations(persistencePath);
  await assertIsolatedSeedTarget(persistencePath);
  const objects = createTestSeedObjects();
  for (const object of objects) {
    await putLocalKvObject(object.objectKey, object.bytes, object.contentType, persistencePath);
  }
  for (const object of objects) {
    const stored = await getLocalKvObject(object.objectKey, persistencePath);
    const storedHash = createHash("sha256").update(stored).digest("hex");
    if (stored.byteLength !== object.bytes.byteLength || storedHash !== object.sha256) {
      throw new Error(`Local KV fixture verification failed for ${object.label}.`);
    }
  }
  const credentials = await createTestSeedCredentials();
  await executeD1SqlFile("local", buildTestSeedSql(credentials), {
    persistTo: persistencePath,
    temporaryPrefix: "swp-test-seed-",
  });
  const platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: resolve(process.cwd(), "wrangler.jsonc"),
    persist: { path: resolve(persistencePath, "v3") },
    remoteBindings: false,
  });
  try {
    await finaliseReadinessFixture(platform.env.DB);
  } finally {
    await platform.dispose();
  }
  const rows = await queryD1(
    "local",
    `SELECT
      (SELECT COUNT(*) FROM user_identities) AS users,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM scenes WHERE project_id = '${fixtureId("project")}') AS scenes,
      (SELECT COUNT(*) FROM readiness_issues WHERE state = 'ready') AS readinessIssues,
      (SELECT COUNT(*) FROM readiness_results) AS readinessResults,
      (SELECT COUNT(*) FROM readiness_sources) AS readinessSources,
      (SELECT COUNT(*) FROM archive_jobs WHERE status = 'verified') AS verifiedArchives;`,
    { persistTo: persistencePath },
  );
  const result = rows[0];
  if (
    result === undefined ||
    Number(result.users) !== 2 ||
    Number(result.projects) !== 1 ||
    Number(result.scenes) !== 6 ||
    Number(result.readinessIssues) !== 2 ||
    Number(result.readinessResults) !== DEFAULT_READINESS_RULES.length * 2 ||
    Number(result.readinessSources) !== DEFAULT_READINESS_RULES.length * 2 ||
    Number(result.verifiedArchives) !== 1
  ) {
    throw new Error("Seed verification failed; the isolated fictional fixture is incomplete.");
  }
  process.stdout.write(
    `Fictional ${target} fixture verified: 1 project, 6 scenes, readiness and archive evidence present.\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Test seed failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
