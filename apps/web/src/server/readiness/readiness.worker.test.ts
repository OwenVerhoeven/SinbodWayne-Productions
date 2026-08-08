/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { createUuidV7 } from "@swp/domain";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../auth/crypto";
import { errorEnvelope } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requestContext } from "../http/security";
import type { AppEnv } from "../http/types";
import { readinessRoutes } from "../routes/readiness";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
const app = new Hono<AppEnv>();
app.use("*", requestContext);
app.route("/api/v1/app/projects/:projectId/readiness", readinessRoutes);
app.onError((error, context) => {
  if (error instanceof HttpError) {
    return errorEnvelope(
      context,
      { code: error.code, message: error.message, details: error.details },
      error.status,
    );
  }
  throw error;
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectRegistryId: string;
  readonly shootDayId: string;
  readonly ownerId: string;
  readonly owner: SessionFixture;
  readonly producer: SessionFixture;
}

interface SessionFixture {
  readonly token: string;
  readonly csrf: string;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("readiness Worker routes against isolated D1", () => {
  it("persists blockers, enforces override policy, issues immutably and detects exact staleness", async () => {
    const fixture = await seedFixture();
    const unevaluated = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness`,
      { method: "GET" },
    );
    expect(unevaluated.status).toBe(200);
    expect(
      await responseData<{ state: string; staleReasons: string[] }>(unevaluated),
    ).toMatchObject({
      state: "stale",
      staleReasons: ["No persisted readiness evaluation exists."],
    });
    const evaluation = await authenticatedRequest(
      fixture.producer,
      `/api/v1/app/projects/${fixture.projectId}/readiness/evaluate`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "readiness-evaluation-test-0001" },
      },
    );
    expect(evaluation.status).toBe(201);
    const evaluationBody = await responseData<{
      evaluationId: string;
      state: string;
      summary: { blocking: number };
      groups: { results: { id: string; label: string; ownerOnly: boolean; status: string }[] }[];
    }>(evaluation);
    expect(evaluationBody.state).toBe("blocked");
    expect(evaluationBody.summary.blocking).toBeGreaterThan(0);
    const securityResult = evaluationBody.groups
      .flatMap((group) => group.results)
      .find((result) => result.label === "Workspace account boundary healthy");
    expect(securityResult).toMatchObject({ ownerOnly: true, status: "blocking" });
    if (!securityResult) throw new Error("Security readiness result was not returned.");

    const producerOverride = await authenticatedRequest(
      fixture.producer,
      `/api/v1/app/projects/${fixture.projectId}/readiness/overrides`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-override-test-0001",
        },
        body: JSON.stringify({
          resultId: securityResult.id,
          reason: "Synthetic producer must not cross the owner-only security boundary.",
        }),
      },
    );
    expect(producerOverride.status).toBe(403);

    const blockedIssue = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/issues`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-issue-test-0001",
        },
        body: JSON.stringify({ evaluationId: evaluationBody.evaluationId }),
      },
    );
    expect(blockedIssue.status).toBe(409);
    expect(await errorCode(blockedIssue)).toBe("readiness_blocked");

    const allResults = evaluationBody.groups
      .flatMap((group) => group.results)
      .filter((result) => result.status === "blocking" || result.status === "warning");
    for (const [index, result] of allResults.entries()) {
      const ownerOverride = await authenticatedRequest(
        fixture.owner,
        `/api/v1/app/projects/${fixture.projectId}/readiness/overrides`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `readiness-owner-override-${String(index).padStart(4, "0")}`,
          },
          body: JSON.stringify({
            resultId: result.id,
            reason: `Synthetic owner override for isolated readiness rule ${result.label}.`,
          }),
        },
      );
      if (ownerOverride.status !== 201) {
        throw new Error(
          `Override ${index} (${result.label}) failed: ${ownerOverride.status} ${await ownerOverride.text()}`,
        );
      }
    }

    const readyView = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness`,
      { method: "GET" },
    );
    expect(readyView.status).toBe(200);
    expect(
      await responseData<{ state: string; summary: { blocking: number } }>(readyView),
    ).toMatchObject({ state: "ready", summary: { blocking: 0 } });

    const issue = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/issues`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-issue-test-0002",
        },
        body: JSON.stringify({ evaluationId: evaluationBody.evaluationId }),
      },
    );
    expect(issue.status).toBe(201);
    const firstIssue = await responseData<{ issueId: string; issueNumber: number }>(issue);
    expect(firstIssue).toMatchObject({ issueNumber: 1 });
    expect(firstIssue.issueId).toMatch(/^[0-9a-f-]{36}$/u);

    const manifestJson = await testEnv.DB.prepare(
      "SELECT manifest_json FROM readiness_issues WHERE id = ?1",
    )
      .bind(firstIssue.issueId)
      .first<string>("manifest_json");
    const manifest = JSON.parse(manifestJson ?? "null") as {
      approvals: { id: string; status: string; latestDecision: { decision: string } | null }[];
      approvalDecisions: { approvalId: string; decision: string }[];
      overrides: { id: string; actorRole: string; reason: string }[];
      results: { sourceSnapshot: { fingerprint: unknown }; sourcePin: { contentHash: string } }[];
    };
    expect(manifest.approvals).toHaveLength(1);
    expect(manifest.approvals[0]).toMatchObject({
      status: "approved",
      latestDecision: { decision: "approved" },
    });
    expect(manifest.approvalDecisions).toEqual([expect.objectContaining({ decision: "approved" })]);
    expect(manifest.overrides).toHaveLength(allResults.length);
    expect(manifest.overrides.every((override) => override.actorRole === "workspace_owner")).toBe(
      true,
    );
    expect(manifest.overrides.every((override) => override.reason.length >= 12)).toBe(true);
    expect(manifest.results).toHaveLength(19);
    expect(manifest.results[0]?.sourceSnapshot.fingerprint).toBeDefined();
    expect(manifest.results[0]?.sourcePin.contentHash).toMatch(/^[0-9a-f]{64}$/u);

    const expiringOverride = manifest.overrides[0];
    if (!expiringOverride) throw new Error("The issued fixture did not freeze an override.");
    await testEnv.DB.prepare("UPDATE readiness_overrides SET expires_at = ?1 WHERE id = ?2")
      .bind(Date.now() - 1, expiringOverride.id)
      .run();
    const expiredOverrideView = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness`,
      { method: "GET" },
    );
    const expiredOverrideBody = await responseData<{ state: string; staleReasons: string[] }>(
      expiredOverrideView,
    );
    expect(expiredOverrideBody.state).toBe("stale");
    expect(
      expiredOverrideBody.staleReasons.some((reason) =>
        reason.includes("readiness override expired"),
      ),
    ).toBe(true);

    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM readiness_issue_results WHERE readiness_issue_id = ?1",
      )
        .bind(firstIssue.issueId)
        .first<number>("count"),
    ).toBe(19);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM readiness_issue_sources WHERE readiness_issue_id = ?1",
      )
        .bind(firstIssue.issueId)
        .first<number>("count"),
    ).toBe(19);
    await expect(
      testEnv.DB.prepare("UPDATE readiness_issues SET manifest_json = '{}' WHERE id = ?1")
        .bind(firstIssue.issueId)
        .run(),
    ).rejects.toThrow(/immutable/iu);

    await testEnv.DB.prepare(
      `INSERT INTO legal_holds
        (id, workspace_id, project_id, title, reason, scope, placed_by_user_id, placed_at)
       VALUES (?1, ?2, ?3, 'Fixture hold', 'Synthetic stale-source change', 'project', ?4, ?5)`,
    )
      .bind(createUuidV7(), fixture.workspaceId, fixture.projectId, fixture.ownerId, Date.now())
      .run();
    const staleView = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness`,
      { method: "GET" },
    );
    expect(staleView.status).toBe(200);
    const staleBody = await responseData<{
      state: string;
      staleReasons: string[];
      latestIssue: { staleAt: number | null };
    }>(staleView);
    expect(staleBody.state).toBe("stale");
    expect(staleBody.staleReasons).toContain(
      "No unresolved legal-hold restriction: source data changed after evaluation.",
    );
    expect(staleBody.latestIssue.staleAt).toEqual(expect.any(Number));
    expect(
      await testEnv.DB.prepare("SELECT state FROM readiness_issues WHERE id = ?1")
        .bind(firstIssue.issueId)
        .first<string>("state"),
    ).toBe("stale");
    const staleEvent = await testEnv.DB.prepare(
      `SELECT prior_revision_or_version_id AS prior_hash,
              current_revision_or_version_id AS current_hash
         FROM readiness_stale_events
        WHERE readiness_issue_id = ?1 AND reason LIKE '%legal-hold%' LIMIT 1`,
    )
      .bind(firstIssue.issueId)
      .first<{ prior_hash: string; current_hash: string }>();
    expect(staleEvent?.prior_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(staleEvent?.current_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(staleEvent?.current_hash).not.toBe(staleEvent?.prior_hash);

    const reevaluation = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/evaluate`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "readiness-evaluation-test-0002" },
      },
    );
    expect(reevaluation.status).toBe(201);
    const reevaluationBody = await responseData<{
      evaluationId: string;
      state: string;
      groups: { results: { id: string; label: string; status: string }[] }[];
    }>(reevaluation);
    expect(reevaluationBody.state).toBe("blocked");
    const reevaluationResults = reevaluationBody.groups.flatMap((group) => group.results);
    const legalHoldResult = reevaluationResults.find(
      (result) => result.label === "No unresolved legal-hold restriction",
    );
    if (!legalHoldResult) throw new Error("Legal-hold readiness result was not returned.");
    const reevaluationGaps = reevaluationResults.filter(
      (result) => result.status === "blocking" || result.status === "warning",
    );
    for (const [index, result] of reevaluationGaps.entries()) {
      const replacementOverride = await authenticatedRequest(
        fixture.owner,
        `/api/v1/app/projects/${fixture.projectId}/readiness/overrides`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `readiness-reevaluation-override-${String(index).padStart(4, "0")}`,
          },
          body: JSON.stringify({
            resultId: result.id,
            reason: `Synthetic replacement override after reevaluation for ${result.label}.`,
          }),
        },
      );
      expect(replacementOverride.status).toBe(201);
    }
    const reissue = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/issues`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-issue-test-0003",
        },
        body: JSON.stringify({ evaluationId: reevaluationBody.evaluationId }),
      },
    );
    expect(reissue.status).toBe(201);
    expect(await responseData<{ issueId: string; issueNumber: number }>(reissue)).toMatchObject({
      issueNumber: 2,
    });
    expect(
      await testEnv.DB.prepare("SELECT state FROM readiness_issues WHERE id = ?1")
        .bind(firstIssue.issueId)
        .first<string>("state"),
    ).toBe("superseded");
    const replayedFirstIssue = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/issues`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-issue-test-0002",
        },
        body: JSON.stringify({ evaluationId: evaluationBody.evaluationId }),
      },
    );
    expect(replayedFirstIssue.status).toBe(200);
    expect(await responseData<{ issueId: string }>(replayedFirstIssue)).toMatchObject({
      issueId: firstIssue.issueId,
    });

    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM readiness_profiles
          WHERE project_id = ?1 AND status = 'active' AND archived_at IS NULL`,
      )
        .bind(fixture.projectId)
        .first<number>("count"),
    ).toBe(1);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM readiness_rules rr
          JOIN readiness_profiles rp ON rp.current_version_id = rr.readiness_profile_version_id
         WHERE rr.project_id = ?1 AND rp.status = 'active' AND rp.archived_at IS NULL`,
      )
        .bind(fixture.projectId)
        .first<number>("count"),
    ).toBe(19);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM readiness_issues WHERE project_id = ?1",
      )
        .bind(fixture.projectId)
        .first<number>("count"),
    ).toBe(2);

    const shootDayEvaluation = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/evaluate?shootDayId=${fixture.shootDayId}`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "readiness-shoot-day-evaluation-0001" },
      },
    );
    expect(shootDayEvaluation.status).toBe(201);
    const shootDayEvaluationBody = await responseData<{
      evaluationId: string;
      groups: { results: { id: string; label: string; status: string }[] }[];
    }>(shootDayEvaluation);
    const shootDayGaps = shootDayEvaluationBody.groups
      .flatMap((group) => group.results)
      .filter((result) => result.status === "blocking" || result.status === "warning");
    for (const [index, result] of shootDayGaps.entries()) {
      const response = await authenticatedRequest(
        fixture.owner,
        `/api/v1/app/projects/${fixture.projectId}/readiness/overrides`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `readiness-shoot-day-override-${String(index).padStart(4, "0")}`,
          },
          body: JSON.stringify({
            resultId: result.id,
            reason: `Synthetic shoot-day override for isolated readiness rule ${result.label}.`,
          }),
        },
      );
      expect(response.status).toBe(201);
    }
    const shootDayIssue = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness/issues`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "readiness-shoot-day-issue-0001",
        },
        body: JSON.stringify({ evaluationId: shootDayEvaluationBody.evaluationId }),
      },
    );
    expect(shootDayIssue.status).toBe(201);
    const shootDayIssueBody = await responseData<{ issueId: string }>(shootDayIssue);

    await testEnv.DB.prepare(
      `INSERT INTO legal_holds
        (id, workspace_id, project_id, title, reason, scope, placed_by_user_id, placed_at)
       VALUES (?1, ?2, ?3, 'Shoot-day fixture hold', 'Synthetic shoot-day stale change',
               'project', ?4, ?5)`,
    )
      .bind(createUuidV7(), fixture.workspaceId, fixture.projectId, fixture.ownerId, Date.now())
      .run();
    const staleShootDayView = await authenticatedRequest(
      fixture.owner,
      `/api/v1/app/projects/${fixture.projectId}/readiness?shootDayId=${fixture.shootDayId}`,
      { method: "GET" },
    );
    expect(staleShootDayView.status).toBe(200);
    expect(await responseData<{ state: string }>(staleShootDayView)).toMatchObject({
      state: "stale",
    });
    expect(
      await testEnv.DB.prepare("SELECT state FROM readiness_issues WHERE id = ?1")
        .bind(shootDayIssueBody.issueId)
        .first<string>("state"),
    ).toBe("stale");
    expect(
      await testEnv.DB.prepare("SELECT readiness_state FROM shoot_days WHERE id = ?1")
        .bind(fixture.shootDayId)
        .first<string>("readiness_state"),
    ).toBe("stale");
    expect(
      await testEnv.DB.prepare("SELECT readiness_state FROM projects WHERE id = ?1")
        .bind(fixture.projectId)
        .first<string>("readiness_state"),
    ).toBe("ready");
  }, 45_000);
});

async function seedFixture(): Promise<Fixture> {
  const workspaceId = createUuidV7();
  const ownerId = createUuidV7();
  const producerId = createUuidV7();
  const ownerCredentialId = createUuidV7();
  const producerCredentialId = createUuidV7();
  const projectId = createUuidV7();
  const projectRegistryId = createUuidV7();
  const shootDayId = createUuidV7();
  const approvalId = createUuidV7();
  const approvalDecisionId = createUuidV7();
  const approvalPinnedVersionId = createUuidV7();
  const legacyProfileId = createUuidV7();
  const legacyProfileVersionId = createUuidV7();
  const owner = { token: "synthetic-owner-session-token", csrf: "synthetic-owner-csrf" };
  const producer = { token: "synthetic-producer-session-token", csrf: "synthetic-producer-csrf" };
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    testEnv.DB.prepare(
      `INSERT INTO workspaces (id, name, company_name, created_at, updated_at)
       VALUES (?1, 'Fixture workspace', 'Fixture company', ?2, ?2)`,
    ).bind(workspaceId, now),
    testEnv.DB.prepare(
      `INSERT INTO user_identities
        (id, workspace_id, username, display_name, role, status, current_password_credential_id,
         created_at, updated_at)
       VALUES (?1, ?2, 'FixtureOwner', 'Fixture Owner', 'workspace_owner', 'active', NULL, ?3, ?3)`,
    ).bind(ownerId, workspaceId, now),
    testEnv.DB.prepare(
      `INSERT INTO user_identities
        (id, workspace_id, username, display_name, role, status, current_password_credential_id,
         created_at, updated_at)
       VALUES (?1, ?2, 'FixtureProducer', 'Fixture Producer', 'producer', 'active', ?3, ?4, ?4)`,
    ).bind(producerId, workspaceId, producerCredentialId, now),
    testEnv.DB.prepare(
      `INSERT INTO password_credentials
        (id, workspace_id, user_id, kdf, parameters_json, encoded_hash, created_at)
       VALUES (?1, ?2, ?3, 'pbkdf2-sha256', '{"iterations":600000}', ?4, ?5)`,
    ).bind(ownerCredentialId, workspaceId, ownerId, "a".repeat(64), now),
    testEnv.DB.prepare(
      `INSERT INTO password_credentials
        (id, workspace_id, user_id, kdf, parameters_json, encoded_hash, created_at)
       VALUES (?1, ?2, ?3, 'pbkdf2-sha256', '{"iterations":600000}', ?4, ?5)`,
    ).bind(producerCredentialId, workspaceId, producerId, "b".repeat(64), now),
    testEnv.DB.prepare(
      `INSERT INTO workspace_memberships
        (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'workspace_owner', 'active', ?4, ?4)`,
    ).bind(createUuidV7(), workspaceId, ownerId, now),
    testEnv.DB.prepare(
      `INSERT INTO workspace_memberships
        (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'producer', 'active', ?4, ?4)`,
    ).bind(createUuidV7(), workspaceId, producerId, now),
    testEnv.DB.prepare(
      `INSERT INTO projects
        (id, workspace_id, title, code, type, owner_user_id, created_at, updated_at)
       VALUES (?1, ?2, 'Readiness fixture', ?3, 'short_film', ?4, ?5, ?5)`,
    ).bind(projectId, workspaceId, `READY-${projectId.slice(-6)}`, ownerId, now),
    testEnv.DB.prepare(
      `INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'owner', 'active', ?5, ?5)`,
    ).bind(createUuidV7(), workspaceId, projectId, ownerId, now),
    testEnv.DB.prepare(
      `INSERT INTO project_memberships
        (id, workspace_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'producer', 'active', ?5, ?5)`,
    ).bind(createUuidV7(), workspaceId, projectId, producerId, now),
    testEnv.DB.prepare(
      `INSERT INTO object_registry
        (id, workspace_id, project_id, object_type, domain_table, domain_id, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'project', 'projects', ?3, 'Readiness fixture', ?4, ?4)`,
    ).bind(projectRegistryId, workspaceId, projectId, now),
    testEnv.DB.prepare(
      `INSERT INTO shoot_days
        (id, workspace_id, project_id, title, shoot_date, general_call_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Fixture shoot day', '2030-05-14', ?4, ?5, ?5)`,
    ).bind(shootDayId, workspaceId, projectId, now + 86_400_000, now),
    testEnv.DB.prepare(
      `INSERT INTO readiness_profiles
        (id, workspace_id, project_id, title, status, owner_user_id, current_version_id,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Legacy incomplete fixture', 'active', ?4, ?5, ?6, ?6)`,
    ).bind(legacyProfileId, workspaceId, projectId, ownerId, legacyProfileVersionId, now),
    testEnv.DB.prepare(
      `INSERT INTO readiness_profile_versions
        (id, workspace_id, project_id, readiness_profile_id, version_number, name,
         configuration_json, content_hash, author_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 1, 'Legacy incomplete v1', '{}', ?5, ?6, ?7)`,
    ).bind(
      legacyProfileVersionId,
      workspaceId,
      projectId,
      legacyProfileId,
      "c".repeat(64),
      ownerId,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT INTO readiness_rules
        (id, workspace_id, project_id, readiness_profile_version_id, code, title, category,
         scope, evaluation_type, severity, required, owner_only_override,
         rule_definition_json, sort_rank, created_at)
       VALUES (?1, ?2, ?3, ?4, 'legacy_ready', 'Legacy incomplete gate', 'legacy',
               'project', 'automatic', 'blocker', 1, 0, '{}', 'a0', ?5)`,
    ).bind(createUuidV7(), workspaceId, projectId, legacyProfileVersionId, now),
    testEnv.DB.prepare(
      `INSERT INTO approvals
        (id, workspace_id, project_id, object_id, title, status, summary, owner_user_id,
         approver_user_id, pinned_version_id, requested_at, self_approval_allowed,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'Fixture readiness approval', 'approved',
               'Synthetic immutable approval snapshot.', ?5, ?5, ?6, ?7, 1, ?7, ?7)`,
    ).bind(
      approvalId,
      workspaceId,
      projectId,
      projectRegistryId,
      ownerId,
      approvalPinnedVersionId,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT INTO approval_decisions
        (id, workspace_id, project_id, approval_id, decision, actor_user_id, comment,
         pinned_version_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'approved', ?5,
               'Synthetic approval decision frozen by the readiness issue.', ?6, ?7)`,
    ).bind(
      approvalDecisionId,
      workspaceId,
      projectId,
      approvalId,
      ownerId,
      approvalPinnedVersionId,
      now,
    ),
    await sessionStatement(workspaceId, ownerId, owner, now),
    await sessionStatement(workspaceId, producerId, producer, now),
  ];
  await testEnv.DB.batch(statements);
  return {
    workspaceId,
    projectId,
    projectRegistryId,
    shootDayId,
    ownerId,
    owner,
    producer,
  };
}

async function sessionStatement(
  workspaceId: string,
  userId: string,
  session: SessionFixture,
  now: number,
): Promise<D1PreparedStatement> {
  return testEnv.DB.prepare(
    `INSERT INTO sessions
      (id, workspace_id, user_id, token_hash, csrf_hash, auth_epoch, created_at, last_seen_at,
       idle_expires_at, absolute_expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, ?7, ?8)`,
  ).bind(
    createUuidV7(),
    workspaceId,
    userId,
    await sha256(session.token),
    await sha256(session.csrf),
    now,
    now + 3_600_000,
    now + 86_400_000,
  );
}

async function authenticatedRequest(
  session: SessionFixture,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `__Host-swp_session=${session.token}`);
  headers.set("Origin", "https://productions.sinbodwayne.nl");
  headers.set("Sec-Fetch-Site", "same-origin");
  headers.set("X-CSRF-Token", session.csrf);
  return app.request(`https://productions.sinbodwayne.nl${path}`, { ...init, headers }, testEnv);
}

async function responseData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}
