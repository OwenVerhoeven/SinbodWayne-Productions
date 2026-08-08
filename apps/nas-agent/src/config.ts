import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { ArchiveAgentError } from "./errors.ts";
import { validateDestinationRootSyntax } from "./path-policy.ts";

export interface CredentialProvider {
  getToken(): Promise<string>;
  readonly description: "file" | "stdin";
}

export interface RuntimeConfiguration {
  readonly apiBaseUrl: URL;
  readonly destinationRoot: string;
  readonly agentId: string;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly downloadAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly minimumFreeSpaceBytes: bigint;
  readonly credentialProvider: CredentialProvider;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ArchiveAgentError("CONFIGURATION_INVALID", `${name} is outside its permitted range`);
  }
  return parsed;
}

function validateToken(value: string): string {
  const token = value.trim();
  if (
    token.length < 16 ||
    token.length > 16_384 ||
    !/^[A-Za-z0-9._~+/=-]+$/.test(token) ||
    token.includes("\r") ||
    token.includes("\n") ||
    token.includes("\0")
  ) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Service credential is missing or malformed",
    );
  }
  return token;
}

export class FileCredentialProvider implements CredentialProvider {
  readonly description = "file" as const;
  readonly filename: string;

  constructor(filename: string) {
    if (!filename || !path.isAbsolute(filename)) {
      throw new ArchiveAgentError(
        "CONFIGURATION_INVALID",
        "Service credential file must use an absolute path",
      );
    }
    this.filename = path.resolve(filename);
  }

  async getToken(): Promise<string> {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let handle;
    try {
      handle = await open(this.filename, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      throw new ArchiveAgentError(
        "CONFIGURATION_INVALID",
        "Service credential file cannot be opened safely",
        false,
        { cause: error },
      );
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new ArchiveAgentError(
          "CONFIGURATION_INVALID",
          "Service credential file must be a regular file",
        );
      }
      if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
        throw new ArchiveAgentError(
          "CONFIGURATION_INVALID",
          "Service credential file permissions are too broad",
        );
      }
      if (stats.size > 16_384) {
        throw new ArchiveAgentError(
          "CONFIGURATION_INVALID",
          "Service credential file is too large",
        );
      }
      return validateToken(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
}

export class StaticCredentialProvider implements CredentialProvider {
  readonly description = "stdin" as const;
  readonly #token: string;

  constructor(token: string) {
    this.#token = validateToken(token);
  }

  async getToken(): Promise<string> {
    return this.#token;
  }
}

export async function readCredentialFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Interactive credential echo is disabled; pipe the credential through stdin or use a credential file",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += bytes.byteLength;
    if (total > 16_384) {
      throw new ArchiveAgentError("CONFIGURATION_INVALID", "Service credential input is too large");
    }
    chunks.push(bytes);
  }
  return validateToken(Buffer.concat(chunks).toString("utf8"));
}

export async function loadConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  stdinReader: () => Promise<string> = readCredentialFromStdin,
): Promise<RuntimeConfiguration> {
  const apiText = environment.SWP_ARCHIVE_API_URL;
  if (!apiText) {
    throw new ArchiveAgentError("CONFIGURATION_INVALID", "SWP_ARCHIVE_API_URL is required");
  }
  let apiBaseUrl: URL;
  try {
    apiBaseUrl = new URL(apiText);
  } catch (error) {
    throw new ArchiveAgentError("CONFIGURATION_INVALID", "SWP_ARCHIVE_API_URL is invalid", false, {
      cause: error,
    });
  }
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(apiBaseUrl.hostname);
  const insecureLocalAllowed = environment.SWP_ARCHIVE_ALLOW_INSECURE_LOCALHOST === "true";
  if (
    apiBaseUrl.protocol !== "https:" &&
    !(apiBaseUrl.protocol === "http:" && isLocalhost && insecureLocalAllowed)
  ) {
    throw new ArchiveAgentError("CONFIGURATION_INVALID", "Archive service URL must use HTTPS");
  }
  if (apiBaseUrl.username || apiBaseUrl.password || apiBaseUrl.search || apiBaseUrl.hash) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Archive service URL cannot contain credentials, query, or fragment",
    );
  }

  const destination = environment.SWP_ARCHIVE_DESTINATION_ROOT;
  if (!destination) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "SWP_ARCHIVE_DESTINATION_ROOT is required",
    );
  }
  const destinationRoot = validateDestinationRootSyntax(destination);

  const agentId = environment.SWP_ARCHIVE_AGENT_ID;
  if (!agentId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(agentId)) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "SWP_ARCHIVE_AGENT_ID is missing or malformed",
    );
  }

  const tokenFile = environment.SWP_ARCHIVE_TOKEN_FILE;
  const tokenFromStdin = environment.SWP_ARCHIVE_TOKEN_STDIN === "true";
  if (Boolean(tokenFile) === tokenFromStdin) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Configure exactly one credential source: SWP_ARCHIVE_TOKEN_FILE or SWP_ARCHIVE_TOKEN_STDIN=true",
    );
  }
  const credentialProvider = tokenFile
    ? new FileCredentialProvider(tokenFile)
    : new StaticCredentialProvider(await stdinReader());

  const leaseDurationMs = parseInteger(
    environment.SWP_ARCHIVE_LEASE_MS,
    120_000,
    "SWP_ARCHIVE_LEASE_MS",
    30_000,
    900_000,
  );
  const heartbeatIntervalMs = parseInteger(
    environment.SWP_ARCHIVE_HEARTBEAT_MS,
    30_000,
    "SWP_ARCHIVE_HEARTBEAT_MS",
    5_000,
    300_000,
  );
  if (heartbeatIntervalMs * 2 >= leaseDurationMs) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Heartbeat interval must be less than half the lease duration",
    );
  }

  return {
    apiBaseUrl,
    destinationRoot,
    agentId,
    pollIntervalMs: parseInteger(
      environment.SWP_ARCHIVE_POLL_MS,
      15_000,
      "SWP_ARCHIVE_POLL_MS",
      1_000,
      300_000,
    ),
    leaseDurationMs,
    heartbeatIntervalMs,
    downloadAttempts: parseInteger(
      environment.SWP_ARCHIVE_DOWNLOAD_ATTEMPTS,
      4,
      "SWP_ARCHIVE_DOWNLOAD_ATTEMPTS",
      1,
      10,
    ),
    retryBaseDelayMs: parseInteger(
      environment.SWP_ARCHIVE_RETRY_BASE_MS,
      500,
      "SWP_ARCHIVE_RETRY_BASE_MS",
      10,
      30_000,
    ),
    minimumFreeSpaceBytes: BigInt(
      parseInteger(
        environment.SWP_ARCHIVE_FREE_SPACE_RESERVE_BYTES,
        64 * 1024 * 1024,
        "SWP_ARCHIVE_FREE_SPACE_RESERVE_BYTES",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    ),
    credentialProvider,
  };
}
