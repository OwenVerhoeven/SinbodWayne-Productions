import { assertRemoteDatabaseConfigured } from "./lib/wrangler-runner";

try {
  await assertRemoteDatabaseConfigured();
  process.stdout.write(
    "Deployment preflight passed: dedicated D1 and Workers KV IDs are configured.\n",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Deployment configuration is invalid.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
