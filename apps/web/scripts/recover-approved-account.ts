import { createUuidV7 } from "@swp/domain";

import { randomToken, safeEqual, sha256 } from "../src/server/auth/crypto";
import { bootstrapInspectionSql, parseBootstrapSnapshot } from "./lib/bootstrap";
import { requireRecoverableApprovedAccount } from "./lib/approved-account-recovery";
import { readHiddenLine, readVisibleLine } from "./lib/interactive";
import { sqlInteger, sqlText } from "./lib/sql";
import {
  assertRemoteDatabaseConfigured,
  d1DatabaseName,
  executeD1SqlFile,
  queryD1,
} from "./lib/wrangler-runner";

function parseArguments(args: readonly string[]): {
  username: "KyanWayne" | "guest";
  pipedInput: boolean;
} {
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== "--username" ||
    !["KyanWayne", "guest"].includes(args[1]!) ||
    (args.length === 3 && args[2] !== "--stdin")
  ) {
    throw new Error("Usage: recover-approved-account.ts --username KyanWayne|guest [--stdin]");
  }
  return {
    username: args[1] as "KyanWayne" | "guest",
    pipedInput: args[2] === "--stdin",
  };
}

async function readPipedInput(): Promise<readonly [string, string, string, string]> {
  if (process.stdin.isTTY)
    throw new Error("Piped recovery input expected a non-interactive stdin.");
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = String(chunk);
    bytes += Buffer.byteLength(value);
    if (bytes > 4096) throw new Error("Recovery input is too large.");
    chunks.push(value);
  }
  const values = chunks.join("").split(/\r?\n/u);
  while (values.at(-1) === "") values.pop();
  if (values.length !== 4) throw new Error("Recovery input must contain exactly four lines.");
  return values as [string, string, string, string];
}

async function inspect() {
  return parseBootstrapSnapshot((await queryD1("production", bootstrapInspectionSql))[0]);
}

async function verifyProductionLogin(username: string, password: string): Promise<void> {
  const response = await fetch("https://productions.sinbodwayne.nl/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://productions.sinbodwayne.nl" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`Production sign-in verification failed (${response.status}).`);
  const body = (await response.json()) as {
    data?: { authenticated?: boolean; csrfToken?: string };
  };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (body.data?.authenticated !== true || !body.data.csrfToken || !cookie) {
    throw new Error("Production sign-in verification failed.");
  }
  const logout = await fetch("https://productions.sinbodwayne.nl/api/v1/auth/logout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://productions.sinbodwayne.nl",
      Cookie: cookie,
      "X-CSRF-Token": body.data.csrfToken,
    },
    body: "{}",
  });
  if (!logout.ok) throw new Error("Verification session could not be revoked.");
}

async function recoverProductionAccount(
  workspaceId: string,
  username: "KyanWayne" | "guest",
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
    )}, ${sqlText(workspaceId)}, ${sqlText(challengeDigest)}, 'created', ${sqlInteger(
      expiresAt,
    )}, ${sqlInteger(createdAt)});\n`,
    { temporaryPrefix: "swp-approved-recovery-challenge-" },
  );
  const response = await fetch("https://productions.sinbodwayne.nl/api/v1/auth/approved-recovery", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://productions.sinbodwayne.nl" },
    body: JSON.stringify({ challenge, username, password }),
  });
  if (!response.ok) {
    await executeD1SqlFile(
      "production",
      `UPDATE bootstrap_operations SET state = 'failed' WHERE id = ${sqlText(
        operationId,
      )} AND state = 'created';\n`,
      { temporaryPrefix: "swp-approved-recovery-failure-" },
    );
    throw new Error(`Production account recovery failed (${response.status}).`);
  }
}

async function main(): Promise<void> {
  const { username, pipedInput } = parseArguments(process.argv.slice(2));
  await assertRemoteDatabaseConfigured();
  const piped = pipedInput ? await readPipedInput() : undefined;
  const databaseConfirmation =
    piped?.[0] ??
    (await readVisibleLine(`Type ${d1DatabaseName} to confirm the production D1 target: `));
  if (databaseConfirmation !== d1DatabaseName)
    throw new Error("Production target confirmation failed.");
  const accountConfirmation =
    piped?.[1] ?? (await readVisibleLine(`Type ${username} to confirm credential rotation: `));
  if (accountConfirmation !== username) throw new Error("Account confirmation failed.");

  const password = piped?.[2] ?? (await readHiddenLine(`New password for ${username}: `));
  const confirmation =
    piped?.[3] ?? (await readHiddenLine(`Repeat new password for ${username}: `));
  if (!(await safeEqual(password, confirmation))) throw new Error("Password confirmation failed.");

  const snapshot = await inspect();
  const before = requireRecoverableApprovedAccount(snapshot, username);
  await recoverProductionAccount(before.workspaceId, username, password);
  const after = requireRecoverableApprovedAccount(await inspect(), username);
  if (after.currentCredentialId === before.currentCredentialId) {
    throw new Error("Credential rotation verification failed.");
  }
  await verifyProductionLogin(username, password);
  process.stdout.write(`Credential rotation and production sign-in verified for ${username}.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Credential recovery failed."}\n`,
  );
  process.exitCode = 1;
});
