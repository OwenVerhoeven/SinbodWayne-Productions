import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { ArchiveAgentError } from "./errors.ts";

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function comparisonValue(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  if (relativePath === "") {
    return true;
  }
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function normalizeManifestPath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) {
    throw new ArchiveAgentError("INVALID_PATH", "Manifest destination path is empty or too long");
  }
  if (!input.isWellFormed()) {
    throw new ArchiveAgentError(
      "INVALID_PATH",
      "Manifest destination path contains invalid Unicode",
    );
  }
  if (input !== input.normalize("NFC")) {
    throw new ArchiveAgentError(
      "INVALID_PATH",
      "Manifest destination path must use NFC Unicode normalization",
    );
  }
  if (containsControlCharacter(input) || input.includes("\\")) {
    throw new ArchiveAgentError(
      "INVALID_PATH",
      "Manifest destination path contains an unsafe character",
    );
  }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input) || input.startsWith("//")) {
    throw new ArchiveAgentError("INVALID_PATH", "Manifest destination path must be relative");
  }

  const segments = input.split("/");
  if (segments.length === 0 || segments[0]?.toLocaleLowerCase("en-US") === ".swp-staging") {
    throw new ArchiveAgentError(
      "INVALID_PATH",
      "Manifest destination path uses an internal directory",
    );
  }

  for (const segment of segments) {
    if (
      !segment ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_CHARACTER.test(segment) ||
      WINDOWS_DEVICE_NAME.test(segment)
    ) {
      throw new ArchiveAgentError(
        "INVALID_PATH",
        "Manifest destination path contains an unsafe segment",
      );
    }
  }

  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized.startsWith("../") || normalized === "..") {
    throw new ArchiveAgentError("INVALID_PATH", "Manifest destination path is not normalized");
  }
  return normalized;
}

export function validateDestinationRootSyntax(input: string): string {
  if (!input || !path.isAbsolute(input)) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "Archive destination root must be an explicit absolute path",
    );
  }
  const resolved = path.resolve(input);
  if (comparisonValue(resolved) === comparisonValue(path.parse(resolved).root)) {
    throw new ArchiveAgentError(
      "CONFIGURATION_INVALID",
      "A filesystem root cannot be used as the archive destination",
    );
  }
  return resolved;
}

export class DestinationGuard {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(destinationRoot: string): Promise<DestinationGuard> {
    const resolved = validateDestinationRootSyntax(destinationRoot);
    let stats;
    try {
      stats = await lstat(resolved);
    } catch (error) {
      throw new ArchiveAgentError(
        "CONFIGURATION_INVALID",
        "Archive destination root must already exist and be accessible",
        false,
        { cause: error },
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ArchiveAgentError(
        "CONFIGURATION_INVALID",
        "Archive destination root must be a real directory, not a symbolic link or junction",
      );
    }
    await access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    const canonical = await realpath(resolved);
    return new DestinationGuard(canonical);
  }

  resolveManifestFile(relativePath: string): { normalized: string; absolute: string } {
    const normalized = normalizeManifestPath(relativePath);
    const absolute = path.resolve(this.root, ...normalized.split("/"));
    if (
      !isWithinOrEqual(this.root, absolute) ||
      comparisonValue(absolute) === comparisonValue(this.root)
    ) {
      throw new ArchiveAgentError(
        "PATH_ESCAPE",
        "Manifest destination resolves outside the archive root",
      );
    }
    return { normalized, absolute };
  }

  async ensureManifestParent(
    relativePath: string,
  ): Promise<{ normalized: string; absolute: string }> {
    const resolved = this.resolveManifestFile(relativePath);
    const parentSegments = resolved.normalized.split("/").slice(0, -1);
    await this.ensureDirectorySegments(parentSegments);
    await this.assertExistingEntrySafe(resolved.absolute);
    return resolved;
  }

  async stagingFile(jobId: string, relativePath: string): Promise<string> {
    const normalized = normalizeManifestPath(relativePath);
    const safeJob = `job-${createHash("sha256").update(jobId, "utf8").digest("hex").slice(0, 32)}`;
    const segments = [".swp-staging", safeJob, ...normalized.split("/")];
    await this.ensureDirectorySegments(segments.slice(0, -1));
    const staging = path.resolve(this.root, ...segments);
    if (!isWithinOrEqual(this.root, staging)) {
      throw new ArchiveAgentError("PATH_ESCAPE", "Staging path resolves outside the archive root");
    }
    const partial = `${staging}.partial`;
    await this.assertExistingEntrySafe(partial);
    return partial;
  }

  async assertExistingEntrySafe(candidate: string): Promise<void> {
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new ArchiveAgentError(
          "PATH_ESCAPE",
          "Destination contains a symbolic link or junction",
        );
      }
      const canonical = await realpath(candidate);
      if (!isWithinOrEqual(this.root, canonical)) {
        throw new ArchiveAgentError("PATH_ESCAPE", "Destination resolves outside the archive root");
      }
    } catch (error) {
      if (missing(error)) {
        return;
      }
      throw error;
    }
  }

  async ensureDirectorySegments(segments: readonly string[]): Promise<string> {
    let current = this.root;
    for (const segment of segments) {
      current = path.resolve(current, segment);
      if (!isWithinOrEqual(this.root, current)) {
        throw new ArchiveAgentError(
          "PATH_ESCAPE",
          "Destination directory resolves outside the archive root",
        );
      }

      try {
        await mkdir(current);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }

      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new ArchiveAgentError(
          "PATH_ESCAPE",
          "Destination path traverses a symbolic link or non-directory",
        );
      }
      const canonical = await realpath(current);
      if (!isWithinOrEqual(this.root, canonical)) {
        throw new ArchiveAgentError(
          "PATH_ESCAPE",
          "Destination directory resolves outside the archive root",
        );
      }
    }
    return current;
  }
}
