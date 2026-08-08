import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, HardDriveDownload, RefreshCw, ShieldCheck } from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";

const jobSchema = z.object({
  id: z.string(),
  snapshotId: z.string(),
  title: z.string(),
  status: z.enum(["requested", "running", "verifying", "verified", "failed"]),
  attemptCount: z.number(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  retryable: z.boolean(),
  manifestHash: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  verifiedAt: z.number().nullable(),
});
const jobsSchema = z.object({ items: z.array(jobSchema) });

export function ExportsArchivePage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/archive`;
  const jobs = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["archive-jobs", projectId],
    queryFn: () => apiRequest(`${endpoint}/jobs`, jobsSchema),
    refetchInterval: 15_000,
  });
  const request = useMutation({
    mutationFn: () =>
      apiRequest(`${endpoint}/jobs`, jobSchema, {
        method: "POST",
        headers: { "Idempotency-Key": `archive-request:${crypto.randomUUID()}` },
        body: jsonBody({ fileVersionScope: "all" }),
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["archive-jobs", projectId] }),
  });

  if (!activeProject || !projectId)
    return <SurfaceBoundary state="error" title="Project unavailable" />;

  return (
    <section className="project-page archive-page">
      <ProjectContextHeader
        actions={
          <Button
            disabled={request.isPending}
            icon={<Archive />}
            onClick={() => request.mutate()}
            variant="primary"
          >
            {request.isPending ? "Preparing…" : "Archive to NAS"}
          </Button>
        }
        project={activeProject}
        section="Documents"
        title="Exports & Archive"
      />
      <div className="page-intro">
        <p>
          Create an immutable complete-project export, then let the outbound-only NAS agent lease,
          download, verify and acknowledge it. Archive never deletes cloud data.
        </p>
      </div>
      <section className="archive-protocol" aria-label="Archive protocol">
        <div>
          <Archive aria-hidden="true" />
          <strong>1. Snapshot</strong>
          <span>
            Structured project data and exact file versions are pinned in private storage.
          </span>
        </div>
        <div>
          <HardDriveDownload aria-hidden="true" />
          <strong>2. Outbound pull</strong>
          <span>The NAS agent connects outward; no NAS port or admin interface is exposed.</span>
        </div>
        <div>
          <ShieldCheck aria-hidden="true" />
          <strong>3. Verify</strong>
          <span>Every size and SHA-256 must match before the job can become Verified.</span>
        </div>
      </section>
      {request.isError ? (
        <p className="form-error" role="alert">
          The export could not be prepared. No archive verification was claimed.
        </p>
      ) : null}
      {jobs.isLoading ? (
        <SurfaceBoundary state="loading" title="Loading archive history" />
      ) : jobs.isError ? (
        <SurfaceBoundary
          action={
            <Button icon={<RefreshCw />} onClick={() => void jobs.refetch()}>
              Retry
            </Button>
          }
          state="error"
          title="Archive history unavailable"
        />
      ) : jobs.data?.items.length ? (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>Snapshot</th>
                <th>State</th>
                <th>Attempts</th>
                <th>Requested</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.items.map((job) => (
                <tr key={job.id}>
                  <th data-label="Snapshot" scope="row">
                    <strong>{job.title}</strong>
                    <span className="archive-hash">
                      {job.manifestHash ? `${job.manifestHash.slice(0, 16)}…` : "Manifest pending"}
                    </span>
                  </th>
                  <td data-label="State">
                    <Status
                      tone={
                        job.status === "verified"
                          ? "success"
                          : job.status === "failed"
                            ? "danger"
                            : job.status === "verifying"
                              ? "warning"
                              : "info"
                      }
                    >
                      {job.status}
                    </Status>
                    {job.lastErrorMessage ? <small>{job.lastErrorMessage}</small> : null}
                  </td>
                  <td data-label="Attempts">{job.attemptCount}</td>
                  <td data-label="Requested">
                    <time dateTime={new Date(job.createdAt).toISOString()}>
                      {formatDate(job.createdAt)}
                    </time>
                  </td>
                  <td data-label="Evidence">
                    <div className="archive-downloads">
                      <a
                        className="swp-button swp-button--quiet"
                        href={`${endpoint}/snapshots/${encodeURIComponent(job.snapshotId)}/body`}
                      >
                        <Download aria-hidden="true" />
                        Project JSON
                      </a>
                      <a
                        className="swp-button swp-button--quiet"
                        href={`${endpoint}/snapshots/${encodeURIComponent(job.snapshotId)}/manifest`}
                      >
                        <Download aria-hidden="true" />
                        Manifest
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <SurfaceBoundary
          description="Request the first immutable export when the project is ready for a private NAS archive."
          state="empty"
          title="No archive jobs yet"
        />
      )}
      <aside className="archive-separation">
        <strong>Archive, Verify and Delete are separate actions.</strong>
        <p>
          Cloud copies remain in place after verification. Owner-only removal is available per
          archived file only after retention and legal-hold checks pass and every immutable version
          has verified NAS evidence.
        </p>
      </aside>
    </section>
  );
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
