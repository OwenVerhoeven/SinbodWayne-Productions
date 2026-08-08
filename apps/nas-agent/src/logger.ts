import type { AgentLogger } from "./types.ts";

const SECRET_KEY_PATTERN = /(authorization|credential|password|secret|signed.?url|token)/i;
const URL_QUERY_PATTERN = /(https?:\/\/[^\s?]+)\?[^\s]*/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function sanitizeString(value: string): string {
  return value
    .replace(URL_QUERY_PATTERN, "$1?[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]");
}

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry));
  }

  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      safe[childKey] = sanitize(childValue, childKey);
    }
    return safe;
  }

  return value;
}

export class JsonLineLogger implements AgentLogger {
  readonly writeLine: (line: string) => void;

  constructor(writeLine: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.writeLine = writeLine;
  }

  debug(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.write("error", event, fields);
  }

  write(level: string, event: string, fields: Readonly<Record<string, unknown>>): void {
    const safeFields = sanitize(fields) as Record<string, unknown>;
    this.writeLine(
      JSON.stringify({
        ...safeFields,
        timestamp: new Date().toISOString(),
        level,
        event,
      }),
    );
  }
}

export class NullLogger implements AgentLogger {
  debug(): void {
    return;
  }
  info(): void {
    return;
  }
  warn(): void {
    return;
  }
  error(): void {
    return;
  }
}

export const redactionInternals = { sanitize };
