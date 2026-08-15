import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileDiff,
  FileUp,
  LockKeyhole,
  Plus,
  Printer,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { useAuth } from "../auth/auth-context";

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
      syncState: z.enum(["synced", "matched", "revised", "moved", "added", "ambiguous", "removed"]),
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
type BlockType = Block["type"];
type ReviewTab = "notes" | "revisions" | "sync";

const elementShortcuts: readonly { type: BlockType; label: string; shortcut: string }[] = [
  { type: "scene_heading", label: "Scene", shortcut: "1" },
  { type: "action", label: "Action", shortcut: "2" },
  { type: "character", label: "Character", shortcut: "3" },
  { type: "parenthetical", label: "Parenthetical", shortcut: "4" },
  { type: "dialogue", label: "Dialogue", shortcut: "5" },
  { type: "transition", label: "Transition", shortcut: "6" },
  { type: "shot", label: "Shot", shortcut: "7" },
  { type: "note", label: "Note", shortcut: "8" },
];

export function ProfessionalScreenplayPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const auth = useAuth();
  const canEdit = auth.account?.role !== "viewer";
  const queryClient = useQueryClient();
  const uploadRef = useRef<HTMLInputElement>(null);
  const blockRefs = useRef(new Map<string, HTMLTextAreaElement>());
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
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [draftBlocks, setDraftBlocks] = useState<Block[]>([]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<ApiError>();
  const [operationError, setOperationError] = useState<string>();
  const [reviewTab, setReviewTab] = useState<ReviewTab>("notes");
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findCursor, setFindCursor] = useState(-1);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionName, setRevisionName] = useState("");
  const [revisionColour, setRevisionColour] = useState("white");
  const [revisionNotes, setRevisionNotes] = useState("");

  useEffect(() => {
    if (!screenplay.data || dirty) return;
    setDraftBlocks(screenplay.data.blocks);
    setBaseVersion(screenplay.data.version);
    setSelectedSceneId((current) => current ?? screenplay.data.scenes[0]?.id);
  }, [dirty, screenplay.data]);

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
    onSuccess: (data) => {
      setDirty(false);
      setConflict(undefined);
      setBaseVersion(data.version);
      setDraftBlocks(data.blocks);
      setOperationError(undefined);
      queryClient.setQueryData(["screenplay", projectId], data);
      void queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setConflict(error);
      else setOperationError(messageFor(error, "The screenplay could not be saved."));
    },
  });

  useEffect(() => {
    if (!canEdit || !dirty || saveDraft.isPending || conflict || !draftBlocks.length) return;
    const timeout = window.setTimeout(() => saveDraft.mutate(), 1200);
    return () => window.clearTimeout(timeout);
  }, [canEdit, conflict, dirty, draftBlocks, saveDraft]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLocaleLowerCase("en-GB") === "s" && canEdit && dirty) {
        event.preventDefault();
        saveDraft.mutate();
      }
      if (event.key.toLocaleLowerCase("en-GB") === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
      const blockType = elementShortcuts.find((item) => item.shortcut === event.key)?.type;
      if (blockType && selectedBlockId && canEdit) {
        event.preventDefault();
        updateBlock(selectedBlockId, { type: blockType });
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  const addScene = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/scenes`,
        z.object({ created: z.literal(true), sceneId: z.string() }),
        { method: "POST" },
      ),
    onSuccess: async (value) => {
      setOperationError(undefined);
      setSelectedSceneId(value.sceneId);
      await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
      window.setTimeout(() => scrollToScene(value.sceneId), 100);
    },
    onError: (error) => setOperationError(messageFor(error, "The scene could not be added.")),
  });

  const addBlock = useMutation({
    mutationFn: (input: { sceneId: string; type: BlockType; afterBlockId?: string }) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/blocks`,
        z.object({ created: z.literal(true), blockId: z.string() }),
        { method: "POST", body: jsonBody(input) },
      ),
    onSuccess: async (value) => {
      setOperationError(undefined);
      setSelectedBlockId(value.blockId);
      await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
      window.setTimeout(() => blockRefs.current.get(value.blockId)?.focus(), 100);
    },
    onError: (error) => setOperationError(messageFor(error, "The element could not be added.")),
  });

  const deleteBlock = useMutation({
    mutationFn: (blockId: string) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/blocks/${encodeURIComponent(blockId)}`,
        z.object({ deleted: z.literal(true) }),
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      setOperationError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] }),
      ]);
    },
    onError: (error) => setOperationError(messageFor(error, "The element could not be deleted.")),
  });

  const createRevision = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/revisions`,
        z.object({ revisionId: z.string() }),
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({ name: revisionName, notes: revisionNotes, colour: revisionColour }),
        },
      ),
    onSuccess: async () => {
      setRevisionOpen(false);
      setRevisionName("");
      setRevisionNotes("");
      await queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] });
    },
  });

  const resolveMapping = useMutation({
    mutationFn: (input: {
      mappingId: string;
      decision: "accept" | "omit" | "archive";
      reason: string;
    }) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/sync/${encodeURIComponent(screenplay.data?.syncPreview?.id ?? "")}/mappings/${encodeURIComponent(input.mappingId)}`,
        z.object({ resolved: z.literal(true) }),
        { method: "PATCH", body: jsonBody({ decision: input.decision, reason: input.reason }) },
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

  const characters = useMemo(
    () =>
      [
        ...new Set(
          draftBlocks
            .filter((block) => block.type === "character")
            .map((block) => block.text.trim())
            .filter(Boolean),
        ),
      ].sort(),
    [draftBlocks],
  );
  const findMatches = useMemo(() => {
    const query = findText.trim().toLocaleLowerCase("en-GB");
    return query
      ? draftBlocks.filter((block) => block.text.toLocaleLowerCase("en-GB").includes(query))
      : [];
  }, [draftBlocks, findText]);
  const selectedScene = screenplay.data?.scenes.find((scene) => scene.id === selectedSceneId);
  const selectedBlock = draftBlocks.find((block) => block.id === selectedBlockId);
  const wordCount = draftBlocks.reduce((total, block) => total + wordsIn(block.text), 0);
  const pageEighths =
    screenplay.data?.scenes.reduce(
      (total, scene) => total + (scene.omitted ? 0 : scene.pageEighths),
      0,
    ) ?? 0;

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  function updateBlock(blockId: string, patch: Partial<Pick<Block, "text" | "type">>) {
    if (!canEdit) return;
    setDraftBlocks((blocks) =>
      blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block)),
    );
    setDirty(true);
  }

  async function addElement(sceneId: string, type: BlockType, afterBlockId?: string) {
    if (!canEdit || conflict) return;
    try {
      if (dirty) await saveDraft.mutateAsync();
      await addBlock.mutateAsync({ sceneId, type, ...(afterBlockId ? { afterBlockId } : {}) });
    } catch {
      // Mutation callbacks keep the recoverable error on-screen. Swallow the
      // rejected promise here so keyboard insertion cannot trigger a runtime overlay.
    }
  }

  function selectScene(sceneId: string) {
    setSelectedSceneId(sceneId);
    scrollToScene(sceneId);
  }

  function nextFind(direction: -1 | 1) {
    if (!findMatches.length) return;
    const next = (findCursor + direction + findMatches.length) % findMatches.length;
    setFindCursor(next);
    const match = findMatches[next];
    if (match) {
      setSelectedSceneId(match.sceneId ?? undefined);
      setSelectedBlockId(match.id);
      blockRefs.current.get(match.id)?.focus();
    }
  }

  function blockKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>, block: Block) {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || !canEdit)
      return;
    const end = event.currentTarget.value.length;
    if (event.currentTarget.selectionStart !== end || event.currentTarget.selectionEnd !== end)
      return;
    event.preventDefault();
    if (block.sceneId) void addElement(block.sceneId, nextElement(block.type), block.id);
  }

  async function importScript(file?: File) {
    if (!file || !canEdit) return;
    const body = new FormData();
    body.set("file", file);
    try {
      await apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay/import`,
        z.object({ imported: z.literal(true), warnings: z.array(z.string()) }),
        { method: "POST", body },
      );
      setOperationError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["screenplay", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] }),
      ]);
    } catch (error) {
      setOperationError(messageFor(error, "The screenplay import could not be completed."));
    }
  }

  return (
    <section className="project-page professional-screenplay">
      <ProjectContextHeader
        actions={
          <>
            {canEdit ? (
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
              </>
            ) : null}
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
              Fountain
            </Button>
            <Button icon={<Printer />} onClick={() => window.print()}>
              Print
            </Button>
            {canEdit ? (
              <Button
                disabled={dirty}
                icon={<LockKeyhole />}
                onClick={() => {
                  setRevisionName(
                    `Revision ${screenplay.data ? screenplay.data.revisions.length + 1 : 1}`,
                  );
                  setRevisionOpen(true);
                }}
                variant="primary"
              >
                Create revision
              </Button>
            ) : null}
          </>
        }
        creativeModule="screenplay"
        project={activeProject}
        section="Writing"
        title="Screenplay"
      />
      {screenplay.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : screenplay.isError ? (
        <SurfaceBoundary state="error" />
      ) : screenplay.data ? (
        <div className="screenplay-studio">
          <aside className="screenplay-scenes">
            <header>
              <div>
                <p>Scene navigator</p>
                <strong>{screenplay.data.scenes.length} scenes</strong>
              </div>
              {canEdit ? (
                <IconButton
                  disabled={addScene.isPending || dirty}
                  label="Add scene"
                  onClick={() => addScene.mutate()}
                >
                  <Plus />
                </IconButton>
              ) : null}
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
                    <i data-state={scene.syncState} title={`Scene is ${scene.syncState}`} />
                  </button>
                </li>
              ))}
            </ol>
            <footer>
              <span>
                {Math.floor(pageEighths / 8)} {pageEighths % 8}/8 pages
              </span>
              <span>
                {screenplay.data.sceneNumbersLocked ? "Numbers locked" : "Numbers unlocked"}
              </span>
            </footer>
          </aside>
          <main className="screenplay-document">
            <header className="screenplay-toolbar">
              <div
                className="screenplay-toolbar__elements"
                role="toolbar"
                aria-label="Screenplay elements"
              >
                {elementShortcuts.map((item) => (
                  <button
                    className={selectedBlock?.type === item.type ? "is-active" : ""}
                    disabled={!canEdit || !selectedSceneId}
                    key={item.type}
                    onClick={() =>
                      selectedBlockId
                        ? updateBlock(selectedBlockId, { type: item.type })
                        : selectedSceneId && void addElement(selectedSceneId, item.type)
                    }
                    title={`${item.label} (Ctrl+${item.shortcut})`}
                    type="button"
                  >
                    {item.label}
                    <kbd>{item.shortcut}</kbd>
                  </button>
                ))}
              </div>
              <div className="screenplay-toolbar__actions">
                <button
                  aria-pressed={findOpen}
                  onClick={() => setFindOpen((value) => !value)}
                  type="button"
                >
                  <Search aria-hidden="true" /> Find
                </button>
                {canEdit ? (
                  <Button
                    disabled={!dirty || saveDraft.isPending}
                    icon={<Save />}
                    onClick={() => saveDraft.mutate()}
                    variant="quiet"
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            </header>
            {findOpen ? (
              <div className="screenplay-find">
                <Search aria-hidden="true" />
                <input
                  autoFocus
                  onChange={(event) => {
                    setFindText(event.currentTarget.value);
                    setFindCursor(-1);
                  }}
                  placeholder="Find in screenplay"
                  value={findText}
                />
                <span>
                  {findMatches.length
                    ? `${Math.max(0, findCursor + 1)} of ${findMatches.length}`
                    : "No matches"}
                </span>
                <IconButton label="Previous match" onClick={() => nextFind(-1)}>
                  <ChevronLeft />
                </IconButton>
                <IconButton label="Next match" onClick={() => nextFind(1)}>
                  <ChevronRight />
                </IconButton>
                <IconButton label="Close find" onClick={() => setFindOpen(false)}>
                  <X />
                </IconButton>
              </div>
            ) : null}
            {conflict ? (
              <div className="conflict-banner" role="alert">
                <AlertTriangle aria-hidden="true" />
                <div>
                  <strong>Another version was saved first</strong>
                  <p>
                    Your draft is still visible. Load the server version only when you are ready to
                    replace it.
                  </p>
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
            {operationError ? (
              <div className="conflict-banner" role="alert">
                <AlertTriangle aria-hidden="true" />
                <span>{operationError}</span>
                <Button onClick={() => setOperationError(undefined)} variant="quiet">
                  Dismiss
                </Button>
              </div>
            ) : null}
            <div className="screenplay-paper" role="document">
              {draftBlocks.length ? (
                draftBlocks.map((block) => (
                  <div
                    className={`screenplay-line screenplay-line--${block.type}${selectedBlockId === block.id ? " screenplay-line--selected" : ""}`}
                    data-scene-id={block.sceneId ?? undefined}
                    key={block.id}
                  >
                    <label>
                      <span className="swp-visually-hidden">{labelFor(block.type)}</span>
                      <textarea
                        disabled={!canEdit}
                        onChange={(event) =>
                          updateBlock(block.id, { text: event.currentTarget.value })
                        }
                        onFocus={() => {
                          setSelectedBlockId(block.id);
                          setSelectedSceneId(block.sceneId ?? undefined);
                        }}
                        onKeyDown={(event) => blockKeyDown(event, block)}
                        placeholder={placeholderFor(block.type)}
                        ref={(node) => {
                          if (node) blockRefs.current.set(block.id, node);
                          else blockRefs.current.delete(block.id);
                        }}
                        rows={Math.max(
                          1,
                          block.text.split("\n").length,
                          Math.ceil(block.text.length / 78),
                        )}
                        spellCheck={block.type !== "character" && block.type !== "scene_heading"}
                        value={block.text}
                      />
                    </label>
                    {canEdit && block.type !== "scene_heading" ? (
                      <span className="screenplay-line__tools">
                        <small>{labelFor(block.type)}</small>
                        <IconButton
                          label={`Delete ${labelFor(block.type)} block`}
                          onClick={() => deleteBlock.mutate(block.id)}
                        >
                          <Trash2 />
                        </IconButton>
                      </span>
                    ) : null}
                    {canEdit && block.type === "character" && characters.length ? (
                      <span className="screenplay-character-suggestions">
                        {characters
                          .filter((name) => name !== block.text.trim())
                          .slice(0, 5)
                          .map((name) => (
                            <button
                              key={name}
                              onClick={() => updateBlock(block.id, { text: name })}
                              type="button"
                            >
                              {name}
                            </button>
                          ))}
                      </span>
                    ) : null}
                  </div>
                ))
              ) : (
                <SurfaceBoundary
                  action={
                    canEdit ? (
                      <Button icon={<Plus />} onClick={() => addScene.mutate()} variant="primary">
                        Add first scene
                      </Button>
                    ) : undefined
                  }
                  description="Import Fountain, FDX or TXT, or begin with a scene heading."
                  state="empty"
                  title="The first page is waiting"
                />
              )}
              {canEdit && selectedSceneId ? (
                <button
                  className="screenplay-add-element"
                  onClick={() => void addElement(selectedSceneId, "action")}
                  type="button"
                >
                  <Plus aria-hidden="true" /> Add an element to scene {selectedScene?.displayNumber}
                </button>
              ) : null}
            </div>
            <footer className="screenplay-statusbar">
              <span>
                {selectedScene
                  ? `Scene ${selectedScene.displayNumber} · ${selectedScene.slugline}`
                  : "No scene selected"}
              </span>
              <span>{wordCount.toLocaleString("en-GB")} words</span>
              <span aria-live="polite">
                {saveDraft.isPending
                  ? "Saving…"
                  : conflict
                    ? "Conflict"
                    : dirty
                      ? "Unsaved"
                      : "Saved"}
              </span>
              <span>{screenplay.data.currentRevision?.name ?? "Working draft"}</span>
            </footer>
          </main>
          <aside className="screenplay-inspector">
            <div className="screenplay-inspector__tabs" role="tablist">
              {(["notes", "revisions", "sync"] as const).map((tab) => (
                <button
                  aria-selected={reviewTab === tab}
                  key={tab}
                  onClick={() => setReviewTab(tab)}
                  role="tab"
                  type="button"
                >
                  {tab === "sync" ? "Script sync" : titleCase(tab)}
                </button>
              ))}
            </div>
            {reviewTab === "notes" ? (
              <div className="screenplay-notes">
                <header>
                  <p>Scene notes</p>
                  <h2>
                    {selectedScene?.displayNumber ?? "—"} ·{" "}
                    {selectedScene?.slugline ?? "Select a scene"}
                  </h2>
                </header>
                {selectedScene?.synopsis ? (
                  <p>{selectedScene.synopsis}</p>
                ) : (
                  <p className="muted">No canonical synopsis yet.</p>
                )}
                <h3>Inline notes</h3>
                {draftBlocks
                  .filter((block) => block.sceneId === selectedSceneId && block.type === "note")
                  .map((note) => (
                    <blockquote key={note.id}>{note.text || "Empty note"}</blockquote>
                  ))}
                {canEdit && selectedSceneId ? (
                  <Button
                    icon={<Plus />}
                    onClick={() => void addElement(selectedSceneId, "note")}
                    variant="quiet"
                  >
                    Add private draft note
                  </Button>
                ) : null}
                <h3>Element guide</h3>
                <dl className="screenplay-guide">
                  <div>
                    <dt>Enter</dt>
                    <dd>New logical element</dd>
                  </div>
                  <div>
                    <dt>Shift + Enter</dt>
                    <dd>Line break</dd>
                  </div>
                  <div>
                    <dt>Ctrl + 1–8</dt>
                    <dd>Change element type</dd>
                  </div>
                  <div>
                    <dt>Ctrl + S</dt>
                    <dd>Save now</dd>
                  </div>
                </dl>
              </div>
            ) : reviewTab === "revisions" ? (
              <ol className="screenplay-revisions">
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
                      <p>{revision.notes}</p>
                    </div>
                    <IconButton label={`Compare ${revision.name}`}>
                      <FileDiff />
                    </IconButton>
                  </li>
                ))}
              </ol>
            ) : (
              <ScriptSyncPanel
                canEdit={canEdit}
                data={screenplay.data}
                onApply={() => applySync.mutate()}
                onResolve={(input) => resolveMapping.mutate(input)}
                pending={applySync.isPending || resolveMapping.isPending}
              />
            )}
          </aside>
        </div>
      ) : null}
      {revisionOpen ? (
        <div className="drawer-layer">
          <button
            aria-label="Close revision dialog"
            className="drawer-scrim"
            onClick={() => setRevisionOpen(false)}
            type="button"
          />
          <form
            className="revision-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              createRevision.mutate();
            }}
          >
            <header>
              <div>
                <p>Immutable snapshot</p>
                <h2>Create screenplay revision</h2>
              </div>
              <IconButton label="Close" onClick={() => setRevisionOpen(false)}>
                <X />
              </IconButton>
            </header>
            <label>
              <span>Revision name</span>
              <input
                autoFocus
                minLength={2}
                onChange={(event) => setRevisionName(event.currentTarget.value)}
                required
                value={revisionName}
              />
            </label>
            <label>
              <span>Revision colour</span>
              <select
                onChange={(event) => setRevisionColour(event.currentTarget.value)}
                value={revisionColour}
              >
                {[
                  "white",
                  "blue",
                  "pink",
                  "yellow",
                  "green",
                  "goldenrod",
                  "buff",
                  "salmon",
                  "cherry",
                ].map((colour) => (
                  <option key={colour} value={colour}>
                    {titleCase(colour)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>What changed?</span>
              <textarea
                maxLength={2000}
                onChange={(event) => setRevisionNotes(event.currentTarget.value)}
                placeholder="Describe the creative and production-relevant changes."
                rows={5}
                value={revisionNotes}
              />
            </label>
            <p>This freezes the current draft. Existing revisions will never be overwritten.</p>
            <footer>
              <Button onClick={() => setRevisionOpen(false)} variant="quiet">
                Cancel
              </Button>
              <Button
                disabled={createRevision.isPending || revisionName.trim().length < 2}
                icon={<LockKeyhole />}
                type="submit"
                variant="primary"
              >
                Create revision
              </Button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function ScriptSyncPanel({
  canEdit,
  data,
  onApply,
  onResolve,
  pending,
}: {
  canEdit: boolean;
  data: Screenplay;
  onApply: () => void;
  onResolve: (input: {
    mappingId: string;
    decision: "accept" | "omit" | "archive";
    reason: string;
  }) => void;
  pending: boolean;
}) {
  if (!data.syncPreview)
    return (
      <SurfaceBoundary
        description="Draft writing and production sync remain separate. Creating a revision produces a reviewable scene mapping."
        state="empty"
        title="No sync awaiting review"
      />
    );
  return (
    <div className="screenplay-sync">
      <header>
        <div>
          <p>Incoming revision</p>
          <h2>{data.syncPreview.sourceRevisionName}</h2>
        </div>
        <Status tone={data.syncPreview.unresolved ? "warning" : "success"}>
          {data.syncPreview.unresolved ? `${data.syncPreview.unresolved} unresolved` : "Resolved"}
        </Status>
      </header>
      <ol>
        {data.syncPreview.items.map((item) => (
          <li key={item.id}>
            <div>
              <Status
                tone={
                  item.classification === "removed"
                    ? "danger"
                    : item.classification === "ambiguous"
                      ? "purple"
                      : item.classification === "matched"
                        ? "success"
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
            ) : null}
            {item.decision ? (
              <span className="screenplay-sync__decision">
                <Check aria-hidden="true" /> {item.decision}
              </span>
            ) : canEdit ? (
              <footer>
                <Button
                  disabled={pending}
                  onClick={() =>
                    onResolve({
                      mappingId: item.id,
                      decision: item.classification === "removed" ? "omit" : "accept",
                      reason:
                        item.classification === "removed"
                          ? "Retain downstream work as omitted."
                          : "Confirmed during screenplay revision review.",
                    })
                  }
                  variant="quiet"
                >
                  {item.classification === "removed" ? "Keep as omitted" : "Accept mapping"}
                </Button>
              </footer>
            ) : null}
          </li>
        ))}
      </ol>
      {canEdit ? (
        <Button
          disabled={pending || data.syncPreview.unresolved > 0}
          onClick={onApply}
          variant="primary"
        >
          Apply resolved sync
        </Button>
      ) : null}
    </div>
  );
}

function nextElement(type: BlockType): BlockType {
  if (type === "character" || type === "parenthetical") return "dialogue";
  if (type === "dialogue" || type === "dual_dialogue") return "action";
  if (type === "scene_heading" || type === "transition" || type === "shot") return "action";
  return type === "note" ? "action" : type;
}

function labelFor(type: BlockType): string {
  return type.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function placeholderFor(type: BlockType): string {
  const labels: Record<BlockType, string> = {
    scene_heading: "INT. LOCATION - DAY",
    action: "What can the audience see or hear?",
    character: "CHARACTER",
    parenthetical: "(quietly)",
    dialogue: "Write the line as it is spoken.",
    dual_dialogue: "Simultaneous dialogue",
    transition: "CUT TO:",
    shot: "CLOSE ON:",
    lyrics: "Lyrics or on-screen text",
    page_break: "Page break",
    section: "Section",
    synopsis: "Private outline synopsis",
    note: "Private draft note",
  };
  return labels[type];
}

function scrollToScene(sceneId: string) {
  document
    .querySelector(`[data-scene-id="${CSS.escape(sceneId)}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function wordsIn(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
