/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapInspectionSql,
  buildBootstrapSql,
  createProvisionAccount,
  launchAccounts,
  parseBootstrapSnapshot,
  validatePreflight,
  verifyCompletedBootstrap,
} from "../../scripts/lib/bootstrap";
import { fixtureId } from "../../scripts/lib/seed";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

async function inspect() {
  const row = await testEnv.DB.prepare(bootstrapInspectionSql).first<Record<string, unknown>>();
  return parseBootstrapSnapshot(row ?? undefined);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("account bootstrap against an isolated D1 database", () => {
  it("creates exactly three accounts, is idempotent, and resumes a partial pointer write", async () => {
    const workspaceId = fixtureId("bootstrap-worker-workspace");
    const now = Date.UTC(2026, 0, 1);
    const provisions = await Promise.all(
      launchAccounts.map((account, index) =>
        createProvisionAccount(
          account,
          `synthetic-worker-bootstrap-passphrase-${index}`,
          undefined,
          now + index * 20,
        ),
      ),
    );
    const sql = buildBootstrapSql(
      { workspaces: [], users: [] },
      workspaceId,
      provisions,
      [],
      [],
      now,
    );

    await testEnv.DB.exec(sql);
    const first = await inspect();
    expect(() => verifyCompletedBootstrap(first)).not.toThrow();
    expect(first.users.map((user) => user.username)).toEqual(
      launchAccounts.map((account) => account.username),
    );
    const originalCredentialIds = first.users.map((user) => user.currentCredentialId);

    await testEnv.DB.exec(sql);
    const second = await inspect();
    expect(() => verifyCompletedBootstrap(second)).not.toThrow();
    expect(second.users.map((user) => user.currentCredentialId)).toEqual(originalCredentialIds);
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM password_credentials").first<number>(
        "count",
      ),
    ).toBe(3);

    await testEnv.DB.prepare(
      "UPDATE user_identities SET current_password_credential_id = NULL, version = version + 1 WHERE username = ?",
    )
      .bind(launchAccounts[0].username)
      .run();
    const interrupted = await inspect();
    const preflight = validatePreflight(interrupted);
    expect(preflight.missingCredentials).toHaveLength(0);
    expect(preflight.credentialPointerRepairs).toHaveLength(1);
    await testEnv.DB.exec(
      buildBootstrapSql(
        interrupted,
        workspaceId,
        [],
        [],
        preflight.credentialPointerRepairs,
        now + 1_000,
      ),
    );
    const repaired = await inspect();
    expect(() => verifyCompletedBootstrap(repaired)).not.toThrow();
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM password_credentials").first<number>(
        "count",
      ),
    ).toBe(3);
  }, 30_000);
});
