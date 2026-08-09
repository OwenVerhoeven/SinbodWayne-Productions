import { safeEqual } from "../src/server/auth/crypto";
import {
  bootstrapInspectionSql,
  buildBootstrapSql,
  createProvisionAccount,
  parseBootstrapSnapshot,
  validatePreflight,
  verifyCompletedBootstrap,
} from "./lib/bootstrap";
import { readHiddenLine, readVisibleLine } from "./lib/interactive";
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
      "Usage: bootstrap.ts --target local|production. Password arguments and environment variables are not accepted.",
    );
  }
  return args[1];
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  if (target === "production") {
    await assertRemoteDatabaseConfigured();
    const confirmation = await readVisibleLine(
      `Type ${d1DatabaseName} to confirm the production D1 target: `,
    );
    if (confirmation !== d1DatabaseName)
      throw new Error("Production target confirmation did not match; no changes were made.");
  }

  const snapshot = parseBootstrapSnapshot((await queryD1(target, bootstrapInspectionSql))[0]);
  const { workspaceId, missingCredentials, missingMemberships, credentialPointerRepairs } =
    validatePreflight(snapshot);
  if (
    missingCredentials.length === 0 &&
    missingMemberships.length === 0 &&
    credentialPointerRepairs.length === 0
  ) {
    verifyCompletedBootstrap(snapshot);
    process.stdout.write(
      "Bootstrap already complete: the approved three-account manifest is valid.\n",
    );
    return;
  }

  const now = Date.now();
  const projectIds = (await queryD1(target, "SELECT id FROM projects ORDER BY id;")).map((row) =>
    String(row.id),
  );
  const provisions = [];
  for (const [index, account] of missingCredentials.entries()) {
    const password = await readHiddenLine(`Initial password for ${account.username}: `);
    const confirmation = await readHiddenLine(`Repeat password for ${account.username}: `);
    if (!(await safeEqual(password, confirmation)))
      throw new Error(`Password confirmation failed for ${account.username}.`);
    const existing = snapshot.users.find((user) => user.username === account.username);
    provisions.push(await createProvisionAccount(account, password, existing, now + index * 20));
  }

  await executeD1SqlFile(
    target,
    buildBootstrapSql(
      snapshot,
      workspaceId,
      provisions,
      missingMemberships,
      credentialPointerRepairs,
      now,
      projectIds,
    ),
    {
      temporaryPrefix: "swp-bootstrap-",
    },
  );
  const verified = parseBootstrapSnapshot((await queryD1(target, bootstrapInspectionSql))[0]);
  verifyCompletedBootstrap(verified);
  process.stdout.write(
    "Bootstrap complete: exactly the approved three active accounts were verified.\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Bootstrap failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
