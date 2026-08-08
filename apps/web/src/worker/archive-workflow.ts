import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { ArchiveServiceError } from "../server/archive/errors";
import { ArchiveCoordinator } from "../server/archive/service";
import { archiveWorkflowPayloadSchema, type ArchiveWorkflowPayload } from "../server/archive/types";

export class ArchiveWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  ArchiveWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ArchiveWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly archiveJobId: string }> {
    const payload = archiveWorkflowPayloadSchema.parse(event.payload);
    const coordinator = ArchiveCoordinator.fromBindings(this.env);
    const stepPrefix = `archive:${payload.archiveJobId}`;

    try {
      await step.do(
        `${stepPrefix}:materialize-manifest-references`,
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => coordinator.materializeWorkflowManifest(payload.archiveJobId, Date.now()),
      );
      await step.do(
        `${stepPrefix}:verify-snapshot-references`,
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => coordinator.validateWorkflowJob(payload.archiveJobId),
      );
      return await step.do(
        `${stepPrefix}:publish-requested-job`,
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => coordinator.markWorkflowJobRequested(payload.archiveJobId, Date.now()),
      );
    } catch (cause) {
      const errorCode =
        cause instanceof ArchiveServiceError && cause.code === "INTEGRITY_FAILURE"
          ? "ARCHIVE_INTEGRITY_FAILURE"
          : "ARCHIVE_PREPARATION_FAILED";
      await step.do(
        `${stepPrefix}:record-preparation-failure`,
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          await coordinator.markWorkflowJobFailed(payload.archiveJobId, errorCode, Date.now());
          return { archiveJobId: payload.archiveJobId };
        },
      );
      throw cause;
    }
  }
}
