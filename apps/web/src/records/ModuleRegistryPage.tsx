import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Filter, MoreHorizontal, Plus, RotateCcw, Search } from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { findModule } from "../app/module-catalog";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { domainRecordListSchema, domainRecordSchema, type DomainRecord } from "../app/schemas";
import { ObjectCollaborationPanel } from "../collaboration/ObjectCollaborationPanel";
import { queueOfflineDraft, supportsOfflineDraft } from "../offline/database";
import { useOfflineDrafts } from "../offline/useOfflineDrafts";
import { fieldsForRecord, fieldValueForInput } from "./field-catalog";
import { RecordDetailFields } from "./RecordDetailFields";

interface SaveInput {
  id?: string;
  title: string;
  status: string;
  summary: string;
  details: Record<string, unknown>;
  version?: number;
}

interface PendingConflict {
  local: SaveInput;
  server: DomainRecord;
}

export function ModuleRegistryPage() {
  const { projectId, moduleKey } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const module = findModule(moduleKey);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [editor, setEditor] = useState<DomainRecord | "new">();
  const [pendingConflict, setPendingConflict] = useState<PendingConflict>();

  const recordType = module?.recordType ?? "";
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/records/${encodeURIComponent(recordType)}`;
  const offline = useOfflineDrafts(projectId, recordType);
  const records = useQuery({
    enabled: Boolean(projectId && module?.recordType),
    queryKey: ["records", projectId, module?.recordType, search, status],
    queryFn: () =>
      apiRequest(
        `${endpoint}?limit=100&q=${encodeURIComponent(search)}&state=${encodeURIComponent(status)}`,
        domainRecordListSchema,
      ),
  });
  const save = useMutation({
    mutationFn: async (input: SaveInput) => {
      if (input.id) {
        return apiRequest(`${endpoint}/${encodeURIComponent(input.id)}`, domainRecordSchema, {
          method: "PATCH",
          headers: { "If-Match": `"${input.version ?? 0}"` },
          body: jsonBody({
            title: input.title,
            status: input.status,
            summary: input.summary,
            details: input.details,
          }),
        });
      }
      return apiRequest(endpoint, domainRecordSchema, {
        method: "POST",
        body: jsonBody({
          title: input.title,
          status: input.status,
          summary: input.summary,
          details: input.details,
        }),
      });
    },
    onError: (error, input) => {
      if (error instanceof ApiError && error.status === 409) {
        const current = domainRecordSchema.safeParse(
          (error.details as { current?: unknown } | undefined)?.current,
        );
        if (current.success) setPendingConflict({ local: input, server: current.data });
      }
    },
    onSuccess: async () => {
      setEditor(undefined);
      setPendingConflict(undefined);
      await queryClient.invalidateQueries({ queryKey: ["records", projectId, module?.recordType] });
    },
  });
  const archive = useMutation({
    mutationFn: (record: DomainRecord) =>
      apiRequest(
        `${endpoint}/${encodeURIComponent(record.id)}/${record.archivedAt ? "restore" : "archive"}`,
        z.object({ changed: z.literal(true) }),
        { method: "POST", headers: { "If-Match": `"${record.version}"` } },
      ),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["records", projectId, module?.recordType] }),
  });

  const filtered = useMemo(() => records.data?.items ?? [], [records.data?.items]);

  if (!activeProject || !module || !module.recordType)
    return <SurfaceBoundary state="error" title="Unknown module" />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = editor === "new" ? undefined : editor;
    const details = { ...(current?.details ?? {}) };
    for (const field of fieldsForRecord(recordType))
      details[field.key] = fieldValueForInput(field, form.get(`details.${field.key}`));
    const input: SaveInput = {
      ...(current ? { id: current.id, version: current.version } : {}),
      title: String(form.get("title") ?? ""),
      status: String(form.get("status") ?? "draft"),
      summary: String(form.get("summary") ?? ""),
      details,
    };
    if (!offline.online && projectId && supportsOfflineDraft(recordType)) {
      await queueOfflineDraft({
        projectId,
        recordType,
        endpoint,
        ...(current ? { recordId: current.id, baseVersion: current.version } : {}),
        payload: {
          title: input.title,
          status: input.status,
          summary: input.summary,
          details: input.details,
        },
      });
      setEditor(undefined);
      return;
    }
    save.mutate(input);
  }

  const canDraftOffline = supportsOfflineDraft(recordType);

  return (
    <section className="project-page">
      <ProjectContextHeader
        actions={
          <>
            <Button
              icon={<Download />}
              onClick={() =>
                window.open(
                  `${endpoint}/export.csv?state=${encodeURIComponent(status)}`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Export CSV
            </Button>
            <Button
              disabled={!offline.online && !canDraftOffline}
              icon={<Plus />}
              onClick={() => setEditor("new")}
              variant="primary"
            >
              New {module.singular}
            </Button>
          </>
        }
        project={activeProject}
        section={module.title}
        title={module.title}
      />
      <div className="page-intro">
        <p>{module.description}</p>
      </div>
      {!offline.online && !canDraftOffline ? (
        <div className="offline-banner" role="status">
          <strong>Offline read-only</strong>
          <span>This module requires a connection. No change will be presented as saved.</span>
        </div>
      ) : !offline.online ? (
        <div className="offline-banner" role="status">
          <strong>Offline drafting</strong>
          <span>
            Changes stay on this device with their base version and will be checked for conflicts on
            reconnect.
          </span>
        </div>
      ) : null}
      {offline.drafts.length > 0 ? (
        <section aria-label="Local offline drafts" className="offline-drafts">
          <header>
            <strong>Local drafts</strong>
            <span>{offline.drafts.length} awaiting review or sync</span>
          </header>
          {offline.drafts.map((draft) => (
            <article className={`offline-draft offline-draft--${draft.state}`} key={draft.id}>
              <div>
                <Status
                  tone={
                    draft.state === "conflict"
                      ? "danger"
                      : draft.state === "failed"
                        ? "warning"
                        : "info"
                  }
                >
                  {draft.state}
                </Status>
                <strong>{draft.payload.title}</strong>
                <span>
                  {draft.error ??
                    (draft.state === "queued"
                      ? "Held safely on this device."
                      : "Sync in progress.")}
                </span>
              </div>
              {draft.state === "conflict" && draft.serverRecord ? (
                <div className="conflict-compare">
                  <section>
                    <span>Your offline draft</span>
                    <strong>{draft.payload.title}</strong>
                    <p>{draft.payload.summary || "No summary"}</p>
                  </section>
                  <section>
                    <span>Current server version</span>
                    <strong>{draft.serverRecord.title}</strong>
                    <p>{draft.serverRecord.summary || "No summary"}</p>
                  </section>
                </div>
              ) : null}
              <footer>
                {draft.state === "conflict" && draft.serverRecord ? (
                  <Button onClick={() => void offline.keepLocal(draft)} variant="primary">
                    Use my draft on current version
                  </Button>
                ) : null}
                {(draft.state === "failed" || draft.state === "queued") && offline.online ? (
                  <Button onClick={() => void offline.retry(draft)}>Retry sync</Button>
                ) : null}
                <Button onClick={() => void offline.discard(draft.id)} variant="quiet">
                  {draft.state === "conflict"
                    ? "Keep server and discard mine"
                    : "Discard local draft"}
                </Button>
              </footer>
            </article>
          ))}
        </section>
      ) : null}
      <div className="registry-toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="swp-visually-hidden">Search {module.title}</span>
          <input
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={`Search ${module.title.toLowerCase()}`}
            value={search}
          />
        </label>
        <label className="filter-select">
          <Filter aria-hidden="true" />
          <span className="swp-visually-hidden">Record state</span>
          <select onChange={(event) => setStatus(event.currentTarget.value)} value={status}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
        <span className="registry-count">{records.data?.total ?? 0} records</span>
      </div>
      {records.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : records.isError ? (
        <SurfaceBoundary state="error" />
      ) : filtered.length ? (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead>
              <tr>
                <th>{module.singular}</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Updated</th>
                <th>
                  <span className="swp-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => (
                <tr className={record.archivedAt ? "record-row--archived" : ""} key={record.id}>
                  <th data-label={module.singular} scope="row">
                    <button
                      className="record-title"
                      onClick={() => setEditor(record)}
                      type="button"
                    >
                      <strong>{record.title}</strong>
                      <span>{record.summary || "No summary"}</span>
                    </button>
                  </th>
                  <td data-label="Status">
                    <Status
                      tone={
                        record.status === "approved" ||
                        record.status === "confirmed" ||
                        record.status === "booked"
                          ? "success"
                          : record.status === "blocked"
                            ? "danger"
                            : "info"
                      }
                    >
                      {record.status.replaceAll("_", " ")}
                    </Status>
                  </td>
                  <td data-label="Owner">{record.ownerDisplayName ?? "Unassigned"}</td>
                  <td data-label="Updated">
                    <time dateTime={new Date(record.updatedAt).toISOString()}>
                      {new Intl.DateTimeFormat("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(record.updatedAt)}
                    </time>
                  </td>
                  <td data-label="Actions">
                    <IconButton
                      label={
                        record.archivedAt ? `Restore ${record.title}` : `Archive ${record.title}`
                      }
                      onClick={() => archive.mutate(record)}
                    >
                      {record.archivedAt ? <RotateCcw /> : <Archive />}
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <SurfaceBoundary
          action={
            <Button
              disabled={!offline.online && !canDraftOffline}
              icon={<Plus />}
              onClick={() => setEditor("new")}
              variant="primary"
            >
              Create {module.singular}
            </Button>
          }
          description={
            search
              ? "Clear or change the active filters."
              : `Create the first ${module.singular} for this production.`
          }
          state="empty"
          title={search ? "No matching records" : `No ${module.title.toLowerCase()} yet`}
        />
      )}
      {editor ? (
        <div className="drawer-layer">
          <button
            aria-label="Close editor"
            className="drawer-scrim"
            onClick={() => {
              setEditor(undefined);
              setPendingConflict(undefined);
            }}
            type="button"
          />
          <div
            aria-labelledby="record-editor-title"
            aria-modal="true"
            className="record-editor"
            role="dialog"
          >
            <header>
              <div>
                <p>{editor === "new" ? "Create" : "Edit"}</p>
                <h2 id="record-editor-title">{module.singular}</h2>
              </div>
              <IconButton
                label="Close editor"
                onClick={() => {
                  setEditor(undefined);
                  setPendingConflict(undefined);
                }}
              >
                <MoreHorizontal />
              </IconButton>
            </header>
            <form className="record-editor__form" onSubmit={(event) => void submit(event)}>
              <label>
                <span>Title</span>
                <input
                  autoFocus
                  defaultValue={editor === "new" ? "" : editor.title}
                  minLength={2}
                  name="title"
                  required
                />
              </label>
              <label>
                <span>Status</span>
                <select defaultValue={editor === "new" ? "draft" : editor.status} name="status">
                  <option value="draft">Draft</option>
                  <option value="in_review">In review</option>
                  <option value="approved">Approved</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="blocked">Blocked</option>
                  <option value="superseded">Superseded</option>
                </select>
              </label>
              <label>
                <span>Summary</span>
                <textarea
                  defaultValue={editor === "new" ? "" : (editor.summary ?? "")}
                  name="summary"
                  rows={8}
                />
              </label>
              <RecordDetailFields
                details={editor === "new" ? {} : editor.details}
                recordType={recordType}
              />
              {pendingConflict ? (
                <div className="form-conflict" role="alert">
                  <strong>Another session changed this record</strong>
                  <p>
                    Both versions are preserved below. Choose explicitly; the app will not silently
                    overwrite either one.
                  </p>
                  <div className="conflict-compare">
                    <section>
                      <span>Your changes</span>
                      <strong>{pendingConflict.local.title}</strong>
                      <p>{pendingConflict.local.summary || "No summary"}</p>
                    </section>
                    <section>
                      <span>Current server version</span>
                      <strong>{pendingConflict.server.title}</strong>
                      <p>{pendingConflict.server.summary || "No summary"}</p>
                    </section>
                  </div>
                  <div className="form-conflict__actions">
                    <Button
                      onClick={() =>
                        save.mutate({
                          ...pendingConflict.local,
                          version: pendingConflict.server.version,
                        })
                      }
                      variant="primary"
                    >
                      Use my changes
                    </Button>
                    <Button
                      onClick={() => {
                        setEditor(pendingConflict.server);
                        setPendingConflict(undefined);
                      }}
                      variant="quiet"
                    >
                      Keep server version
                    </Button>
                  </div>
                </div>
              ) : save.isError ? (
                <p className="form-error" role="alert">
                  The record could not be saved. Your form remains open.
                </p>
              ) : null}
              <footer>
                <Button
                  onClick={() => {
                    setEditor(undefined);
                    setPendingConflict(undefined);
                  }}
                  variant="quiet"
                >
                  Cancel
                </Button>
                <Button
                  disabled={save.isPending || (!offline.online && !canDraftOffline)}
                  type="submit"
                  variant="primary"
                >
                  {save.isPending ? "Saving…" : !offline.online ? "Save offline draft" : "Save"}
                </Button>
              </footer>
            </form>
            {editor !== "new" && projectId ? (
              <ObjectCollaborationPanel
                objectId={editor.id}
                objectType={recordType}
                projectId={projectId}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
