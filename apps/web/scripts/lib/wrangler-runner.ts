import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type D1Target = "local" | "production";

const DATABASE_NAME = "sinbod-wayne-productions-db";
const scriptsDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const webDirectory = dirname(scriptsDirectory);
const wranglerConfigPath = join(webDirectory, "wrangler.jsonc");

function resolveWranglerBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

async function runWrangler(
  args: readonly string[],
  options: { captureStdout?: boolean; stdin?: Uint8Array } = {},
): Promise<{ stdout: Buffer; exitCode: number }> {
  const captureStdout = options.captureStdout === true;
  const child = spawn(process.execPath, [resolveWranglerBin(), ...args], {
    cwd: webDirectory,
    env: { ...process.env, NO_D1_WARNING: "true" },
    stdio: [
      options.stdin === undefined ? "ignore" : "pipe",
      captureStdout ? "pipe" : "ignore",
      "ignore",
    ],
    windowsHide: true,
  });
  const stdoutChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  return {
    stdout: Buffer.concat(stdoutChunks),
    exitCode,
  };
}

function targetArguments(target: D1Target, persistTo?: string): string[] {
  if (target === "production") return ["--remote"];
  return persistTo === undefined ? ["--local"] : ["--local", "--persist-to", resolve(persistTo)];
}

function parseWranglerRows(stdout: Uint8Array): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(Buffer.from(stdout).toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("Unexpected D1 response envelope.");
  for (const entry of parsed) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "results" in entry &&
      Array.isArray(entry.results)
    ) {
      return entry.results as Record<string, unknown>[];
    }
  }
  return [];
}

export async function queryD1(
  target: D1Target,
  sql: string,
  options: { persistTo?: string } = {},
): Promise<Record<string, unknown>[]> {
  const result = await runWrangler(
    [
      "d1",
      "execute",
      DATABASE_NAME,
      ...targetArguments(target, options.persistTo),
      "--config",
      wranglerConfigPath,
      "--command",
      sql,
      "--json",
    ],
    { captureStdout: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `D1 query failed (Wrangler exit ${result.exitCode}). Confirm migrations and target access.`,
    );
  }
  return parseWranglerRows(result.stdout);
}

function assertTemporaryDirectory(directory: string, prefix: string): void {
  const resolvedDirectory = resolve(directory);
  const resolvedRoot = resolve(tmpdir());
  if (
    dirname(resolvedDirectory) !== resolvedRoot ||
    !resolvedDirectory.startsWith(join(resolvedRoot, prefix))
  ) {
    throw new Error("Refusing to remove an unexpected temporary path.");
  }
}

export async function executeD1SqlFile(
  target: D1Target,
  sql: string,
  options: { persistTo?: string; temporaryPrefix?: string } = {},
): Promise<void> {
  const prefix = options.temporaryPrefix ?? "swp-d1-";
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const sqlPath = join(directory, "operation.sql");
  try {
    await writeFile(sqlPath, sql, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(sqlPath, 0o600);
    const result = await runWrangler([
      "d1",
      "execute",
      DATABASE_NAME,
      ...targetArguments(target, options.persistTo),
      "--config",
      wranglerConfigPath,
      "--file",
      sqlPath,
      "--yes",
    ]);
    if (result.exitCode !== 0) {
      // Wrangler may echo a failed SQL statement. Never forward output because this
      // file can contain password verifiers or other credential-adjacent material.
      throw new Error(
        `D1 write failed (Wrangler exit ${result.exitCode}); output was intentionally suppressed.`,
      );
    }
  } finally {
    assertTemporaryDirectory(directory, prefix);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function applyLocalMigrations(persistTo: string): Promise<void> {
  const result = await runWrangler([
    "d1",
    "migrations",
    "apply",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    resolve(persistTo),
    "--config",
    wranglerConfigPath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Local D1 migrations failed (Wrangler exit ${result.exitCode}).`);
  }
}

export async function putLocalKvObject(
  objectKey: string,
  content: Uint8Array,
  contentType: string,
  persistTo: string,
): Promise<void> {
  if (
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((part) => part === "..")
  ) {
    throw new Error("Refusing an unsafe local KV object key.");
  }
  if (content.byteLength > 25 * 1024 * 1024)
    throw new Error("Local KV fixture objects may not exceed 25 MiB.");
  const prefix = "swp-kv-object-";
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const objectPath = join(directory, "object.bin");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const metadata = JSON.stringify({
    schemaVersion: 1,
    byteSize: content.byteLength,
    contentType,
    cacheControl: "private, no-store",
    sha256,
    etag: sha256,
    uploadedAt: Date.now(),
    customMetadata: { sha256, immutable: "true", product: "sinbod-wayne-productions" },
  });
  try {
    await writeFile(objectPath, content, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(objectPath, 0o600);
    const result = await runWrangler([
      "kv",
      "key",
      "put",
      objectKey,
      "--binding",
      "FILE_OBJECTS",
      "--path",
      objectPath,
      "--metadata",
      metadata,
      "--local",
      "--persist-to",
      resolve(persistTo),
      "--config",
      wranglerConfigPath,
    ]);
    if (result.exitCode !== 0)
      throw new Error(`Local KV fixture upload failed (Wrangler exit ${result.exitCode}).`);
  } finally {
    assertTemporaryDirectory(directory, prefix);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function getLocalKvObject(objectKey: string, persistTo: string): Promise<Uint8Array> {
  if (
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((part) => part === "..")
  ) {
    throw new Error("Refusing an unsafe local KV object key.");
  }
  const result = await runWrangler(
    [
      "kv",
      "key",
      "get",
      objectKey,
      "--binding",
      "FILE_OBJECTS",
      "--local",
      "--persist-to",
      resolve(persistTo),
      "--config",
      wranglerConfigPath,
    ],
    { captureStdout: true },
  );
  if (result.exitCode !== 0)
    throw new Error(`Local KV fixture verification failed (Wrangler exit ${result.exitCode}).`);
  return result.stdout;
}

export async function assertRemoteDatabaseConfigured(): Promise<void> {
  const config = await readFile(wranglerConfigPath, "utf8");
  const id = /"database_id"\s*:\s*"([^"]+)"/u.exec(config)?.[1];
  if (id === undefined || id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Production D1 is not configured; refusing the production action.");
  }
  const kvId = /"kv_namespaces"[\s\S]*?"id"\s*:\s*"([^"]+)"/u.exec(config)?.[1];
  if (kvId === undefined || kvId === "00000000000000000000000000000000") {
    throw new Error(
      "Production Workers KV storage is not configured; refusing the production action.",
    );
  }
}

export const d1DatabaseName = DATABASE_NAME;
