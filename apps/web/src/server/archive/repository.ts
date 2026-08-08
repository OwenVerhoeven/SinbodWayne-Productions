import { createUuidV7, safeRelativeArchivePath } from "@swp/domain";

import { sha256Hex, timingSafeHexEqual, randomSecret } from "./crypto";
import { ArchiveServiceError } from "./errors";
import { validateArchiveManifestContract } from "./manifest";
import {
  ARCHIVE_SERVICE_SCOPE,
  type ArchiveContentDescriptor,
  type ArchiveLeaseContext,
  type ArchiveLeaseContract,
  type ArchiveManifestContract,
  type ArchiveManifestItemContract,
  type ArchiveServicePrincipal,
  type FailureAcknowledgementInput,
  type ItemAcknowledgementInput,
  type LeaseRequest,
  type ManifestAcknowledgementInput,
} from "./types";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_AUTOMATIC_ATTEMPTS = 5;
const SERVICE_RATE_LIMIT_PER_MINUTE = 600;

interface ServiceCredentialRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly secret_digest: string;
  readonly scopes_json: string;
}

interface JobCandidateRow {
  readonly id: string;
}

interface ManifestHeaderRow {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly export_snapshot_id: string;
  readonly schema_version: string;
  readonly manifest_hash: string;
}

interface ManifestItemRow {
  readonly id: string;
  readonly logical_file_id: string | null;
  readonly file_version_id: string | null;
  readonly source_revision_id: string | null;
  readonly relative_path: string;
  readonly object_key: string;
  readonly byte_size: number;
  readonly mime_type: string;
  readonly sha256: string;
}

interface LeaseRow {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly credential_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly export_snapshot_id: string;
  readonly manifest_hash: string;
  readonly agent_id: string;
  readonly lease_token_hash: string;
  readonly heartbeat_at: number;
  readonly expires_at: number;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly state: "running" | "completed" | "failed";
  readonly response_ref: string | null;
}

interface ItemCountRow {
  readonly total_count: number;
  readonly verified_count: number;
}

export interface ArchiveRepository {
  authenticateServiceCredential(rawToken: string, now: number): Promise<ArchiveServicePrincipal>;
  consumeServiceRateLimit(principal: ArchiveServicePrincipal, now: number): Promise<void>;
  leaseNextJob(
    principal: ArchiveServicePrincipal,
    request: LeaseRequest,
    now: number,
  ): Promise<ArchiveLeaseContract | null>;
  heartbeat(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    manifestHash: string,
    now: number,
  ): Promise<{ readonly leaseExpiresAt: string }>;
  authorizeLease(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    now: number,
  ): Promise<ArchiveLeaseContext>;
  getContentDescriptor(
    lease: ArchiveLeaseContext,
    itemId: string,
  ): Promise<ArchiveContentDescriptor>;
  getWorkflowContentDescriptors(jobId: string): Promise<readonly ArchiveContentDescriptor[]>;
  acknowledgeItem(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    acknowledgement: ItemAcknowledgementInput,
    now: number,
  ): Promise<{ readonly acknowledged: true }>;
  acknowledgeManifest(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    acknowledgement: ManifestAcknowledgementInput,
    now: number,
  ): Promise<{ readonly verified: true }>;
  recordFailure(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    failure: FailureAcknowledgementInput,
    now: number,
  ): Promise<{ readonly recorded: true; readonly willRetry: boolean }>;
  materializeWorkflowManifest(
    jobId: string,
    now: number,
  ): Promise<{ readonly archiveJobId: string }>;
  validateWorkflowJob(jobId: string): Promise<{ readonly archiveJobId: string }>;
  markWorkflowJobRequested(jobId: string, now: number): Promise<{ readonly archiveJobId: string }>;
  markWorkflowJobFailed(jobId: string, errorCode: string, now: number): Promise<void>;
}

function normalizedStoredDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function hasArchiveScope(scopesJson: string): boolean {
  try {
    const scopes: unknown = JSON.parse(scopesJson);
    return (
      Array.isArray(scopes) &&
      scopes.every((scope) => typeof scope === "string") &&
      scopes.includes(ARCHIVE_SERVICE_SCOPE)
    );
  } catch {
    return false;
  }
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(value)) {
    throw new ArchiveServiceError("INVALID_REQUEST", "A valid Idempotency-Key is required.");
  }
}

function safeFailureMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    CHECKSUM_MISMATCH: "A downloaded archive item did not match its manifest checksum.",
    DOWNLOAD_INTERRUPTED: "The archive transfer was interrupted.",
    INSUFFICIENT_SPACE: "The archive destination reported insufficient free space.",
    INVALID_MANIFEST: "The archive agent rejected the immutable manifest.",
    INVALID_PATH: "The archive agent rejected an unsafe destination path.",
    MISSING_OBJECT: "An immutable archive source object was unavailable.",
    PATH_ESCAPE: "The archive agent blocked a path escape.",
    SERVICE_UNAVAILABLE: "The archive agent could not complete a service request.",
  };
  return messages[code] ?? "The archive agent reported a transfer failure.";
}

function manifestItemFromRow(row: ManifestItemRow): ArchiveManifestItemContract {
  return {
    id: row.id,
    relativePath: row.relative_path,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    sha256: row.sha256,
    ...(row.logical_file_id === null ? {} : { logicalFileId: row.logical_file_id }),
    ...(row.file_version_id === null ? {} : { fileVersionId: row.file_version_id }),
    ...(row.source_revision_id === null ? {} : { sourceRevisionIds: [row.source_revision_id] }),
  };
}

function canonicalRequest(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}

export class D1ArchiveRepository implements ArchiveRepository {
  readonly database: D1Database;

  constructor(database: D1Database) {
    this.database = database;
  }

  async authenticateServiceCredential(
    rawToken: string,
    now: number,
  ): Promise<ArchiveServicePrincipal> {
    const boundedToken = rawToken.length > 0 && rawToken.length <= 512 ? rawToken : "invalid";
    const presentedDigest = await sha256Hex(boundedToken);
    const rows = await this.database
      .prepare(
        `SELECT id, workspace_id, secret_digest, scopes_json
           FROM service_credentials
          WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY id
          LIMIT 128`,
      )
      .bind(now)
      .all<ServiceCredentialRow>();

    let principal: ArchiveServicePrincipal | undefined;
    for (const row of rows.results) {
      const digestMatches = timingSafeHexEqual(
        normalizedStoredDigest(row.secret_digest),
        presentedDigest,
      );
      const scopeMatches = hasArchiveScope(row.scopes_json);
      if (digestMatches && scopeMatches && rawToken === boundedToken) {
        principal = { credentialId: row.id, workspaceId: row.workspace_id };
      }
    }
    if (principal === undefined) {
      throw new ArchiveServiceError(
        "AUTHENTICATION_REQUIRED",
        "Archive service authentication failed.",
      );
    }
    return principal;
  }

  async consumeServiceRateLimit(principal: ArchiveServicePrincipal, now: number): Promise<void> {
    const keyDigest = await sha256Hex(`archive-service:${principal.credentialId}`);
    const windowStartedAt = Math.floor(now / 60_000) * 60_000;
    const row = await this.database
      .prepare(
        `INSERT INTO rate_limit_buckets (
            key_digest, workspace_id, route_group, window_started_at,
            attempt_count, blocked_until, updated_at
          ) VALUES (?, ?, 'service_archive', ?, 1, NULL, ?)
          ON CONFLICT(key_digest) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            route_group = excluded.route_group,
            window_started_at = CASE
              WHEN rate_limit_buckets.window_started_at < excluded.window_started_at
              THEN excluded.window_started_at ELSE rate_limit_buckets.window_started_at END,
            attempt_count = CASE
              WHEN rate_limit_buckets.window_started_at < excluded.window_started_at
              THEN 1 ELSE rate_limit_buckets.attempt_count + 1 END,
            blocked_until = CASE
              WHEN rate_limit_buckets.blocked_until > excluded.updated_at
              THEN rate_limit_buckets.blocked_until
              WHEN rate_limit_buckets.window_started_at = excluded.window_started_at
                   AND rate_limit_buckets.attempt_count + 1 > ?
              THEN excluded.updated_at + 60000
              ELSE NULL END,
            updated_at = excluded.updated_at
          RETURNING attempt_count, blocked_until`,
      )
      .bind(keyDigest, principal.workspaceId, windowStartedAt, now, SERVICE_RATE_LIMIT_PER_MINUTE)
      .first<{ attempt_count: number; blocked_until: number | null }>();
    if (
      row?.blocked_until !== null &&
      row?.blocked_until !== undefined &&
      row.blocked_until > now
    ) {
      throw new ArchiveServiceError("RATE_LIMITED", "Archive service rate limit exceeded.", {
        details: { retryAfterSeconds: Math.max(1, Math.ceil((row.blocked_until - now) / 1_000)) },
      });
    }
  }

  async loadManifest(jobId: string, workspaceId?: string): Promise<ArchiveManifestContract> {
    const header = await this.database
      .prepare(
        `SELECT aj.id AS job_id,
                aj.workspace_id,
                aj.project_id,
                aj.export_snapshot_id,
                es.schema_version,
                es.manifest_hash
           FROM archive_jobs aj
           JOIN export_snapshots es
             ON es.id = aj.export_snapshot_id
            AND es.workspace_id = aj.workspace_id
            AND es.project_id = aj.project_id
          WHERE aj.id = ?
            AND es.state = 'complete'
            AND (? IS NULL OR aj.workspace_id = ?)`,
      )
      .bind(jobId, workspaceId ?? null, workspaceId ?? null)
      .first<ManifestHeaderRow>();
    if (header === null) {
      throw new ArchiveServiceError("NOT_FOUND", "Archive job was not found.");
    }
    const rows = await this.database
      .prepare(
        `SELECT id, logical_file_id, file_version_id, source_revision_id,
                relative_path, object_key, byte_size, mime_type, sha256
           FROM archive_manifest_items
          WHERE archive_job_id = ?
            AND workspace_id = ?
            AND project_id = ?
          ORDER BY sort_rank, id`,
      )
      .bind(jobId, header.workspace_id, header.project_id)
      .all<ManifestItemRow>();
    const manifest: ArchiveManifestContract = {
      schemaVersion: header.schema_version,
      projectId: header.project_id,
      exportSnapshotId: header.export_snapshot_id,
      manifestHash: header.manifest_hash,
      items: rows.results.map(manifestItemFromRow),
    };
    await validateArchiveManifestContract(manifest);
    return manifest;
  }

  async leaseNextJob(
    principal: ArchiveServicePrincipal,
    request: LeaseRequest,
    now: number,
  ): Promise<ArchiveLeaseContract | null> {
    const candidates = await this.database
      .prepare(
        `SELECT aj.id
           FROM archive_jobs aj
           JOIN export_snapshots es
             ON es.id = aj.export_snapshot_id
            AND es.workspace_id = aj.workspace_id
            AND es.project_id = aj.project_id
           LEFT JOIN archive_leases al ON al.archive_job_id = aj.id
          WHERE aj.workspace_id = ?
            AND es.state = 'complete'
            AND (
              aj.status = 'requested'
              OR (aj.status IN ('running', 'verifying') AND al.expires_at <= ?)
            )
          ORDER BY aj.created_at, aj.id
          LIMIT 8`,
      )
      .bind(principal.workspaceId, now)
      .all<JobCandidateRow>();

    for (const candidate of candidates.results) {
      let manifest: ArchiveManifestContract;
      try {
        manifest = await this.loadManifest(candidate.id, principal.workspaceId);
      } catch (error) {
        if (error instanceof ArchiveServiceError && error.code === "INTEGRITY_FAILURE") {
          await this.markWorkflowJobFailed(candidate.id, "INVALID_MANIFEST", now);
          continue;
        }
        throw error;
      }

      const leaseToken = randomSecret();
      const leaseTokenHash = await sha256Hex(leaseToken);
      const attemptId = createUuidV7(() => now);
      const auditEventId = createUuidV7(() => now);
      const expiresAt = now + request.leaseDurationMs;
      const results = await this.database.batch([
        this.database
          .prepare(
            `UPDATE archive_attempts
                SET state = 'failed', finished_at = ?, retryable = 1,
                    error_code = 'LEASE_EXPIRED',
                    error_message = 'The archive agent lease expired before completion.'
              WHERE archive_job_id = ?
                AND state = 'running'
                AND EXISTS (
                  SELECT 1 FROM archive_leases
                   WHERE archive_job_id = ? AND expires_at <= ?
                )`,
          )
          .bind(now, candidate.id, candidate.id, now),
        this.database
          .prepare(
            `INSERT INTO archive_leases (
                archive_job_id, service_credential_id, agent_id, lease_token_hash,
                leased_at, heartbeat_at, expires_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(archive_job_id) DO UPDATE SET
                service_credential_id = excluded.service_credential_id,
                agent_id = excluded.agent_id,
                lease_token_hash = excluded.lease_token_hash,
                leased_at = excluded.leased_at,
                heartbeat_at = excluded.heartbeat_at,
                expires_at = excluded.expires_at
              WHERE archive_leases.expires_at <= excluded.leased_at
              RETURNING archive_job_id`,
          )
          .bind(
            candidate.id,
            principal.credentialId,
            request.agentId,
            leaseTokenHash,
            now,
            now,
            expiresAt,
          ),
        this.database
          .prepare(
            `UPDATE archive_jobs
                SET status = 'running', attempt_count = attempt_count + 1,
                    last_error_code = NULL, last_error_message = NULL,
                    last_error_retryable = NULL, updated_at = ?
              WHERE id = ?
                AND workspace_id = ?
                AND EXISTS (
                  SELECT 1 FROM archive_leases
                   WHERE archive_job_id = ? AND lease_token_hash = ?
                )`,
          )
          .bind(now, candidate.id, principal.workspaceId, candidate.id, leaseTokenHash),
        this.database
          .prepare(
            `INSERT INTO archive_attempts (
                id, workspace_id, project_id, archive_job_id, attempt_number,
                service_credential_id, agent_id, state, started_at, heartbeat_at
              )
              SELECT ?, workspace_id, project_id, id, attempt_count,
                     ?, ?, 'running', ?, ?
                FROM archive_jobs
               WHERE id = ? AND workspace_id = ?
                 AND EXISTS (
                   SELECT 1 FROM archive_leases
                    WHERE archive_job_id = ? AND lease_token_hash = ?
                 )`,
          )
          .bind(
            attemptId,
            principal.credentialId,
            request.agentId,
            now,
            now,
            candidate.id,
            principal.workspaceId,
            candidate.id,
            leaseTokenHash,
          ),
        this.database
          .prepare(
            `INSERT INTO audit_events (
                id, workspace_id, project_id, actor_type, actor_id,
                action, object_type, object_id, request_id, metadata_json, created_at
              )
              SELECT ?, workspace_id, project_id, 'service', ?,
                     'archive.lease_acquired', 'archive_job', id, NULL, ?, ?
                FROM archive_jobs
               WHERE id = ? AND workspace_id = ?
                 AND EXISTS (
                   SELECT 1 FROM archive_leases
                    WHERE archive_job_id = ? AND lease_token_hash = ?
                 )`,
          )
          .bind(
            auditEventId,
            principal.credentialId,
            JSON.stringify({ agentId: request.agentId, attemptId }),
            now,
            candidate.id,
            principal.workspaceId,
            candidate.id,
            leaseTokenHash,
          ),
      ]);
      if ((results[1]?.results.length ?? 0) === 0) continue;
      return {
        jobId: candidate.id,
        leaseToken,
        leaseExpiresAt: new Date(expiresAt).toISOString(),
        manifest,
      };
    }
    return null;
  }

  async authorizeLease(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    now: number,
  ): Promise<ArchiveLeaseContext> {
    const row = await this.database
      .prepare(
        `SELECT aj.id AS job_id, aa.id AS attempt_id,
                al.service_credential_id AS credential_id,
                aj.workspace_id, aj.project_id, aj.export_snapshot_id,
                es.manifest_hash, al.agent_id, al.lease_token_hash,
                al.heartbeat_at, al.expires_at
           FROM archive_jobs aj
           JOIN export_snapshots es ON es.id = aj.export_snapshot_id
           JOIN archive_leases al ON al.archive_job_id = aj.id
           JOIN archive_attempts aa
             ON aa.archive_job_id = aj.id
            AND aa.attempt_number = aj.attempt_count
            AND aa.state = 'running'
          WHERE aj.id = ? AND aj.workspace_id = ?
            AND al.service_credential_id = ?
            AND al.expires_at > ?
            AND aj.status IN ('running', 'verifying')`,
      )
      .bind(jobId, principal.workspaceId, principal.credentialId, now)
      .first<LeaseRow>();
    const boundedToken =
      rawLeaseToken.length > 0 && rawLeaseToken.length <= 512 ? rawLeaseToken : "invalid";
    const presentedDigest = await sha256Hex(boundedToken);
    if (
      row === null ||
      rawLeaseToken !== boundedToken ||
      !timingSafeHexEqual(row.lease_token_hash, presentedDigest)
    ) {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    return {
      jobId: row.job_id,
      attemptId: row.attempt_id,
      credentialId: row.credential_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      exportSnapshotId: row.export_snapshot_id,
      manifestHash: row.manifest_hash,
      agentId: row.agent_id,
      expiresAt: row.expires_at,
    };
  }

  async heartbeat(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    manifestHash: string,
    now: number,
  ): Promise<{ readonly leaseExpiresAt: string }> {
    const lease = await this.authorizeLease(principal, jobId, rawLeaseToken, now);
    if (!timingSafeHexEqual(lease.manifestHash, manifestHash)) {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "The lease manifest hash changed.");
    }
    const row = await this.database
      .prepare(
        `SELECT heartbeat_at, expires_at
           FROM archive_leases
          WHERE archive_job_id = ? AND service_credential_id = ?`,
      )
      .bind(jobId, principal.credentialId)
      .first<{ heartbeat_at: number; expires_at: number }>();
    if (row === null) {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    const duration = Math.max(30_000, Math.min(900_000, row.expires_at - row.heartbeat_at));
    const expiresAt = now + duration;
    const digest = await sha256Hex(rawLeaseToken);
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE archive_leases
              SET heartbeat_at = ?, expires_at = ?
            WHERE archive_job_id = ? AND service_credential_id = ?
              AND lease_token_hash = ? AND expires_at > ?`,
        )
        .bind(now, expiresAt, jobId, principal.credentialId, digest, now),
      this.database
        .prepare(
          `UPDATE archive_attempts
              SET heartbeat_at = ?
            WHERE id = ? AND archive_job_id = ? AND state = 'running'`,
        )
        .bind(now, lease.attemptId, jobId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    return { leaseExpiresAt: new Date(expiresAt).toISOString() };
  }

  async getContentDescriptor(
    lease: ArchiveLeaseContext,
    itemId: string,
  ): Promise<ArchiveContentDescriptor> {
    const row = await this.database
      .prepare(
        `SELECT object_key, byte_size, mime_type, sha256, relative_path
           FROM archive_manifest_items
          WHERE id = ? AND archive_job_id = ?
            AND workspace_id = ? AND project_id = ?`,
      )
      .bind(itemId, lease.jobId, lease.workspaceId, lease.projectId)
      .first<{
        object_key: string;
        byte_size: number;
        mime_type: string;
        sha256: string;
        relative_path: string;
      }>();
    if (row === null) {
      throw new ArchiveServiceError("NOT_FOUND", "Archive manifest item was not found.");
    }
    return {
      objectKey: row.object_key,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      sha256: row.sha256,
      relativePath: row.relative_path,
    };
  }

  async getWorkflowContentDescriptors(jobId: string): Promise<readonly ArchiveContentDescriptor[]> {
    const rows = await this.database
      .prepare(
        `SELECT object_key, byte_size, mime_type, sha256, relative_path
           FROM archive_manifest_items
          WHERE archive_job_id = ?
          ORDER BY sort_rank, id`,
      )
      .bind(jobId)
      .all<{
        object_key: string;
        byte_size: number;
        mime_type: string;
        sha256: string;
        relative_path: string;
      }>();
    return rows.results.map((row) => ({
      objectKey: row.object_key,
      byteSize: row.byte_size,
      mimeType: row.mime_type,
      sha256: row.sha256,
      relativePath: row.relative_path,
    }));
  }

  async loadIdempotency(
    principal: ArchiveServicePrincipal,
    operation: string,
    keyDigest: string,
  ): Promise<IdempotencyRow | null> {
    return this.database
      .prepare(
        `SELECT request_hash, state, response_ref
           FROM idempotency_records
          WHERE workspace_id = ? AND actor_fingerprint = ?
            AND operation = ? AND idempotency_key_digest = ?`,
      )
      .bind(principal.workspaceId, principal.credentialId, operation, keyDigest)
      .first<IdempotencyRow>();
  }

  async beginIdempotency(
    principal: ArchiveServicePrincipal,
    operation: string,
    idempotencyKey: string,
    requestHash: string,
    now: number,
  ): Promise<{ readonly replay: boolean; readonly keyDigest: string; readonly recordId: string }> {
    assertIdempotencyKey(idempotencyKey);
    const keyDigest = await sha256Hex(idempotencyKey);
    const existing = await this.loadIdempotency(principal, operation, keyDigest);
    if (existing !== null) {
      if (!timingSafeHexEqual(existing.request_hash, requestHash)) {
        throw new ArchiveServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The Idempotency-Key was already used with different content.",
        );
      }
      return {
        replay: existing.state === "completed",
        keyDigest,
        recordId: existing.response_ref ?? "",
      };
    }
    const recordId = createUuidV7(() => now);
    const insert = await this.database
      .prepare(
        `INSERT OR IGNORE INTO idempotency_records (
            id, workspace_id, actor_fingerprint, operation,
            idempotency_key_digest, request_hash, state,
            expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .bind(
        recordId,
        principal.workspaceId,
        principal.credentialId,
        operation,
        keyDigest,
        requestHash,
        now + IDEMPOTENCY_TTL_MS,
        now,
        now,
      )
      .run();
    if (insert.meta.changes === 0) {
      const raced = await this.loadIdempotency(principal, operation, keyDigest);
      if (raced === null || !timingSafeHexEqual(raced.request_hash, requestHash)) {
        throw new ArchiveServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The Idempotency-Key was already used with different content.",
        );
      }
      return { replay: raced.state === "completed", keyDigest, recordId: raced.response_ref ?? "" };
    }
    return { replay: false, keyDigest, recordId };
  }

  async acknowledgeItem(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    acknowledgement: ItemAcknowledgementInput,
    now: number,
  ): Promise<{ readonly acknowledged: true }> {
    const requestHash = await sha256Hex(
      canonicalRequest({
        byteSize: acknowledgement.byteSize,
        sha256: acknowledgement.sha256,
        destinationPath: acknowledgement.destinationPath,
      }),
    );
    const operation = `archive:item:${jobId}:${itemId}`;
    const idempotency = await this.beginIdempotency(
      principal,
      operation,
      idempotencyKey,
      requestHash,
      now,
    );
    if (idempotency.replay) return { acknowledged: true };

    const lease = await this.authorizeLease(principal, jobId, rawLeaseToken, now);
    const item = await this.getContentDescriptor(lease, itemId);
    let destinationPath: string;
    try {
      destinationPath = safeRelativeArchivePath(acknowledgement.destinationPath);
    } catch {
      throw new ArchiveServiceError("INVALID_REQUEST", "The acknowledged path is invalid.");
    }
    if (
      acknowledgement.byteSize !== item.byteSize ||
      !timingSafeHexEqual(acknowledgement.sha256, item.sha256) ||
      destinationPath !== item.relativePath
    ) {
      throw new ArchiveServiceError(
        "INTEGRITY_FAILURE",
        "The acknowledgement does not match the immutable manifest item.",
      );
    }
    const acknowledgementId = createUuidV7(() => now);
    const auditEventId = createUuidV7(() => now);
    const leaseTokenHash = await sha256Hex(rawLeaseToken);
    await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO archive_acknowledgements (
              id, workspace_id, project_id, archive_job_id, manifest_item_id,
              attempt_id, ack_kind, verified_byte_size, verified_sha256,
              verified_item_count, destination_path, payload_hash,
              service_credential_id, idempotency_key, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'item', ?, ?, NULL, ?, ?, ?, ?, ?
              FROM archive_leases
             WHERE archive_job_id = ? AND service_credential_id = ?
               AND lease_token_hash = ? AND expires_at > ?`,
        )
        .bind(
          acknowledgementId,
          lease.workspaceId,
          lease.projectId,
          jobId,
          itemId,
          lease.attemptId,
          acknowledgement.byteSize,
          acknowledgement.sha256,
          destinationPath,
          requestHash,
          principal.credentialId,
          idempotencyKey,
          now,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_manifest_items
              SET state = 'verified'
            WHERE id = ? AND archive_job_id = ?
              AND byte_size = ? AND sha256 = ?
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(
          itemId,
          jobId,
          acknowledgement.byteSize,
          acknowledgement.sha256,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_jobs
              SET status = CASE
                    WHEN NOT EXISTS (
                      SELECT 1 FROM archive_manifest_items
                       WHERE archive_job_id = ? AND state <> 'verified'
                    ) THEN 'verifying'
                    ELSE status
                  END,
                  updated_at = ?
            WHERE id = ? AND status IN ('running', 'verifying')
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(jobId, now, jobId, jobId, principal.credentialId, leaseTokenHash, now),
      this.database
        .prepare(
          `UPDATE idempotency_records
              SET state = 'completed', response_status = 200,
                  response_ref = ?, updated_at = ?
            WHERE workspace_id = ? AND actor_fingerprint = ?
              AND operation = ? AND idempotency_key_digest = ?
              AND request_hash = ?
              AND EXISTS (
                SELECT 1 FROM archive_acknowledgements
                 WHERE archive_job_id = ? AND manifest_item_id = ?
                   AND ack_kind = 'item' AND verified_byte_size = ?
                   AND verified_sha256 = ?
              )`,
        )
        .bind(
          acknowledgementId,
          now,
          principal.workspaceId,
          principal.credentialId,
          operation,
          idempotency.keyDigest,
          requestHash,
          jobId,
          itemId,
          acknowledgement.byteSize,
          acknowledgement.sha256,
        ),
      this.database
        .prepare(
          `INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id,
              action, object_type, object_id, request_id, metadata_json, created_at
            )
            SELECT ?, ?, ?, 'service', ?, 'archive.item_verified',
                   'archive_manifest_item', ?, NULL, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM archive_acknowledgements
                WHERE id = ? AND ack_kind = 'item'
             )`,
        )
        .bind(
          auditEventId,
          lease.workspaceId,
          lease.projectId,
          principal.credentialId,
          itemId,
          JSON.stringify({ archiveJobId: jobId, attemptId: lease.attemptId }),
          now,
          acknowledgementId,
        ),
    ]);
    const completed = await this.database
      .prepare(
        `SELECT state FROM archive_manifest_items
          WHERE id = ? AND archive_job_id = ? AND workspace_id = ?`,
      )
      .bind(itemId, jobId, principal.workspaceId)
      .first<{ state: string }>();
    if (completed?.state !== "verified") {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    return { acknowledged: true };
  }

  async acknowledgeManifest(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    acknowledgement: ManifestAcknowledgementInput,
    now: number,
  ): Promise<{ readonly verified: true }> {
    const requestHash = await sha256Hex(
      canonicalRequest({
        manifestHash: acknowledgement.manifestHash,
        itemCount: acknowledgement.itemCount,
      }),
    );
    const operation = `archive:manifest:${jobId}`;
    const idempotency = await this.beginIdempotency(
      principal,
      operation,
      idempotencyKey,
      requestHash,
      now,
    );
    if (idempotency.replay) return { verified: true };

    const lease = await this.authorizeLease(principal, jobId, rawLeaseToken, now);
    if (!timingSafeHexEqual(acknowledgement.manifestHash, lease.manifestHash)) {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "The manifest acknowledgement changed.");
    }
    const counts = await this.database
      .prepare(
        `SELECT COUNT(*) AS total_count,
                SUM(CASE WHEN state = 'verified' THEN 1 ELSE 0 END) AS verified_count
           FROM archive_manifest_items
          WHERE archive_job_id = ? AND workspace_id = ?`,
      )
      .bind(jobId, principal.workspaceId)
      .first<ItemCountRow>();
    const totalCount = counts?.total_count ?? 0;
    const verifiedCount = counts?.verified_count ?? 0;
    if (acknowledgement.itemCount !== totalCount || verifiedCount !== totalCount) {
      throw new ArchiveServiceError(
        "CONFLICT",
        "The complete manifest cannot be acknowledged before every item is verified.",
      );
    }
    const acknowledgementId = createUuidV7(() => now);
    const auditEventId = createUuidV7(() => now);
    const leaseTokenHash = await sha256Hex(rawLeaseToken);
    await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO archive_acknowledgements (
              id, workspace_id, project_id, archive_job_id, manifest_item_id,
              attempt_id, ack_kind, verified_byte_size, verified_sha256,
              verified_item_count, destination_path, payload_hash,
              service_credential_id, idempotency_key, created_at
            )
            SELECT ?, ?, ?, ?, NULL, ?, 'manifest', NULL, ?, ?, NULL, ?, ?, ?, ?
              FROM archive_leases
             WHERE archive_job_id = ? AND service_credential_id = ?
               AND lease_token_hash = ? AND expires_at > ?`,
        )
        .bind(
          acknowledgementId,
          lease.workspaceId,
          lease.projectId,
          jobId,
          lease.attemptId,
          acknowledgement.manifestHash,
          acknowledgement.itemCount,
          requestHash,
          principal.credentialId,
          idempotencyKey,
          now,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_jobs
              SET status = 'verified', verified_at = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?
              AND status IN ('running', 'verifying')
              AND NOT EXISTS (
                SELECT 1 FROM archive_manifest_items
                 WHERE archive_job_id = ? AND state <> 'verified'
              )
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(
          now,
          now,
          jobId,
          principal.workspaceId,
          jobId,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_attempts
              SET state = 'verified', finished_at = ?, heartbeat_at = ?
            WHERE id = ? AND archive_job_id = ? AND state = 'running'
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(now, now, lease.attemptId, jobId, jobId, principal.credentialId, leaseTokenHash, now),
      this.database
        .prepare(
          `DELETE FROM archive_leases
            WHERE archive_job_id = ? AND service_credential_id = ?
              AND lease_token_hash = ?`,
        )
        .bind(jobId, principal.credentialId, leaseTokenHash),
      this.database
        .prepare(
          `UPDATE idempotency_records
              SET state = 'completed', response_status = 200,
                  response_ref = ?, updated_at = ?
            WHERE workspace_id = ? AND actor_fingerprint = ?
              AND operation = ? AND idempotency_key_digest = ?
              AND request_hash = ?
              AND EXISTS (
                SELECT 1 FROM archive_jobs
                 WHERE id = ? AND workspace_id = ? AND status = 'verified'
              )`,
        )
        .bind(
          acknowledgementId,
          now,
          principal.workspaceId,
          principal.credentialId,
          operation,
          idempotency.keyDigest,
          requestHash,
          jobId,
          principal.workspaceId,
        ),
      this.database
        .prepare(
          `INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id,
              action, object_type, object_id, request_id, metadata_json, created_at
            )
            SELECT ?, ?, ?, 'service', ?, 'archive.verified',
                   'archive_job', ?, NULL, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM archive_acknowledgements
                WHERE id = ? AND ack_kind = 'manifest'
             )`,
        )
        .bind(
          auditEventId,
          lease.workspaceId,
          lease.projectId,
          principal.credentialId,
          jobId,
          JSON.stringify({
            attemptId: lease.attemptId,
            manifestHash: acknowledgement.manifestHash,
            itemCount: acknowledgement.itemCount,
          }),
          now,
          acknowledgementId,
        ),
    ]);
    const completed = await this.database
      .prepare(`SELECT status FROM archive_jobs WHERE id = ? AND workspace_id = ?`)
      .bind(jobId, principal.workspaceId)
      .first<{ status: string }>();
    if (completed?.status !== "verified") {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    return { verified: true };
  }

  async recordFailure(
    principal: ArchiveServicePrincipal,
    jobId: string,
    rawLeaseToken: string,
    idempotencyKey: string,
    failure: FailureAcknowledgementInput,
    now: number,
  ): Promise<{ readonly recorded: true; readonly willRetry: boolean }> {
    const requestHash = await sha256Hex(
      canonicalRequest({ code: failure.code, retryable: failure.retryable }),
    );
    const operation = `archive:failure:${jobId}`;
    const idempotency = await this.beginIdempotency(
      principal,
      operation,
      idempotencyKey,
      requestHash,
      now,
    );
    if (idempotency.replay) {
      const job = await this.database
        .prepare(`SELECT status FROM archive_jobs WHERE id = ? AND workspace_id = ?`)
        .bind(jobId, principal.workspaceId)
        .first<{ status: string }>();
      return { recorded: true, willRetry: job?.status === "requested" };
    }

    const lease = await this.authorizeLease(principal, jobId, rawLeaseToken, now);
    const attempt = await this.database
      .prepare(`SELECT attempt_count FROM archive_jobs WHERE id = ? AND workspace_id = ?`)
      .bind(jobId, principal.workspaceId)
      .first<{ attempt_count: number }>();
    const willRetry =
      failure.retryable &&
      (attempt?.attempt_count ?? MAX_AUTOMATIC_ATTEMPTS) < MAX_AUTOMATIC_ATTEMPTS;
    const nextStatus = willRetry ? "requested" : "failed";
    const message = safeFailureMessage(failure.code);
    const acknowledgementId = createUuidV7(() => now);
    const auditEventId = createUuidV7(() => now);
    const leaseTokenHash = await sha256Hex(rawLeaseToken);
    await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO archive_acknowledgements (
              id, workspace_id, project_id, archive_job_id, manifest_item_id,
              attempt_id, ack_kind, verified_byte_size, verified_sha256,
              verified_item_count, destination_path, payload_hash,
              error_code, retryable, service_credential_id,
              idempotency_key, created_at
            )
            SELECT ?, ?, ?, ?, NULL, ?, 'failure', NULL, NULL, NULL,
                   NULL, ?, ?, ?, ?, ?, ?
              FROM archive_leases
             WHERE archive_job_id = ? AND service_credential_id = ?
               AND lease_token_hash = ? AND expires_at > ?`,
        )
        .bind(
          acknowledgementId,
          lease.workspaceId,
          lease.projectId,
          jobId,
          lease.attemptId,
          requestHash,
          failure.code,
          failure.retryable ? 1 : 0,
          principal.credentialId,
          idempotencyKey,
          now,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_attempts
              SET state = 'failed', finished_at = ?, heartbeat_at = ?,
                  retryable = ?, error_code = ?, error_message = ?
            WHERE id = ? AND archive_job_id = ? AND state = 'running'
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(
          now,
          now,
          failure.retryable ? 1 : 0,
          failure.code,
          message,
          lease.attemptId,
          jobId,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `UPDATE archive_jobs
              SET status = ?, last_error_code = ?, last_error_message = ?,
                  last_error_retryable = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?
              AND status IN ('running', 'verifying')
              AND EXISTS (
                SELECT 1 FROM archive_leases
                 WHERE archive_job_id = ? AND service_credential_id = ?
                   AND lease_token_hash = ? AND expires_at > ?
              )`,
        )
        .bind(
          nextStatus,
          failure.code,
          message,
          failure.retryable ? 1 : 0,
          now,
          jobId,
          principal.workspaceId,
          jobId,
          principal.credentialId,
          leaseTokenHash,
          now,
        ),
      this.database
        .prepare(
          `DELETE FROM archive_leases
            WHERE archive_job_id = ? AND service_credential_id = ?
              AND lease_token_hash = ?`,
        )
        .bind(jobId, principal.credentialId, leaseTokenHash),
      this.database
        .prepare(
          `UPDATE idempotency_records
              SET state = 'completed', response_status = 200,
                  response_ref = ?, updated_at = ?
            WHERE workspace_id = ? AND actor_fingerprint = ?
              AND operation = ? AND idempotency_key_digest = ?
              AND request_hash = ?
              AND EXISTS (
                SELECT 1 FROM archive_jobs
                 WHERE id = ? AND workspace_id = ?
                   AND status = ? AND last_error_code = ?
              )`,
        )
        .bind(
          acknowledgementId,
          now,
          principal.workspaceId,
          principal.credentialId,
          operation,
          idempotency.keyDigest,
          requestHash,
          jobId,
          principal.workspaceId,
          nextStatus,
          failure.code,
        ),
      this.database
        .prepare(
          `INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id,
              action, object_type, object_id, request_id, metadata_json, created_at
            )
            SELECT ?, ?, ?, 'service', ?, 'archive.attempt_failed',
                   'archive_job', ?, NULL, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM archive_acknowledgements
                WHERE id = ? AND ack_kind = 'failure'
             )`,
        )
        .bind(
          auditEventId,
          lease.workspaceId,
          lease.projectId,
          principal.credentialId,
          jobId,
          JSON.stringify({
            attemptId: lease.attemptId,
            errorCode: failure.code,
            retryable: failure.retryable,
            willRetry,
          }),
          now,
          acknowledgementId,
        ),
    ]);
    const completed = await this.database
      .prepare(
        `SELECT status, last_error_code FROM archive_jobs
          WHERE id = ? AND workspace_id = ?`,
      )
      .bind(jobId, principal.workspaceId)
      .first<{ status: string; last_error_code: string | null }>();
    if (completed?.status !== nextStatus || completed.last_error_code !== failure.code) {
      throw new ArchiveServiceError("LEASE_LOST", "The archive lease is invalid or expired.");
    }
    return { recorded: true, willRetry };
  }

  async validateWorkflowJob(jobId: string): Promise<{ readonly archiveJobId: string }> {
    const manifest = await this.loadManifest(jobId);
    const rows = await this.database
      .prepare(
        `SELECT object_key, byte_size, sha256
           FROM archive_manifest_items
          WHERE archive_job_id = ?
          ORDER BY sort_rank, id`,
      )
      .bind(jobId)
      .all<{ object_key: string; byte_size: number; sha256: string }>();
    if (rows.results.length !== manifest.items.length) {
      throw new ArchiveServiceError("INTEGRITY_FAILURE", "Archive manifest item count changed.");
    }
    return { archiveJobId: jobId };
  }

  async materializeWorkflowManifest(
    jobId: string,
    now: number,
  ): Promise<{ readonly archiveJobId: string }> {
    const result = await this.database
      .prepare(
        `INSERT OR IGNORE INTO archive_manifest_items (
            id, workspace_id, project_id, archive_job_id,
            logical_file_id, file_version_id, source_revision_id,
            relative_path, object_key, byte_size, mime_type, sha256,
            sort_rank, state, created_at
          )
          SELECT emi.id, aj.workspace_id, aj.project_id, aj.id,
                 emi.logical_file_id, emi.file_version_id, emi.source_revision_id,
                 emi.relative_path, emi.object_key, emi.byte_size, emi.mime_type, emi.sha256,
                 emi.sort_rank, 'pending', ?
            FROM archive_jobs aj
            JOIN export_snapshots es
              ON es.id = aj.export_snapshot_id
             AND es.workspace_id = aj.workspace_id
             AND es.project_id = aj.project_id
            JOIN export_manifest_items emi ON emi.export_snapshot_id = es.id
           WHERE aj.id = ? AND es.state = 'complete'
             AND aj.status IN ('requested', 'failed')`,
      )
      .bind(now, jobId)
      .run();
    if (result.meta.changes === 0) {
      const existing = await this.database
        .prepare(
          `SELECT COUNT(*) AS item_count
             FROM archive_manifest_items
            WHERE archive_job_id = ?`,
        )
        .bind(jobId)
        .first<{ item_count: number }>();
      if ((existing?.item_count ?? 0) === 0) {
        throw new ArchiveServiceError(
          "INTEGRITY_FAILURE",
          "The completed export snapshot contains no archive manifest items.",
        );
      }
    }
    return { archiveJobId: jobId };
  }

  async markWorkflowJobRequested(
    jobId: string,
    now: number,
  ): Promise<{ readonly archiveJobId: string }> {
    const auditEventId = createUuidV7(() => now);
    const results = await this.database.batch([
      this.database
        .prepare(
          `UPDATE archive_jobs
              SET status = 'requested', updated_at = ?,
                  last_error_code = NULL, last_error_message = NULL,
                  last_error_retryable = NULL
            WHERE id = ? AND status IN ('requested', 'failed')
            RETURNING id`,
        )
        .bind(now, jobId),
      this.database
        .prepare(
          `INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id,
              action, object_type, object_id, request_id, metadata_json, created_at
            )
            SELECT ?, workspace_id, project_id, 'system', NULL,
                   'archive.requested', 'archive_job', id, NULL, '{}', ?
              FROM archive_jobs
             WHERE id = ? AND status = 'requested'`,
        )
        .bind(auditEventId, now, jobId),
    ]);
    if ((results[0]?.results.length ?? 0) === 0) {
      const row = await this.database
        .prepare(`SELECT status FROM archive_jobs WHERE id = ?`)
        .bind(jobId)
        .first<{ status: string }>();
      if (row?.status !== "requested") {
        throw new ArchiveServiceError("CONFLICT", "Archive job is not requestable.");
      }
    }
    return { archiveJobId: jobId };
  }

  async markWorkflowJobFailed(jobId: string, errorCode: string, now: number): Promise<void> {
    const auditEventId = createUuidV7(() => now);
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE archive_jobs
              SET status = 'failed', last_error_code = ?,
                  last_error_message = 'The immutable archive snapshot failed integrity validation.',
                  last_error_retryable = 0, updated_at = ?
            WHERE id = ? AND status <> 'verified'`,
        )
        .bind(errorCode, now, jobId),
      this.database
        .prepare(
          `INSERT INTO audit_events (
              id, workspace_id, project_id, actor_type, actor_id,
              action, object_type, object_id, request_id, metadata_json, created_at
            )
            SELECT ?, workspace_id, project_id, 'system', NULL,
                   'archive.preparation_failed', 'archive_job', id, NULL, ?, ?
              FROM archive_jobs
             WHERE id = ? AND status = 'failed' AND last_error_code = ?`,
        )
        .bind(auditEventId, JSON.stringify({ errorCode }), now, jobId, errorCode),
    ]);
  }
}
