import { createHash, randomBytes } from "node:crypto";

import { uuidV7From } from "@swp/domain";

import { encodePassword } from "../../src/server/auth/crypto";
import { insertOrIgnore, sqlInteger, sqlJson, sqlText } from "./sql";

export type LaunchRole = "workspace_owner" | "producer";

export interface LaunchAccount {
  readonly username: string;
  readonly displayName: string;
  readonly role: LaunchRole;
}

export const launchAccounts = [
  { username: "SinbodWayne", displayName: "Sinbod Wayne", role: "workspace_owner" },
  { username: "KyanWayne", displayName: "Kyan Wayne", role: "producer" },
] as const satisfies readonly LaunchAccount[];

export interface BootstrapWorkspaceRow {
  id: string;
  name: string;
  companyName: string;
  archived: boolean;
}

export interface BootstrapUserRow {
  id: string;
  workspaceId: string;
  username: string;
  displayName: string;
  role: LaunchRole;
  status: string;
  archived: boolean;
  currentCredentialId: string | null;
  activeCredentialCount: number;
  soleActiveCredentialId: string | null;
  currentCredentialIsActive: boolean;
  membershipRole: string | null;
  membershipStatus: string | null;
}

export interface BootstrapSnapshot {
  workspaces: BootstrapWorkspaceRow[];
  users: BootstrapUserRow[];
}

export interface BootstrapPreflight {
  workspaceId: string;
  missingCredentials: readonly LaunchAccount[];
  missingMemberships: readonly LaunchAccount[];
  credentialPointerRepairs: readonly BootstrapUserRow[];
}

export interface ProvisionAccount extends LaunchAccount {
  id: string;
  credentialId: string;
  membershipId: string;
  encodedHash: string;
  kdf: string;
  parameters: string;
  isNewIdentity: boolean;
  needsMembership: boolean;
}

const encoder = new TextEncoder();

function generatedId(now: number): string {
  return uuidV7From(now, randomBytes(10));
}

export function validateBootstrapPassword(password: string): void {
  const bytes = encoder.encode(password).byteLength;
  if (bytes === 0 || bytes > 1024) throw new Error("Bootstrap password input is invalid.");
}

export function parseBootstrapSnapshot(
  row: Record<string, unknown> | undefined,
): BootstrapSnapshot {
  if (row === undefined || typeof row.snapshot !== "string")
    throw new Error("Bootstrap inspection returned no snapshot.");
  const parsed: unknown = JSON.parse(row.snapshot);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("workspaces" in parsed) ||
    !("users" in parsed)
  ) {
    throw new Error("Bootstrap inspection returned an invalid snapshot.");
  }
  const raw = parsed as { workspaces: unknown; users: unknown };
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.users))
    throw new Error("Bootstrap inspection returned invalid rows.");
  return {
    workspaces: raw.workspaces.map((item) => {
      if (typeof item !== "object" || item === null)
        throw new Error("Invalid workspace inspection row.");
      const rowItem = item as Record<string, unknown>;
      return {
        id: String(rowItem.id),
        name: String(rowItem.name),
        companyName: String(rowItem.companyName),
        archived: Boolean(rowItem.archived),
      };
    }),
    users: raw.users.map((item) => {
      if (typeof item !== "object" || item === null)
        throw new Error("Invalid account inspection row.");
      const rowItem = item as Record<string, unknown>;
      const role = String(rowItem.role);
      if (role !== "workspace_owner" && role !== "producer")
        throw new Error("Invalid account role in bootstrap inspection.");
      return {
        id: String(rowItem.id),
        workspaceId: String(rowItem.workspaceId),
        username: String(rowItem.username),
        displayName: String(rowItem.displayName),
        role,
        status: String(rowItem.status),
        archived: Boolean(rowItem.archived),
        currentCredentialId:
          rowItem.currentCredentialId === null ? null : String(rowItem.currentCredentialId),
        activeCredentialCount: Number(rowItem.activeCredentialCount),
        soleActiveCredentialId:
          rowItem.soleActiveCredentialId === null ? null : String(rowItem.soleActiveCredentialId),
        currentCredentialIsActive: Boolean(rowItem.currentCredentialIsActive),
        membershipRole: rowItem.membershipRole === null ? null : String(rowItem.membershipRole),
        membershipStatus:
          rowItem.membershipStatus === null ? null : String(rowItem.membershipStatus),
      };
    }),
  };
}

export const bootstrapInspectionSql = `
SELECT json_object(
  'workspaces', COALESCE((
    SELECT json_group_array(json_object(
      'id', id,
      'name', name,
      'companyName', company_name,
      'archived', archived_at IS NOT NULL
    )) FROM workspaces
  ), json('[]')),
  'users', COALESCE((
    SELECT json_group_array(json_object(
      'id', u.id,
      'workspaceId', u.workspace_id,
      'username', u.username,
      'displayName', u.display_name,
      'role', u.role,
      'status', u.status,
      'archived', u.archived_at IS NOT NULL,
      'currentCredentialId', u.current_password_credential_id,
      'activeCredentialCount', (SELECT COUNT(*) FROM password_credentials pc WHERE pc.user_id = u.id AND pc.superseded_at IS NULL),
      'soleActiveCredentialId', (SELECT pc.id FROM password_credentials pc WHERE pc.user_id = u.id AND pc.superseded_at IS NULL ORDER BY pc.created_at DESC LIMIT 1),
      'currentCredentialIsActive', EXISTS(SELECT 1 FROM password_credentials pc WHERE pc.id = u.current_password_credential_id AND pc.user_id = u.id AND pc.superseded_at IS NULL),
      'membershipRole', wm.role,
      'membershipStatus', wm.status
    ))
    FROM user_identities u
    LEFT JOIN workspace_memberships wm ON wm.workspace_id = u.workspace_id AND wm.user_id = u.id AND wm.archived_at IS NULL
  ), json('[]'))
) AS snapshot;
`;

export function validatePreflight(snapshot: BootstrapSnapshot): BootstrapPreflight {
  if (snapshot.workspaces.length > 1)
    throw new Error("Bootstrap requires exactly one workspace target.");
  const workspace = snapshot.workspaces[0];
  if (
    workspace !== undefined &&
    (workspace.archived ||
      workspace.name !== "Sinbod Wayne" ||
      workspace.companyName !== "Sinbod Wayne")
  ) {
    throw new Error("The existing workspace does not match the approved bootstrap manifest.");
  }
  const expected = new Map<string, LaunchAccount>(
    launchAccounts.map((account) => [account.username, account]),
  );
  if (snapshot.users.some((user) => !expected.has(user.username))) {
    throw new Error("Unexpected identity present; bootstrap will not alter or hide it.");
  }
  for (const user of snapshot.users) {
    const account = expected.get(user.username)!;
    if (
      user.workspaceId !== workspace?.id ||
      user.displayName !== account.displayName ||
      user.role !== account.role ||
      user.status !== "active" ||
      user.archived
    ) {
      throw new Error(
        `Existing identity ${account.username} does not match the approved manifest.`,
      );
    }
    if (
      user.currentCredentialId !== null &&
      (user.activeCredentialCount !== 1 || !user.currentCredentialIsActive)
    ) {
      throw new Error(
        `Existing identity ${account.username} has an inconsistent credential state.`,
      );
    }
    if (user.currentCredentialId === null && user.activeCredentialCount > 1) {
      throw new Error(
        `Existing identity ${account.username} has multiple unlinked credentials; refusing replacement.`,
      );
    }
    if (
      user.currentCredentialId === null &&
      user.activeCredentialCount === 1 &&
      user.soleActiveCredentialId === null
    ) {
      throw new Error(
        `Existing identity ${account.username} has an inconsistent credential state.`,
      );
    }
    if (
      user.membershipRole !== null &&
      (user.membershipRole !== account.role || user.membershipStatus !== "active")
    ) {
      throw new Error(
        `Existing identity ${account.username} has an inconsistent workspace membership.`,
      );
    }
  }
  const missingCredentials = launchAccounts.filter((account) => {
    const user = snapshot.users.find((candidate) => candidate.username === account.username);
    return (
      user === undefined || (user.currentCredentialId === null && user.activeCredentialCount === 0)
    );
  });
  const missingMemberships = launchAccounts.filter(
    (account) =>
      snapshot.users.find((user) => user.username === account.username)?.membershipRole === null,
  );
  const credentialPointerRepairs = snapshot.users.filter(
    (user) =>
      user.currentCredentialId === null &&
      user.activeCredentialCount === 1 &&
      user.soleActiveCredentialId !== null,
  );
  return {
    workspaceId: workspace?.id ?? generatedId(Date.now()),
    missingCredentials,
    missingMemberships,
    credentialPointerRepairs,
  };
}

export function verifyCompletedBootstrap(snapshot: BootstrapSnapshot): void {
  const { credentialPointerRepairs, missingCredentials, missingMemberships } =
    validatePreflight(snapshot);
  if (
    snapshot.workspaces.length !== 1 ||
    snapshot.users.length !== launchAccounts.length ||
    missingCredentials.length !== 0 ||
    missingMemberships.length !== 0 ||
    credentialPointerRepairs.length !== 0
  ) {
    throw new Error("Bootstrap verification failed: the launch account manifest is incomplete.");
  }
  for (const account of launchAccounts) {
    const user = snapshot.users.find((candidate) => candidate.username === account.username);
    if (user?.membershipRole !== account.role || user.membershipStatus !== "active") {
      throw new Error(`Bootstrap verification failed for ${account.username} membership.`);
    }
  }
}

export async function createProvisionAccount(
  account: LaunchAccount,
  password: string,
  existing: BootstrapUserRow | undefined,
  now: number,
): Promise<ProvisionAccount> {
  validateBootstrapPassword(password);
  const passwordRecord = await encodePassword(password);
  return {
    ...account,
    id: existing?.id ?? generatedId(now),
    credentialId: generatedId(now + 1),
    membershipId: generatedId(now + 2),
    ...passwordRecord,
    isNewIdentity: existing === undefined,
    needsMembership: existing?.membershipRole === null,
  };
}

export function buildBootstrapSql(
  snapshot: BootstrapSnapshot,
  workspaceId: string,
  provisions: readonly ProvisionAccount[],
  membershipRepairs: readonly LaunchAccount[],
  credentialPointerRepairs: readonly BootstrapUserRow[],
  now: number,
): string {
  const statements = ["PRAGMA foreign_keys = ON;"];
  if (snapshot.workspaces.length === 0) {
    statements.push(
      insertOrIgnore("workspaces", {
        id: sqlText(workspaceId),
        name: sqlText("Sinbod Wayne"),
        company_name: sqlText("Sinbod Wayne"),
        timezone: sqlText("Europe/Amsterdam"),
        locale: sqlText("en-GB"),
        currency: sqlText("EUR"),
        unit_system: sqlText("metric"),
        temperature_unit: sqlText("celsius"),
        paper_size: sqlText("A4"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  }
  for (const provision of provisions) {
    if (provision.isNewIdentity) {
      statements.push(
        insertOrIgnore("user_identities", {
          id: sqlText(provision.id),
          workspace_id: sqlText(workspaceId),
          username: sqlText(provision.username),
          display_name: sqlText(provision.displayName),
          role: sqlText(provision.role),
          status: sqlText("active"),
          created_at: sqlInteger(now),
          updated_at: sqlInteger(now),
        }),
      );
    }
    statements.push(
      insertOrIgnore("password_credentials", {
        id: sqlText(provision.credentialId),
        workspace_id: sqlText(workspaceId),
        user_id: sqlText(provision.id),
        kdf: sqlText(provision.kdf),
        parameters_json: sqlText(provision.parameters),
        encoded_hash: sqlText(provision.encodedHash),
        created_at: sqlInteger(now),
      }),
      `UPDATE user_identities SET current_password_credential_id = ${sqlText(
        provision.credentialId,
      )}, updated_at = ${sqlInteger(now)}, version = version + 1 WHERE id = ${sqlText(
        provision.id,
      )} AND current_password_credential_id IS NULL;`,
    );
    if (provision.isNewIdentity || provision.needsMembership) {
      statements.push(
        insertOrIgnore("workspace_memberships", {
          id: sqlText(provision.membershipId),
          workspace_id: sqlText(workspaceId),
          user_id: sqlText(provision.id),
          role: sqlText(provision.role),
          status: sqlText("active"),
          created_at: sqlInteger(now),
          updated_at: sqlInteger(now),
        }),
      );
    }
    statements.push(
      insertOrIgnore("audit_events", {
        id: sqlText(generatedId(now + 3)),
        workspace_id: sqlText(workspaceId),
        actor_type: sqlText("system"),
        action: sqlText("auth.bootstrap_account_provisioned"),
        object_type: sqlText("user_identity"),
        object_id: sqlText(provision.id),
        metadata_json: sqlJson({ username: provision.username, role: provision.role }),
        created_at: sqlInteger(now),
      }),
    );
  }
  for (const [index, account] of membershipRepairs.entries()) {
    const provision = provisions.find((candidate) => candidate.username === account.username);
    const user = snapshot.users.find((candidate) => candidate.username === account.username);
    const userId = provision?.id ?? user?.id;
    if (userId === undefined)
      throw new Error(`Cannot repair membership for missing identity ${account.username}.`);
    statements.push(
      insertOrIgnore("workspace_memberships", {
        id: sqlText(provision?.membershipId ?? generatedId(now + 200 + index)),
        workspace_id: sqlText(workspaceId),
        user_id: sqlText(userId),
        role: sqlText(account.role),
        status: sqlText("active"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  }
  for (const user of credentialPointerRepairs) {
    if (user.soleActiveCredentialId === null)
      throw new Error("Credential pointer repair is missing its target.");
    statements.push(
      `UPDATE user_identities SET current_password_credential_id = ${sqlText(
        user.soleActiveCredentialId,
      )}, updated_at = ${sqlInteger(now)}, version = version + 1 WHERE id = ${sqlText(
        user.id,
      )} AND current_password_credential_id IS NULL;`,
    );
  }
  const manifestHash = createHash("sha256").update(JSON.stringify(launchAccounts)).digest("hex");
  statements.push(
    insertOrIgnore("audit_events", {
      id: sqlText(generatedId(now + 10)),
      workspace_id: sqlText(workspaceId),
      actor_type: sqlText("system"),
      action: sqlText("auth.bootstrap_verified"),
      metadata_json: sqlJson({
        accountManifestHash: manifestHash,
        intendedActiveAccountCount: launchAccounts.length,
      }),
      created_at: sqlInteger(now),
    }),
  );
  return `${statements.join("\n")}\n`;
}
