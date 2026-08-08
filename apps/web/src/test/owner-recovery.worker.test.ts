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
import { buildOwnerRecoverySql, createOwnerRecovery } from "../../scripts/lib/owner-recovery";
import { fixtureId } from "../../scripts/lib/seed";
import { verifyPassword } from "../server/auth/crypto";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

async function inspect() {
  const row = await testEnv.DB.prepare(bootstrapInspectionSql).first<Record<string, unknown>>();
  return parseBootstrapSnapshot(row ?? undefined);
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("workspace-owner credential recovery", () => {
  it("rotates only the approved owner credential, revokes sessions, and leaves an audit event", async () => {
    const workspaceId = fixtureId("owner-recovery-workspace");
    const now = Date.UTC(2026, 0, 1);
    const initial = await Promise.all(
      launchAccounts.map((account, index) =>
        createProvisionAccount(
          account,
          `synthetic-initial-passphrase-${index}`,
          undefined,
          now + index * 20,
        ),
      ),
    );
    await testEnv.DB.exec(
      buildBootstrapSql({ workspaces: [], users: [] }, workspaceId, initial, [], [], now),
    );

    const before = await inspect();
    expect(() => verifyCompletedBootstrap(before)).not.toThrow();
    const ownerBefore = before.users.find((user) => user.role === "workspace_owner")!;
    const producerBefore = before.users.find((user) => user.role === "producer")!;
    await testEnv.DB.prepare(
      `INSERT INTO sessions
        (id, workspace_id, user_id, token_hash, csrf_hash, auth_epoch, created_at,
         last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
      .bind(
        fixtureId("owner-recovery-session"),
        workspaceId,
        ownerBefore.id,
        "synthetic-token-hash",
        "synthetic-csrf-hash",
        now,
        now,
        now + 60_000,
        now + 120_000,
      )
      .run();

    const newPassword = "ownerpass1";
    const recovery = await createOwnerRecovery(before, newPassword, now + 1_000);
    const sql = buildOwnerRecoverySql(before, recovery, now + 1_000);
    expect(sql).not.toContain(newPassword);
    await testEnv.DB.exec(sql);

    const after = await inspect();
    expect(() => verifyCompletedBootstrap(after)).not.toThrow();
    const ownerAfter = after.users.find((user) => user.role === "workspace_owner")!;
    const producerAfter = after.users.find((user) => user.role === "producer")!;
    expect(ownerAfter.currentCredentialId).toBe(recovery.credentialId);
    expect(producerAfter.currentCredentialId).toBe(producerBefore.currentCredentialId);
    expect(validatePreflight(after).missingCredentials).toEqual([]);

    const credential = await testEnv.DB.prepare(
      "SELECT encoded_hash FROM password_credentials WHERE id = ?",
    )
      .bind(recovery.credentialId)
      .first<{ encoded_hash: string }>();
    expect(await verifyPassword(newPassword, credential!.encoded_hash)).toBe(true);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM password_credentials WHERE user_id = ? AND superseded_at IS NULL",
      )
        .bind(ownerBefore.id)
        .first<number>("count"),
    ).toBe(1);
    expect(
      await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE user_id = ?")
        .bind(ownerBefore.id)
        .first<number>("revoked_at"),
    ).toBe(now + 1_000);
    expect(
      await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'auth.owner_credential_recovered' AND object_id = ?",
      )
        .bind(ownerBefore.id)
        .first<number>("count"),
    ).toBe(1);
  }, 30_000);
});
