import { createUuidV7 } from "@swp/domain";

import { randomToken, safeEqual, sha256 } from "../src/server/auth/crypto";
import { bootstrapInspectionSql, parseBootstrapSnapshot } from "./lib/bootstrap";
import {
  buildOwnerRecoverySql,
  createOwnerRecovery,
  requireRecoverableOwner,
} from "./lib/owner-recovery";
import { readHiddenLine, readVisibleLine } from "./lib/interactive";
import { sqlInteger, sqlText } from "./lib/sql";
import {
  assertRemoteDatabaseConfigured,
  d1DatabaseName,
  executeD1SqlFile,
  queryD1,
  type D1Target,
} from "./lib/wrangler-runner";

function parseTarget(args: readonly string[]): D1Target {
  if (
    args.length !== 2 ||
    args[0] !== "--target" ||
    (args[1] !== "local" && args[1] !== "production")
  ) {
    throw new Error(
      "Usage: recover-owner.ts --target local|production. Password arguments and environment variables are not accepted.",
    );
  }
  return args[1];
}

async function inspect(target: D1Target) {
  return parseBootstrapSnapshot((await queryD1(target, bootstrapInspectionSql))[0]);
}

async function recoverProductionOwner(
  owner: ReturnType<typeof requireRecoverableOwner>,
  password: string,
): Promise<void> {
  const operationId = createUuidV7();
  const challenge = randomToken();
  const challengeDigest = await sha256(challenge);
  const createdAt = Date.now();
  const expiresAt = createdAt + 5 * 60_000;
  await executeD1SqlFile(
    "production",
    `PRAGMA foreign_keys = ON;\nINSERT INTO bootstrap_operations (id, workspace_id, challenge_digest, state, expires_at, created_at) VALUES (${sqlText(
      operationId,
    )}, ${sqlText(owner.workspaceId)}, ${sqlText(
      challengeDigest,
    )}, 'created', ${sqlInteger(expiresAt)}, ${sqlInteger(createdAt)});\n`,
    { temporaryPrefix: "swp-owner-recovery-challenge-" },
  );

  let response: Response;
  try {
    response = await fetch("https://productions.sinbodwayne.nl/api/v1/auth/owner-recovery", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://productions.sinbodwayne.nl",
        "User-Agent": "Sinbod-Wayne-owner-recovery",
      },
      body: JSON.stringify({ challenge, password }),
    });
  } catch {
    await failProductionOperation(operationId);
    throw new Error("The production recovery endpoint could not be reached.");
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => undefined)) as
      { error?: { code?: unknown } } | undefined;
    await failProductionOperation(operationId);
    throw new Error(
      `Production owner recovery failed (${response.status}/${String(
        failure?.error?.code ?? "unknown",
      )}).`,
    );
  }
}

async function failProductionOperation(operationId: string): Promise<void> {
  await executeD1SqlFile(
    "production",
    `UPDATE bootstrap_operations SET state = 'failed' WHERE id = ${sqlText(
      operationId,
    )} AND state = 'created';\n`,
    { temporaryPrefix: "swp-owner-recovery-failure-" },
  );
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  if (target === "production") {
    await assertRemoteDatabaseConfigured();
    const databaseConfirmation = await readVisibleLine(
      `Type ${d1DatabaseName} to confirm the production D1 target: `,
    );
    if (databaseConfirmation !== d1DatabaseName) {
      throw new Error("Production target confirmation did not match; no changes were made.");
    }
  }

  const snapshot = await inspect(target);
  const owner = requireRecoverableOwner(snapshot);
  const ownerConfirmation = await readVisibleLine(
    `Type ${owner.username} to confirm owner credential recovery: `,
  );
  if (ownerConfirmation !== owner.username) {
    throw new Error("Owner confirmation did not match; no changes were made.");
  }

  const password = await readHiddenLine(`New password for ${owner.username}: `);
  const confirmation = await readHiddenLine(`Repeat new password for ${owner.username}: `);
  if (!(await safeEqual(password, confirmation))) {
    throw new Error("Password confirmation failed; no changes were made.");
  }

  const previousCredentialId = owner.currentCredentialId;
  if (target === "production") {
    await recoverProductionOwner(owner, password);
  } else {
    const now = Date.now();
    const provision = await createOwnerRecovery(snapshot, password, now);
    await executeD1SqlFile(target, buildOwnerRecoverySql(snapshot, provision, now), {
      temporaryPrefix: "swp-owner-recovery-",
    });
  }

  const verified = await inspect(target);
  const recoveredOwner = requireRecoverableOwner(verified);
  if (recoveredOwner.currentCredentialId === previousCredentialId) {
    throw new Error("Owner recovery verification failed.");
  }
  process.stdout.write(
    `Owner credential recovery complete for ${owner.username}; prior sessions were revoked.\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Owner recovery failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
