import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Download,
  FileDiff,
  FileUp,
  LockKeyhole,
  Plus,
  Save,
} from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";

const blockTypeSchema = z.enum([
  "scene_heading",
  "action",
  "character",
  "parenthetical",
  "dialogue",
  "dual_dialogue",
  "transition",
  "shot",
  "lyrics",
  "page_break",
  "section",
  "synopsis",
  "note",
]);
const screenplaySchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
  saveState: z.string(),
  sceneNumbersLocked: z.boolean(),
  currentRevision: z
    .object({ id: z.string(), name: z.string(), colour: z.string(), issuedAt: z.number() })
    .nullable(),
  revisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      colour: z.string(),
      notes: z.string().nullable(),
      issuedAt: z.number(),
    }),
  ),
  scenes: z.array(
    z.object({
      id: z.string(),
      displayNumber: z.string(),
      slugline: z.string(),
      synopsis: z.string().nullable(),
      pageEighths: z.number(),
      omitted: z.boolean(),
      syncState: z.enum(["synced", "revised", "added", "ambiguous", "removed"]),
    }),
  ),
  blocks: z.array(
    z.object({
      id: z.string(),
      sceneId: z.string().nullable(),
      type: blockTypeSchema,
      text: z.string(),
      sortRank: z.string(),
      version: z.number(),
    }),
  ),
  syncPreview: z
    .object({
      id: z.string(),
      sourceRevisionName: z.string(),
      unresolved: z.number(),
      items: z.array(
        z.object({
          id: z.string(),
          incomingSceneId: z.string().nullable(),
          canonicalSceneId: z.string().nullable(),
          displayNumber: z.string().nullable(),
          classification: z.enum(["added", "matched", "revised", "moved", "ambiguous", "removed"]),
          summary: z.string(),
          downstreamImpact: z.array(z.string()),
          candidateSceneIds: z.array(z.string()),
          decision: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});

type Screenplay = z.infer<typeof screenplaySchema>;
type Block = Screenplay["blocks"][number];

export function ScreenplayPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const screenplay = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["screenplay", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay`,
        screenplaySchema,
      ),
  });
  const [selectedSceneId, setSelectedSceneId] = useState<string>();
  const [draftBlocks, setDraftBlocks] = useState<Block[]>([]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<ApiError>();
  const [reviewTab, setReviewTab] = useState<"sync" | "comments" | "revisions">("sync");

  useEffect(() => {
    if (!screenplay.data || dirty) return;
    const firstScene = selectedSceneId ?? screenplay.data.scenes[0]?.id;
    setSelectedSceneId(firstScene);
    setDraftBlocks(screenplay.data.blocks.filter((block) => block.sceneId === firstScene));
    setBaseVersion(screenplay.data.version);
  }, [dirty, screenplay.data, selectedSceneId]);

  const saveDraft = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/draft`,
        screenplaySchema,
        {
          method: "PATCH",
          headers: { "If-Match": `"${baseVersion}"` },
          body: jsonBody({ blocks: draftBlocks }),
        },
      ),
    onSuccess: async (data) => {
      setDirty(false);
      setConflict(undefined);
      setBaseVersion(data.version);
      await queryClient.setQueryData(["screenplay", projectId], data);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(error);
    },
  });

  useEffect(() => {
    if (!dirty || saveDraft.isPending || conflict) return;
    const timeout = window.setTimeout(() => saveDraft.mutate(), 800);
    return () => window.clearTimeout(timeout);
  }, [conflict, dirty, draftBlocks, saveDraft]);

  const createRevision = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/revisions`,
        z.object({ revisionId: z.string() }),
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({
            name: `Revision ${new Date().toLocaleDateString("en-GB")}`,
            notes: "Created from current draft",
            colour: "white",
          }),
        },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] }),
  });

  const addScene = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/scenes`,
        z.object({ created: z.literal(true), sceneId: z.string() }),
        { method: "POST" },
      ),
    onSuccess: async (value) => {
      setDirty(false);
      setSelectedSceneId(value.sceneId);
      await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
    },
  });

  const addBlock = useMutation({
    mutationFn: (sceneId: string) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/blocks`,
        z.object({ created: z.literal(true), blockId: z.string() }),
        { method: "POST", body: jsonBody({ sceneId, type: "action" }) },
      ),
    onSuccess: async () => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
    },
  });

  const resolveMapping = useMutation({
    mutationFn: (input: {
      mappingId: string;
      decision: "accept" | "remap" | "omit" | "archive";
      targetSceneId?: string;
      reason: string;
    }) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/sync/${encodeURIComponent(screenplay.data?.syncPreview?.id ?? "")}/mappings/${encodeURIComponent(input.mappingId)}`,
        z.object({ resolved: z.literal(true) }),
        {
          method: "PATCH",
          body: jsonBody({
            decision: input.decision,
            reason: input.reason,
            ...(input.targetSceneId ? { targetSceneId: input.targetSceneId } : {}),
          }),
        },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] }),
  });

  const applySync = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/sync/apply`,
        z.object({ applied: z.literal(true), syncId: z.string() }),
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({
            syncId: screenplay.data?.syncPreview?.id,
            decisions: screenplay.data?.syncPreview?.items.map((item) => ({
              itemId: item.id,
              decision: item.decision,
            })),
          }),
        },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] }),
  });

  const selectedScene = screenplay.data?.scenes.find((scene) => scene.id === selectedSceneId);
  const wordCount = useMemo(
    () =>
      draftBlocks.reduce(
        (total, block) => total + block.text.trim().split(/\s+/).filter(Boolean).length,
        0,
      ),
    [draftBlocks],
  );

  function selectScene(sceneId: string) {
    if (
      dirty &&
      !window.confirm("This scene still has unsaved edits. Discard them and open another scene?")
    )
      return;
    setDirty(false);
    setConflict(undefined);
    setSelectedSceneId(sceneId);
    setDraftBlocks(screenplay.data?.blocks.filter((block) => block.sceneId === sceneId) ?? []);
  }

  function updateBlock(blockId: string, patch: Partial<Pick<Block, "text" | "type">>) {
    setDraftBlocks((blocks) =>
      blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block)),
    );
    setDirty(true);
  }

  async function importScript(file?: File) {
    if (!file) return;
    const body = new FormData();
    body.set("file", file);
    await apiRequest(
      `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/import`,
      z.object({ imported: z.literal(true), warnings: z.array(z.string()) }),
      { method: "POST", body },
    );
    await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
  }

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  return (
    <section className="screenplay-page project-page">
      <ProjectContextHeader
        actions={
          <>
            <input
              accept=".fountain,.fdx,.txt,text/plain,application/xml"
              className="swp-visually-hidden"
              onChange={(event) => void importScript(event.currentTarget.files?.[0])}
              ref={uploadRef}
              type="file"
            />
            <Button icon={<FileUp />} onClick={() => uploadRef.current?.click()}>
              Import
            </Button>
            <Button
              icon={<Download />}
              onClick={() =>
                window.open(
                  `/api/v1/app/projects/${activeProject.id}/screenplay/export.fountain`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Export
            </Button>
            <Button
              disabled={createRevision.isPending || dirty}
              icon={<LockKeyhole />}
              onClick={() => createRevision.mutate()}
              variant="primary"
            >
              Create revision
            </Button>
          </>
        }
        project={activeProject}
        section="Writing"
        title="Screenplay"
      />
      {screenplay.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : screenplay.isError ? (
        <SurfaceBoundary state="error" />
      ) : screenplay.data ? (
        <div className="editor-frame">
          <aside className="editor-outline">
            <header>
              <div>
                <p>Outline</p>
                <strong>{screenplay.data.scenes.length} scenes</strong>
              </div>
              <IconButton
                disabled={addScene.isPending || dirty}
                label="Add scene"
                onClick={() => addScene.mutate()}
              >
                <Plus />
              </IconButton>
            </header>
            <ol>
              {screenplay.data.scenes.map((scene) => (
                <li key={scene.id}>
                  <button
                    aria-current={scene.id === selectedSceneId ? "true" : undefined}
                    onClick={() => selectScene(scene.id)}
                    type="button"
                  >
                    <span>{scene.displayNumber}</span>
                    <div>
                      <strong>{scene.slugline}</strong>
                      <small>
                        {scene.pageEighths}/8 page · {scene.synopsis ?? "No synopsis"}
                      </small>
                    </div>
                    <Status
                      tone={
                        scene.syncState === "synced"
                          ? "success"
                          : scene.syncState === "removed"
                            ? "danger"
                            : scene.syncState === "ambiguous"
                              ? "purple"
                              : "warning"
                      }
                    >
                      {scene.syncState}
                    </Status>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
          <main className="script-canvas">
            <header className="script-toolbar">
              <div>
                <strong>{selectedScene?.displayNumber ?? "—"}</strong>
                <span>{selectedScene?.slugline ?? "Select a scene"}</span>
              </div>
              <div className="save-state" aria-live="polite">
                <span>
                  {saveDraft.isPending
                    ? "Saving…"
                    : conflict
                      ? "Conflict"
                      : dirty
                        ? "Unsaved"
                        : "Saved"}
                </span>
                <span>{wordCount} words</span>
                <Button
                  disabled={!dirty || saveDraft.isPending}
                  icon={<Save />}
                  onClick={() => saveDraft.mutate()}
                  variant="quiet"
                >
                  Save
                </Button>
              </div>
            </header>
            {conflict ? (
              <div className="conflict-banner" role="alert">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>A newer version exists</strong>
                  <p>Your draft is preserved. Review both versions before applying either.</p>
                </div>
                <Button
                  onClick={() => {
                    setDirty(false);
                    setConflict(undefined);
                    void screenplay.refetch();
                  }}
                  variant="secondary"
                >
                  Load server version
                </Button>
              </div>
            ) : null}
            <div className="script-page" role="document">
              {draftBlocks.length ? (
                <>
                  {draftBlocks.map((block) => (
                    <div className={`script-block script-block--${block.type}`} key={block.id}>
                      <div className="script-block__controls">
                        <span>{block.type.replaceAll("_", " ")}</span>
                        <select
                          aria-label={`Block type for ${block.text.slice(0, 30) || "empty block"}`}
                          onChange={(event) =>
                            updateBlock(block.id, {
                              type: blockTypeSchema.parse(event.currentTarget.value),
                            })
                          }
                          value={block.type}
                        >
                          {blockTypeSchema.options.map((option) => (
                            <option key={option} value={option}>
                              {option.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        aria-label={`${block.type.replaceAll("_", " ")} text`}
                        onChange={(event) =>
                          updateBlock(block.id, { text: event.currentTarget.value })
                        }
                        rows={Math.max(1, Math.ceil(block.text.length / 72))}
                        value={block.text}
                      />
                    </div>
                  ))}
                  <div className="script-page__actions">
                    <Button
                      disabled={!selectedSceneId || addBlock.isPending || dirty}
                      icon={<Plus />}
                      onClick={() => selectedSceneId && addBlock.mutate(selectedSceneId)}
                      variant="quiet"
                    >
                      {dirty ? "Save before adding a block" : "Add block"}
                    </Button>
                  </div>
                </>
              ) : (
                <SurfaceBoundary
                  action={
                    <Button
                      disabled={addScene.isPending}
                      icon={<Plus />}
                      onClick={() => addScene.mutate()}
                      variant="primary"
                    >
                      {addScene.isPending ? "Adding scene…" : "Add first scene"}
                    </Button>
                  }
                  description="Import a screenplay or add a structured scene block."
                  state="empty"
                  title="This scene is empty"
                />
              )}
            </div>
          </main>
          <aside className="review-panel">
            <div className="review-tabs" role="tablist">
              <button
                aria-selected={reviewTab === "sync"}
                onClick={() => setReviewTab("sync")}
                role="tab"
                type="button"
              >
                Sync review
              </button>
              <button
                aria-selected={reviewTab === "comments"}
                onClick={() => setReviewTab("comments")}
                role="tab"
                type="button"
              >
                Comments
              </button>
              <button
                aria-selected={reviewTab === "revisions"}
                onClick={() => setReviewTab("revisions")}
                role="tab"
                type="button"
              >
                Revisions
              </button>
            </div>
            {reviewTab === "sync" ? (
              <SyncPanel
                data={screenplay.data}
                applying={applySync.isPending}
                onApply={() => applySync.mutate()}
                onResolve={(input) => resolveMapping.mutate(input)}
                resolving={resolveMapping.isPending}
              />
            ) : reviewTab === "revisions" ? (
              <ol className="revision-list">
                {screenplay.data.revisions.map((revision) => (
                  <li key={revision.id}>
                    <span style={{ backgroundColor: revision.colour }} />
                    <div>
                      <strong>{revision.name}</strong>
                      <small>
                        {new Intl.DateTimeFormat("en-GB", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(revision.issuedAt)}
                      </small>
                    </div>
                    <IconButton label={`Compare ${revision.name}`}>
                      <FileDiff />
                    </IconButton>
                  </li>
                ))}
              </ol>
            ) : (
              <SurfaceBoundary
                description="Select a stable block range to start a comment thread."
                state="empty"
                title="No comments on this selection"
              />
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function SyncPanel({
  applying,
  data,
  onApply,
  onResolve,
  resolving,
}: {
  readonly applying: boolean;
  readonly data: Screenplay;
  readonly onApply: () => void;
  readonly onResolve: (input: {
    mappingId: string;
    decision: "accept" | "remap" | "omit" | "archive";
    targetSceneId?: string;
    reason: string;
  }) => void;
  readonly resolving: boolean;
}) {
  if (!data.syncPreview)
    return (
      <SurfaceBoundary
        description="Draft save and production sync are separate. Create a revision to preview downstream changes."
        state="empty"
        title="No sync awaiting review"
      />
    );
  return (
    <div className="sync-review">
      <header>
        <div>
          <p>Incoming</p>
          <h2>{data.syncPreview.sourceRevisionName}</h2>
        </div>
        <Status tone={data.syncPreview.unresolved ? "warning" : "success"}>
          {data.syncPreview.unresolved ? `${data.syncPreview.unresolved} unresolved` : "Resolved"}
        </Status>
      </header>
      <ol>
        {data.syncPreview.items.map((item) => (
          <li className={`sync-item sync-item--${item.classification}`} key={item.id}>
            <div>
              <Status
                tone={
                  item.classification === "removed"
                    ? "danger"
                    : item.classification === "ambiguous"
                      ? "purple"
                      : item.classification === "added"
                        ? "info"
                        : "warning"
                }
              >
                {item.classification}
              </Status>
              <strong>
                {item.displayNumber ?? "—"} · {item.summary}
              </strong>
            </div>
            {item.downstreamImpact.length ? (
              <ul>
                {item.downstreamImpact.map((impact) => (
                  <li key={impact}>{impact}</li>
                ))}
              </ul>
            ) : (
              <small>No downstream work yet.</small>
            )}
            {item.decision ? (
              <small>Decision: {item.decision}</small>
            ) : item.classification === "removed" ? (
              <div className="sync-decision-actions">
                <Button
                  disabled={resolving}
                  onClick={() =>
                    onResolve({
                      mappingId: item.id,
                      decision: "omit",
                      reason: "Retain downstream work on an omitted canonical scene.",
                    })
                  }
                  variant="quiet"
                >
                  Retain omitted
                </Button>
                <Button
                  disabled={resolving}
                  onClick={() =>
                    onResolve({
                      mappingId: item.id,
                      decision: "archive",
                      reason: "Archive the removed canonical scene and preserve its history.",
                    })
                  }
                  variant="quiet"
                >
                  Archive scene
                </Button>
              </div>
            ) : item.classification === "ambiguous" ? (
              <div className="sync-decision-actions">
                <Button
                  disabled={resolving}
                  onClick={() =>
                    onResolve({
                      mappingId: item.id,
                      decision: "accept",
                      reason: "Reviewed as a distinct new canonical scene.",
                    })
                  }
                  variant="quiet"
                >
                  Keep as new
                </Button>
                {item.candidateSceneIds.map((candidateId, index) => (
                  <Button
                    disabled={resolving}
                    key={candidateId}
                    onClick={() =>
                      onResolve({
                        mappingId: item.id,
                        decision: "remap",
                        targetSceneId: candidateId,
                        reason:
                          "Manually matched after reviewing the incoming and canonical scene.",
                      })
                    }
                    variant="quiet"
                  >
                    Map to candidate {index + 1}
                  </Button>
                ))}
              </div>
            ) : (
              <span className="sync-auto-decision">
                Mapping reviewed automatically <ChevronRight aria-hidden="true" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <footer>
        <p>
          {data.syncPreview.unresolved
            ? "Resolve every ambiguous or removed scene decision before apply."
            : "Apply is transactional and preserves canonical scene links."}
        </p>
        <Button
          disabled={data.syncPreview.unresolved > 0 || applying}
          icon={<FileDiff />}
          onClick={onApply}
          variant="primary"
        >
          {applying ? "Applying…" : "Apply production sync"}
        </Button>
      </footer>
    </div>
  );
}
