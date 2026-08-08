import { randomBytes } from "node:crypto";

import { uuidV7From } from "@swp/domain";

import { encodePassword } from "../../src/server/auth/crypto";
import {
  launchAccounts,
  validateBootstrapPassword,
  verifyCompletedBootstrap,
  type BootstrapSnapshot,
  type BootstrapUserRow,
} from "./bootstrap";
import { sqlInteger, sqlJson, sqlText } from "./sql";

export interface OwnerRecoveryProvision {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly username: string;
  readonly previousCredentialId: string;
  readonly credentialId: string;
  readonly guardId: string;
  readonly auditId: string;
  readonly encodedHash: string;
  readonly kdf: string;
  readonly parameters: string;
}

function generatedId(now: number): string {
  return uuidV7From(now, randomBytes(10));
}

export function requireRecoverableOwner(snapshot: BootstrapSnapshot): BootstrapUserRow {
  verifyCompletedBootstrap(snapshot);
  const approvedOwner = launchAccounts.find((account) => account.role === "workspace_owner");
  const owner = snapshot.users.find((user) => user.username === approvedOwner?.username);
  if (
    approvedOwner === undefined ||
    owner === undefined ||
    owner.role !== "workspace_owner" ||
    owner.currentCredentialId === null ||
    !owner.currentCredentialIsActive
  ) {
    throw new Error("The approved workspace owner is not in a recoverable credential state.");
  }
  return owner;
}

export async function createOwnerRecovery(
  snapshot: BootstrapSnapshot,
  password: string,
  now: number,
): Promise<OwnerRecoveryProvision> {
  const owner = requireRecoverableOwner(snapshot);
  validateBootstrapPassword(password);
  const encoded = await encodePassword(password);
  return {
    ownerId: owner.id,
    workspaceId: owner.workspaceId,
    username: owner.username,
    previousCredentialId: owner.currentCredentialId!,
    credentialId: generatedId(now),
    guardId: generatedId(now + 1),
    auditId: generatedId(now + 2),
    ...encoded,
  };
}

export function buildOwnerRecoverySql(
  snapshot: BootstrapSnapshot,
  provision: OwnerRecoveryProvision,
  now: number,
): string {
  const owner = requireRecoverableOwner(snapshot);
  if (
    owner.id !== provision.ownerId ||
    owner.workspaceId !== provision.workspaceId ||
    owner.username !== provision.username ||
    owner.currentCredentialId !== provision.previousCredentialId
  ) {
    throw new Error("Owner recovery provision does not match the inspected account state.");
  }

  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT INTO optimistic_mutation_guards (id, expected_version, actual_version, created_at)
     SELECT ${sqlText(provision.guardId)}, 1,
       CASE WHEN EXISTS (
         SELECT 1
           FROM user_identities u
           JOIN password_credentials pc
             ON pc.id = u.current_password_credential_id
            AND pc.user_id = u.id
            AND pc.superseded_at IS NULL
          WHERE u.id = ${sqlText(provision.ownerId)}
            AND u.workspace_id = ${sqlText(provision.workspaceId)}
            AND u.username = ${sqlText(provision.username)} COLLATE BINARY
            AND u.role = 'workspace_owner'
            AND u.status = 'active'
            AND u.archived_at IS NULL
            AND u.current_password_credential_id = ${sqlText(provision.previousCredentialId)}
       ) THEN 1 ELSE 0 END,
       ${sqlInteger(now)};`,
    `UPDATE password_credentials
        SET superseded_at = ${sqlInteger(now)}
      WHERE id = ${sqlText(provision.previousCredentialId)}
        AND workspace_id = ${sqlText(provision.workspaceId)}
        AND user_id = ${sqlText(provision.ownerId)}
        AND superseded_at IS NULL;`,
    `INSERT INTO password_credentials
      (id, workspace_id, user_id, kdf, parameters_json, encoded_hash, created_at)
     VALUES
      (${sqlText(provision.credentialId)}, ${sqlText(provision.workspaceId)}, ${sqlText(
        provision.ownerId,
      )}, ${sqlText(provision.kdf)}, ${sqlText(provision.parameters)}, ${sqlText(
        provision.encodedHash,
      )}, ${sqlInteger(now)});`,
    `UPDATE user_identities
        SET current_password_credential_id = ${sqlText(provision.credentialId)},
            auth_epoch = auth_epoch + 1,
            failed_login_count = 0,
            backoff_until = NULL,
            updated_at = ${sqlInteger(now)},
            version = version + 1
      WHERE id = ${sqlText(provision.ownerId)}
        AND workspace_id = ${sqlText(provision.workspaceId)}
        AND current_password_credential_id = ${sqlText(provision.previousCredentialId)}
        AND status = 'active'
        AND archived_at IS NULL;`,
    `UPDATE sessions
        SET revoked_at = ${sqlInteger(now)},
            revoke_reason = COALESCE(revoke_reason, 'owner_credential_recovery')
      WHERE workspace_id = ${sqlText(provision.workspaceId)}
        AND user_id = ${sqlText(provision.ownerId)}
        AND revoked_at IS NULL;`,
    `INSERT INTO audit_events
      (id, workspace_id, actor_type, action, object_type, object_id, metadata_json, created_at)
     VALUES
      (${sqlText(provision.auditId)}, ${sqlText(
        provision.workspaceId,
      )}, 'system', 'auth.owner_credential_recovered', 'user_identity', ${sqlText(
        provision.ownerId,
      )}, ${sqlJson({ username: provision.username, sessionsRevoked: true })}, ${sqlInteger(now)});`,
    `DELETE FROM optimistic_mutation_guards WHERE id = ${sqlText(provision.guardId)};`,
  ];

  return `${statements.map((statement) => statement.replace(/\s+/gu, " ").trim()).join("\n")}\n`;
}
