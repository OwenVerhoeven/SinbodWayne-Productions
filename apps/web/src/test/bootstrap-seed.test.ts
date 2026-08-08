import { describe, expect, it } from "vitest";

import {
  buildBootstrapSql,
  createProvisionAccount,
  launchAccounts,
  validatePreflight,
  verifyCompletedBootstrap,
  type BootstrapSnapshot,
} from "../../scripts/lib/bootstrap";
import { buildTestSeedSql, createTestSeedCredentials, fixtureId } from "../../scripts/lib/seed";
import { encodePassword, verifyPassword } from "../server/auth/crypto";

const workspaceId = fixtureId("bootstrap-test-workspace");

function completeSnapshot(): BootstrapSnapshot {
  return {
    workspaces: [
      { id: workspaceId, name: "Sinbod Wayne", companyName: "Sinbod Wayne", archived: false },
    ],
    users: launchAccounts.map((account, index) => ({
      id: fixtureId(`bootstrap-test-user-${index}`),
      workspaceId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      status: "active",
      archived: false,
      currentCredentialId: fixtureId(`bootstrap-test-credential-${index}`),
      activeCredentialCount: 1,
      soleActiveCredentialId: fixtureId(`bootstrap-test-credential-${index}`),
      currentCredentialIsActive: true,
      membershipRole: account.role,
      membershipStatus: "active",
    })),
  };
}

describe("production account bootstrap helpers", () => {
  it("accepts exactly the approved, case-sensitive account manifest", () => {
    const snapshot = completeSnapshot();
    expect(() => verifyCompletedBootstrap(snapshot)).not.toThrow();
    snapshot.users[0]!.username = snapshot.users[0]!.username.toLocaleLowerCase("en-GB");
    expect(() => verifyCompletedBootstrap(snapshot)).toThrow(/Unexpected identity/u);
  });

  it("refuses unexpected identities or existing credential inconsistencies", () => {
    const unexpected = completeSnapshot();
    unexpected.users.push({
      ...unexpected.users[1]!,
      id: fixtureId("unexpected-user"),
      username: "UnexpectedUser",
    });
    expect(() => validatePreflight(unexpected)).toThrow(/Unexpected identity/u);

    const inconsistent = completeSnapshot();
    inconsistent.users[0]!.activeCredentialCount = 2;
    expect(() => validatePreflight(inconsistent)).toThrow(/inconsistent credential/u);
  });

  it("hashes a synthetic password with the same verifier used by Worker login", async () => {
    const syntheticPassword = "synthetic-bootstrap-passphrase";
    const account = launchAccounts[0];
    const provision = await createProvisionAccount(
      account,
      syntheticPassword,
      undefined,
      Date.UTC(2026, 0, 1),
    );
    expect(await verifyPassword(syntheticPassword, provision.encodedHash)).toBe(true);
    expect(await verifyPassword("not-the-synthetic-password", provision.encodedHash)).toBe(false);

    const sql = buildBootstrapSql(
      { workspaces: [], users: [] },
      workspaceId,
      [provision],
      [],
      [],
      Date.UTC(2026, 0, 1),
    );
    expect(sql.includes(syntheticPassword)).toBe(false);
    expect(sql.includes("INSERT OR IGNORE INTO password_credentials")).toBe(true);
    expect(sql.includes("current_password_credential_id IS NULL")).toBe(true);
  }, 20_000);

  it("binds the free-tier production verifier to its secret pepper", async () => {
    const password = "synthetic-short-pass";
    const pepper = "synthetic-test-pepper-not-a-production-secret";
    const encoded = await encodePassword(password, pepper);
    expect(encoded.encodedHash).toContain("i=10000,p=1");
    expect(await verifyPassword(password, encoded.encodedHash, pepper)).toBe(true);
    expect(await verifyPassword(password, encoded.encodedHash)).toBe(false);
    expect(await verifyPassword("wrong-password", encoded.encodedHash, pepper)).toBe(false);
  });

  it("reports membership-only repair without requesting a replacement credential", () => {
    const snapshot = completeSnapshot();
    snapshot.users[0]!.membershipRole = null;
    snapshot.users[0]!.membershipStatus = null;
    const preflight = validatePreflight(snapshot);
    expect(preflight.missingCredentials).toEqual([]);
    expect(preflight.missingMemberships.map((account) => account.username)).toEqual([
      launchAccounts[0].username,
    ]);
  });

  it("recovers an interrupted credential-pointer write without creating another credential", () => {
    const snapshot = completeSnapshot();
    snapshot.users[0]!.currentCredentialId = null;
    const preflight = validatePreflight(snapshot);
    expect(preflight.missingCredentials).toEqual([]);
    expect(preflight.credentialPointerRepairs.map((user) => user.username)).toEqual([
      launchAccounts[0].username,
    ]);
    const sql = buildBootstrapSql(
      snapshot,
      workspaceId,
      [],
      [],
      preflight.credentialPointerRepairs,
      Date.UTC(2026, 0, 1),
    );
    expect(sql.includes("current_password_credential_id IS NULL")).toBe(true);
    expect(sql.includes("INSERT OR IGNORE INTO password_credentials")).toBe(false);
  });
});

describe("fictional local/test seed", () => {
  it("builds a deterministic six-scene, cross-module fixture without plaintext test credentials", async () => {
    const credentials = await createTestSeedCredentials();
    const sql = buildTestSeedSql(credentials);
    expect((sql.match(/INSERT OR IGNORE INTO scenes /gu) ?? []).length).toBe(6);
    expect(sql.includes("Night Bus to Noord")).toBe(true);
    expect(sql.includes("INSERT OR IGNORE INTO object_registry")).toBe(true);
    expect(sql.includes("INSERT OR IGNORE INTO readiness_issues")).toBe(false);
    expect(sql.includes("INSERT OR IGNORE INTO archive_jobs")).toBe(true);
    expect(sql.includes("test-only-owner-passphrase")).toBe(false);
    expect(sql.includes("test-only-producer-passphrase")).toBe(false);
    expect(buildTestSeedSql(credentials) === sql).toBe(true);
  }, 20_000);
});
