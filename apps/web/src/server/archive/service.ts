import type { ArchiveRepository } from "./repository";
import { D1ArchiveRepository } from "./repository";
import { R2ArchiveStorage } from "./storage";
import type {
  ArchiveDownload,
  ArchiveLeaseContract,
  ArchiveServicePrincipal,
  FailureAcknowledgementInput,
  ItemAcknowledgementInput,
  LeaseRequest,
  ManifestAcknowledgementInput,
} from "./types";

export interface ArchiveCoordinatorContract {
  authenticate(rawToken: string, now: number): Promise<ArchiveServicePrincipal>;
  consumeRateLimit(principal: ArchiveServicePrincipal, now: number): Promise<void>;
  lease(
    principal: ArchiveServicePrincipal,
    request: LeaseRequest,
    now: number,
  ): Promise<ArchiveLeaseContract | null>;
  heartbeat(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
    manifestHash: string,
    now: number,
  ): Promise<{ readonly leaseExpiresAt: string }>;
  download(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    leaseToken: string,
    rangeHeader: string | null,
    now: number,
  ): Promise<ArchiveDownload>;
  acknowledgeItem(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    leaseToken: string,
    idempotencyKey: string,
    acknowledgement: ItemAcknowledgementInput,
    now: number,
  ): Promise<{ readonly acknowledged: true }>;
  acknowledgeManifest(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
    idempotencyKey: string,
    acknowledgement: ManifestAcknowledgementInput,
    now: number,
  ): Promise<{ readonly verified: true }>;
  recordFailure(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
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

export class ArchiveCoordinator implements ArchiveCoordinatorContract {
  readonly repository: ArchiveRepository;
  readonly storage: R2ArchiveStorage;

  constructor(repository: ArchiveRepository, storage: R2ArchiveStorage) {
    this.repository = repository;
    this.storage = storage;
  }

  static fromBindings(bindings: Pick<CloudflareBindings, "DB" | "FILES">): ArchiveCoordinator {
    return new ArchiveCoordinator(
      new D1ArchiveRepository(bindings.DB),
      new R2ArchiveStorage(bindings.FILES),
    );
  }

  authenticate(rawToken: string, now: number): Promise<ArchiveServicePrincipal> {
    return this.repository.authenticateServiceCredential(rawToken, now);
  }

  consumeRateLimit(principal: ArchiveServicePrincipal, now: number): Promise<void> {
    return this.repository.consumeServiceRateLimit(principal, now);
  }

  lease(
    principal: ArchiveServicePrincipal,
    request: LeaseRequest,
    now: number,
  ): Promise<ArchiveLeaseContract | null> {
    return this.repository.leaseNextJob(principal, request, now);
  }

  heartbeat(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
    manifestHash: string,
    now: number,
  ): Promise<{ readonly leaseExpiresAt: string }> {
    return this.repository.heartbeat(principal, jobId, leaseToken, manifestHash, now);
  }

  async download(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    leaseToken: string,
    rangeHeader: string | null,
    now: number,
  ): Promise<ArchiveDownload> {
    const lease = await this.repository.authorizeLease(principal, jobId, leaseToken, now);
    const descriptor = await this.repository.getContentDescriptor(lease, itemId);
    return this.storage.open(descriptor, rangeHeader);
  }

  acknowledgeItem(
    principal: ArchiveServicePrincipal,
    jobId: string,
    itemId: string,
    leaseToken: string,
    idempotencyKey: string,
    acknowledgement: ItemAcknowledgementInput,
    now: number,
  ): Promise<{ readonly acknowledged: true }> {
    return this.repository.acknowledgeItem(
      principal,
      jobId,
      itemId,
      leaseToken,
      idempotencyKey,
      acknowledgement,
      now,
    );
  }

  acknowledgeManifest(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
    idempotencyKey: string,
    acknowledgement: ManifestAcknowledgementInput,
    now: number,
  ): Promise<{ readonly verified: true }> {
    return this.repository.acknowledgeManifest(
      principal,
      jobId,
      leaseToken,
      idempotencyKey,
      acknowledgement,
      now,
    );
  }

  recordFailure(
    principal: ArchiveServicePrincipal,
    jobId: string,
    leaseToken: string,
    idempotencyKey: string,
    failure: FailureAcknowledgementInput,
    now: number,
  ): Promise<{ readonly recorded: true; readonly willRetry: boolean }> {
    return this.repository.recordFailure(
      principal,
      jobId,
      leaseToken,
      idempotencyKey,
      failure,
      now,
    );
  }

  materializeWorkflowManifest(
    jobId: string,
    now: number,
  ): Promise<{ readonly archiveJobId: string }> {
    return this.repository.materializeWorkflowManifest(jobId, now);
  }

  async validateWorkflowJob(jobId: string): Promise<{ readonly archiveJobId: string }> {
    const result = await this.repository.validateWorkflowJob(jobId);
    const descriptors = await this.repository.getWorkflowContentDescriptors(jobId);
    for (const descriptor of descriptors) {
      await this.storage.assertImmutableObject(descriptor);
    }
    return result;
  }

  markWorkflowJobRequested(jobId: string, now: number): Promise<{ readonly archiveJobId: string }> {
    return this.repository.markWorkflowJobRequested(jobId, now);
  }

  markWorkflowJobFailed(jobId: string, errorCode: string, now: number): Promise<void> {
    return this.repository.markWorkflowJobFailed(jobId, errorCode, now);
  }
}
