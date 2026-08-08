import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FileDown, PackageCheck, Plus, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { packDraftSchema, packIssueSchema, productionPacksSchema, type PackDraft } from "./schemas";

export function ProductionPacksPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const path = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/operations`;
  const packs = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["operations", projectId, "production-packs"],
    queryFn: () => apiRequest(`${path}/production-packs`, productionPacksSchema),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operations", projectId] });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`${path}/production-packs`, packDraftSchema, {
        method: "POST",
        body: jsonBody(body),
      }),
    onSuccess: () => {
      setCreating(false);
      void refresh();
    },
  });
  const issue = useMutation({
    mutationFn: ({ draft, correction }: { draft: PackDraft; correction: boolean }) =>
      apiRequest(
        `${path}/production-packs/${encodeURIComponent(draft.id)}/issue`,
        packIssueSchema,
        {
          method: "POST",
          headers: { "If-Match": `"${draft.version}"`, "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({ supersedesIssueId: correction ? draft.latestIssueId : null }),
        },
      ),
    onSuccess: refresh,
  });

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const pinIds = new Set(form.getAll("pinId").map(String));
    const fileIds = new Set(form.getAll("fileId").map(String));
    const pinnedArtifacts = (packs.data?.availablePins ?? [])
      .filter((pin) => pinIds.has(pin.id))
      .map((pin) => ({
        objectId: pin.id,
        revisionOrIssueId: isRevisionPin(pin.objectType) ? pin.domainId : null,
        sectionType: sectionFor(pin.objectType),
        title: pin.title,
        includeFile: true,
        permissionScope: sensitiveScope(pin.objectType),
      }));
    const pinnedFiles = (packs.data?.availableFiles ?? [])
      .filter((file) => fileIds.has(file.id))
      .map((file) => ({
        fileVersionId: file.id,
        sectionType: "attachments",
        title: `${file.title} — v${file.versionNumber}`,
        includeFile: true,
        permissionScope: "project",
      }));
    create.mutate({
      shootDayId: String(form.get("shootDayId") ?? "") || null,
      title: String(form.get("title") ?? ""),
      summary: String(form.get("summary") ?? ""),
      paperSize: "A4",
      confidentiality: "SINBOD WAYNE — INTERNAL",
      items: [...pinnedArtifacts, ...pinnedFiles],
    });
  }

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;
  return (
    <section className="project-page operations-page">
      <ProjectContextHeader
        project={activeProject}
        section="Documents"
        title="Production Packs"
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)} variant="primary">
            New pack
          </Button>
        }
      />
      <aside className="provider-notice">
        <TriangleAlert aria-hidden="true" />
        <div>
          <strong>Server ZIP assembly: Not configured</strong>
          <p>
            Immutable ordered manifests and deterministic print/Save-as-PDF are available. The UI
            does not claim a ZIP exists until R2 generation evidence is present.
          </p>
        </div>
      </aside>
      {packs.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : packs.isError ? (
        <SurfaceBoundary state="error" />
      ) : packs.data?.drafts.length ? (
        <div className="operations-stack">
          {packs.data.drafts.map((draft) => (
            <article className="operations-card" key={draft.id}>
              <header>
                <div>
                  <p>Production pack</p>
                  <h2>{draft.title}</h2>
                  <span>{draft.summary || "No summary"}</span>
                </div>
                <Status tone={draft.status === "issued" ? "success" : "warning"}>
                  {draft.status}
                </Status>
              </header>
              <dl className="issue-metrics">
                <div>
                  <dt>Pinned items</dt>
                  <dd>{draft.itemCount}</dd>
                </div>
                <div>
                  <dt>Issues</dt>
                  <dd>{draft.issueCount}</dd>
                </div>
                <div>
                  <dt>Paper</dt>
                  <dd>{draft.paperSize}</dd>
                </div>
                <div>
                  <dt>ZIP</dt>
                  <dd>
                    <Status tone="neutral">Not configured</Status>
                  </dd>
                </div>
              </dl>
              {draft.latestManifestHash ? (
                <p className="manifest-hash">
                  <strong>Latest manifest</strong>
                  <code>{draft.latestManifestHash}</code>
                </p>
              ) : null}
              <footer>
                <Button
                  disabled={issue.isPending}
                  icon={<PackageCheck />}
                  onClick={() => issue.mutate({ draft, correction: false })}
                  variant="primary"
                >
                  Issue pack
                </Button>
                {draft.latestIssueId ? (
                  <>
                    <Button
                      disabled={issue.isPending}
                      onClick={() => issue.mutate({ draft, correction: true })}
                    >
                      Issue correction
                    </Button>
                    <Link
                      className="swp-button swp-button--quiet"
                      target="_blank"
                      to={`/print/production_pack_issue/${encodeURIComponent(draft.latestIssueId)}`}
                    >
                      <FileDown aria-hidden="true" /> Print
                    </Link>
                    <a
                      className="swp-button swp-button--quiet"
                      href={`${path}/production-pack-issues/${encodeURIComponent(draft.latestIssueId)}/manifest.json`}
                    >
                      <Archive aria-hidden="true" /> Manifest
                    </a>
                  </>
                ) : null}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <SurfaceBoundary
          action={
            <Button onClick={() => setCreating(true)} variant="primary">
              Build the first pack
            </Button>
          }
          state="empty"
          title="No production packs"
        />
      )}
      {create.error || issue.error ? (
        <p className="form-error" role="alert">
          {(create.error ?? issue.error)?.message}
        </p>
      ) : null}
      {creating ? (
        <div className="modal-layer" role="presentation">
          <section
            aria-labelledby="pack-create-title"
            aria-modal="true"
            className="modal-card modal-card--wide"
            role="dialog"
          >
            <header>
              <div>
                <p>Ordered pinned sources</p>
                <h2 id="pack-create-title">Build production pack</h2>
              </div>
              <button aria-label="Close" onClick={() => setCreating(false)} type="button">
                ×
              </button>
            </header>
            <form onSubmit={submitCreate}>
              <div className="form-grid">
                <label>
                  Title
                  <input
                    autoFocus
                    maxLength={200}
                    minLength={2}
                    name="title"
                    placeholder="Shoot Day 1 production pack"
                    required
                  />
                </label>
                <label>
                  Shoot day
                  <select name="shootDayId">
                    <option value="">Project-wide pack</option>
                    {packs.data?.shootDays.map((day) => (
                      <option key={day.id} value={day.id}>
                        {day.shootDate ?? "No date"} · {day.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Summary
                <textarea maxLength={4_000} name="summary" rows={2} />
              </label>
              <fieldset>
                <legend>Issued records and approved plans</legend>
                <div className="choice-grid choice-grid--dense">
                  {packs.data?.availablePins.map((pin) => (
                    <label className="choice-row" key={pin.id}>
                      <input name="pinId" type="checkbox" value={pin.id} />
                      <span>
                        <strong>{pin.title}</strong>
                        <small>{pin.objectType.replaceAll("_", " ")}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Exact file versions</legend>
                <div className="choice-grid choice-grid--dense">
                  {packs.data?.availableFiles.map((file) => (
                    <label className="choice-row" key={file.id}>
                      <input name="fileId" type="checkbox" value={file.id} />
                      <span>
                        <strong>
                          {file.title} · v{file.versionNumber}
                        </strong>
                        <small>
                          {file.displayName} · {formatBytes(file.byteSize)} · scan{" "}
                          {file.scanState.replaceAll("_", " ")}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="field-help">
                Select at least one source. Every issued manifest pins immutable issue, revision,
                object, or file-version IDs.
              </p>
              <footer>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
                <Button disabled={create.isPending} type="submit" variant="primary">
                  {create.isPending ? "Building…" : "Create draft"}
                </Button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function isRevisionPin(type: string): boolean {
  return (
    type.endsWith("_revision") ||
    type.endsWith("_issue") ||
    type === "sides_issue" ||
    type === "report_snapshot"
  );
}
function sectionFor(type: string): string {
  if (type.includes("script") || type.includes("sides")) return "story-writing";
  if (type.includes("schedule")) return "schedule";
  if (type.includes("call_sheet")) return "call-sheets";
  if (type.includes("risk") || type.includes("requirement")) return "legal-safety";
  if (type.includes("shot") || type.includes("storyboard") || type.includes("technical"))
    return "visual-planning";
  return "project";
}
function sensitiveScope(type: string): "project" | "finance" | "legal" | "safety" {
  return type.includes("requirement") ? "legal" : type.includes("risk") ? "safety" : "project";
}
function formatBytes(value: number): string {
  return value < 1_024
    ? `${value} B`
    : value < 1_048_576
      ? `${(value / 1_024).toFixed(1)} KB`
      : `${(value / 1_048_576).toFixed(1)} MB`;
}
