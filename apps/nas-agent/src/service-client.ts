import { ArchiveAgentError } from "./errors.ts";
import type { CredentialProvider } from "./config.ts";
import type {
  ArchiveLease,
  ArchiveManifestItem,
  ArchiveServiceClient,
  DownloadResponse,
  ItemAcknowledgement,
  JobFailure,
  ManifestAcknowledgement,
} from "./types.ts";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly requestId?: string;
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    value.ok === true &&
    "data" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManifestItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.relativePath === "string" &&
    typeof value.byteSize === "number" &&
    typeof value.mimeType === "string" &&
    typeof value.sha256 === "string" &&
    (value.logicalFileId === undefined || typeof value.logicalFileId === "string") &&
    (value.fileVersionId === undefined || typeof value.fileVersionId === "string") &&
    (value.sourceRevisionIds === undefined ||
      (Array.isArray(value.sourceRevisionIds) &&
        value.sourceRevisionIds.every((identity) => typeof identity === "string")))
  );
}

function isArchiveLease(value: unknown): value is ArchiveLease {
  if (!isRecord(value) || !isRecord(value.manifest)) return false;
  return (
    typeof value.jobId === "string" &&
    typeof value.leaseToken === "string" &&
    typeof value.leaseExpiresAt === "string" &&
    typeof value.manifest.schemaVersion === "string" &&
    typeof value.manifest.projectId === "string" &&
    typeof value.manifest.exportSnapshotId === "string" &&
    typeof value.manifest.manifestHash === "string" &&
    Array.isArray(value.manifest.items) &&
    value.manifest.items.every(isManifestItem)
  );
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class HttpArchiveServiceClient implements ArchiveServiceClient {
  readonly apiBaseUrl: URL;
  readonly credentials: CredentialProvider;
  readonly fetchImplementation: FetchImplementation;

  constructor(
    apiBaseUrl: URL,
    credentials: CredentialProvider,
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.apiBaseUrl = apiBaseUrl;
    this.credentials = credentials;
    this.fetchImplementation = fetchImplementation;
  }

  async leaseNextJob(
    agentId: string,
    leaseDurationMs: number,
    signal?: AbortSignal,
  ): Promise<ArchiveLease | null> {
    const value = await this.requestJson<unknown>(
      "/api/v1/service/archive/jobs/lease",
      {
        method: "POST",
        body: JSON.stringify({ agentId, leaseDurationMs }),
      },
      signal,
    );
    if (value === null) return null;
    if (!isArchiveLease(value)) {
      throw new ArchiveAgentError(
        "INVALID_MANIFEST",
        "Archive service returned an invalid lease payload",
      );
    }
    return value;
  }

  async heartbeat(lease: ArchiveLease, signal?: AbortSignal): Promise<void> {
    await this.requestJson<unknown>(
      `/api/v1/service/archive/jobs/${encodeURIComponent(lease.jobId)}/heartbeat`,
      {
        method: "POST",
        headers: { "X-Archive-Lease": lease.leaseToken },
        body: JSON.stringify({ manifestHash: lease.manifest.manifestHash }),
      },
      signal,
    );
  }

  async downloadItem(
    lease: ArchiveLease,
    item: ArchiveManifestItem,
    offset: number,
    signal?: AbortSignal,
  ): Promise<DownloadResponse> {
    const headers = await this.headers({
      "X-Archive-Lease": lease.leaseToken,
      ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
    });
    const response = await this.fetchImplementation(
      new URL(
        `/api/v1/service/archive/jobs/${encodeURIComponent(lease.jobId)}/items/${encodeURIComponent(item.id)}/content`,
        this.apiBaseUrl,
      ),
      {
        method: "GET",
        headers,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      },
    );

    const contentLengthText = response.headers.get("content-length");
    const parsedLength = contentLengthText === null ? undefined : Number(contentLengthText);
    const contentLength =
      Number.isSafeInteger(parsedLength) && (parsedLength ?? -1) >= 0 ? parsedLength : undefined;
    const contentRange = response.headers.get("content-range");
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: response.status,
        ...(contentLength === undefined ? {} : { contentLength }),
        ...(contentRange === null ? {} : { contentRange }),
        body: null,
      };
    }
    return {
      status: response.status,
      ...(contentLength === undefined ? {} : { contentLength }),
      ...(contentRange === null ? {} : { contentRange }),
      body: response.body === null ? null : responseChunks(response.body),
    };
  }

  async acknowledgeItem(
    lease: ArchiveLease,
    item: ArchiveManifestItem,
    acknowledgement: ItemAcknowledgement,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>(
      `/api/v1/service/archive/jobs/${encodeURIComponent(lease.jobId)}/items/${encodeURIComponent(item.id)}/acknowledgements`,
      {
        method: "POST",
        headers: {
          "X-Archive-Lease": lease.leaseToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(acknowledgement),
      },
      signal,
    );
  }

  async acknowledgeManifest(
    lease: ArchiveLease,
    acknowledgement: ManifestAcknowledgement,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>(
      `/api/v1/service/archive/jobs/${encodeURIComponent(lease.jobId)}/acknowledgements`,
      {
        method: "POST",
        headers: {
          "X-Archive-Lease": lease.leaseToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(acknowledgement),
      },
      signal,
    );
  }

  async failJob(
    lease: ArchiveLease,
    failure: JobFailure,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>(
      `/api/v1/service/archive/jobs/${encodeURIComponent(lease.jobId)}/failures`,
      {
        method: "POST",
        headers: {
          "X-Archive-Lease": lease.leaseToken,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(failure),
      },
      signal,
    );
  }

  async headers(additional: Readonly<Record<string, string>>): Promise<Headers> {
    const token = await this.credentials.getToken();
    return new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...additional,
    });
  }

  async requestJson<T>(pathName: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const headers = await this.headers(Object.fromEntries(new Headers(init.headers).entries()));
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(pathName, this.apiBaseUrl), {
        ...init,
        headers,
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new ArchiveAgentError("SERVICE_UNAVAILABLE", "Archive service request failed", true, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ArchiveAgentError(
        response.status === 401 || response.status === 403 ? "LEASE_LOST" : "SERVICE_UNAVAILABLE",
        `Archive service returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ArchiveAgentError(
        "SERVICE_UNAVAILABLE",
        "Archive service returned invalid JSON",
        true,
        {
          cause: error,
        },
      );
    }
    if (!isSuccessEnvelope(payload)) {
      throw new ArchiveAgentError(
        "SERVICE_UNAVAILABLE",
        "Archive service returned an invalid response envelope",
        true,
      );
    }
    return payload.data as T;
  }
}
