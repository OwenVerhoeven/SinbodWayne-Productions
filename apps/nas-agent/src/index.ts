#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { ArchiveAgent } from "./archive-agent.ts";
import { loadConfiguration } from "./config.ts";
import { asArchiveAgentError } from "./errors.ts";
import { JsonLineLogger } from "./logger.ts";
import { HttpArchiveServiceClient } from "./service-client.ts";

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const complete = (): void => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function main(): Promise<void> {
  const logger = new JsonLineLogger();
  let configuration;
  try {
    configuration = await loadConfiguration();
  } catch (error) {
    const failure = asArchiveAgentError(error);
    logger.error("archive_agent_configuration_failed", { code: failure.code });
    process.exitCode = 2;
    return;
  }

  const shutdown = new AbortController();
  const requestShutdown = (): void => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  const client = new HttpArchiveServiceClient(
    configuration.apiBaseUrl,
    configuration.credentialProvider,
  );
  const agent = new ArchiveAgent(
    client,
    {
      agentId: configuration.agentId,
      destinationRoot: configuration.destinationRoot,
      leaseDurationMs: configuration.leaseDurationMs,
      heartbeatIntervalMs: configuration.heartbeatIntervalMs,
      downloadAttempts: configuration.downloadAttempts,
      retryBaseDelayMs: configuration.retryBaseDelayMs,
      minimumFreeSpaceBytes: configuration.minimumFreeSpaceBytes,
    },
    { logger },
  );

  logger.info("archive_agent_started", {
    agentId: configuration.agentId,
    credentialSource: configuration.credentialProvider.description,
  });

  while (!shutdown.signal.aborted) {
    try {
      const result = await agent.runOnce(shutdown.signal);
      if (result.kind === "idle") {
        await wait(configuration.pollIntervalMs, shutdown.signal);
      }
    } catch (error) {
      if (shutdown.signal.aborted) break;
      const failure = asArchiveAgentError(error);
      logger.error("archive_agent_poll_failed", {
        code: failure.code,
        retryable: failure.retryable,
      });
      await wait(configuration.pollIntervalMs, shutdown.signal);
    }
  }
  logger.info("archive_agent_stopped");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  await main();
}

export { ArchiveAgent } from "./archive-agent.ts";
export { FileCredentialProvider, loadConfiguration, StaticCredentialProvider } from "./config.ts";
export { HttpArchiveServiceClient } from "./service-client.ts";
export { DestinationGuard, normalizeManifestPath } from "./path-policy.ts";
export { canonicalManifestJson, manifestDigest, validateManifest } from "./manifest.ts";
export type * from "./types.ts";
