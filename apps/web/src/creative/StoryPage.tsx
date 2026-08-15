import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bold,
  BookOpenText,
  Focus,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { domainRecordListSchema, domainRecordSchema, type DomainRecord } from "../app/schemas";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { useAuth } from "../auth/auth-context";
import { countWords, detailText } from "./record-utils";

const compassFields = [
  { key: "premise", label: "Premise", prompt: "What is this story really about?" },
  { key: "protagonist", label: "Protagonist", prompt: "Whose choices drive the story?" },
  { key: "want", label: "Want", prompt: "What do they believe they need?" },
  { key: "obstacle", label: "Obstacle", prompt: "What makes that difficult?" },
  { key: "stakes", label: "Stakes", prompt: "What happens if they fail?" },
  { key: "ending", label: "Ending", prompt: "What changes by the final image?" },
  { key: "theme", label: "Theme", prompt: "What question should linger?" },
] as const;
const changedSchema = z.object({ changed: z.literal(true) });

interface StoryDraft {
  title: string;
  status: string;
  body: string;
  compass: Record<(typeof compassFields)[number]["key"], string>;
}

export function StoryPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const canEdit = auth.account?.role !== "viewer";
  const [draft, setDraft] = useState<StoryDraft>();
  const [baseRecord, setBaseRecord] = useState<DomainRecord>();
  const [dirty, setDirty] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [conflict, setConflict] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/records/development_document`;

  const documents = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["records", projectId, "development_document", "story"],
    queryFn: () => apiRequest(`${endpoint}?limit=100&state=active`, domainRecordListSchema),
  });
  const story = useMemo(
    () => documents.data?.items.find((record) => detailText(record, "documentType") === "story"),
    [documents.data?.items],
  );

  useEffect(() => {
    if (!story || dirty) return;
    setBaseRecord(story);
    setDraft({
      title: story.title,
      status: story.status,
      body: detailText(story, "body"),
      compass: Object.fromEntries(
        compassFields.map((field) => [field.key, detailText(story, field.key)]),
      ) as StoryDraft["compass"],
    });
  }, [dirty, story]);

  const createStory = useMutation({
    mutationFn: () =>
      apiRequest(endpoint, domainRecordSchema, {
        method: "POST",
        body: jsonBody({
          title: `${activeProject?.title ?? "Untitled project"} — Story`,
          status: "draft",
          summary: "The working story document.",
          details: {
            documentType: "story",
            body: "",
            premise: "",
            protagonist: "",
            want: "",
            obstacle: "",
            stakes: "",
            ending: "",
            theme: "",
          },
        }),
      }),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["records", projectId, "development_document"] }),
  });

  const saveStory = useMutation({
    mutationFn: ({ record, next }: { record: DomainRecord; next: StoryDraft }) =>
      apiRequest(`${endpoint}/${encodeURIComponent(record.id)}`, domainRecordSchema, {
        method: "PATCH",
        headers: { "If-Match": `"${record.version}"` },
        body: jsonBody({
          title: next.title,
          status: next.status,
          summary: next.compass.premise || "The working story document.",
          details: { ...record.details, documentType: "story", body: next.body, ...next.compass },
        }),
      }),
    onSuccess: (saved) => {
      setBaseRecord(saved);
      setDirty(false);
      setConflict(undefined);
      queryClient.setQueryData(
        ["records", projectId, "development_document", "story"],
        (current: unknown) => {
          const parsed = domainRecordListSchema.safeParse(current);
          if (!parsed.success) return current;
          return {
            ...parsed.data,
            items: parsed.data.items.map((item) => (item.id === saved.id ? saved : item)),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(
          "A newer story version exists. Your draft remains on this screen; compare before replacing anything.",
        );
      } else {
        setConflict(error instanceof Error ? error.message : "The story could not be saved.");
      }
    },
  });

  const deleteStory = useMutation({
    mutationFn: (record: DomainRecord) =>
      apiRequest(`${endpoint}/${encodeURIComponent(record.id)}/archive`, changedSchema, {
        method: "POST",
        headers: { "If-Match": `"${record.version}"` },
      }),
    onSuccess: async () => {
      setBaseRecord(undefined);
      setDraft(undefined);
      setDirty(false);
      setConflict(undefined);
      setDeleteOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["records", projectId, "development_document"],
        }),
        queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] }),
      ]);
    },
    onError: (error) =>
      setConflict(error instanceof Error ? error.message : "The story could not be deleted."),
  });

  useEffect(() => {
    if (!canEdit || !dirty || !draft || !baseRecord || saveStory.isPending || conflict) return;
    const timeout = window.setTimeout(
      () => saveStory.mutate({ record: baseRecord, next: draft }),
      1500,
    );
    return () => window.clearTimeout(timeout);
  }, [baseRecord, canEdit, conflict, dirty, draft, saveStory]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-GB") === "s") {
        if (draft && baseRecord && canEdit) {
          event.preventDefault();
          saveStory.mutate({ record: baseRecord, next: draft });
        }
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [baseRecord, canEdit, draft, saveStory]);

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  function updateDraft(patch: Partial<StoryDraft>) {
    if (!draft || !canEdit) return;
    setDraft({ ...draft, ...patch });
    setDirty(true);
  }

  function formatSelection(kind: "bold" | "italic" | "heading" | "bullets" | "numbers") {
    const editor = editorRef.current;
    if (!editor || !draft || !canEdit) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = draft.body.slice(start, end);
    const transform = {
      bold: () => `**${selected || "strong words"}**`,
      italic: () => `_${selected || "emphasis"}_`,
      heading: () => `## ${selected || "New section"}`,
      bullets: () => prefixLines(selected || "List item", "- "),
      numbers: () =>
        (selected || "List item")
          .split("\n")
          .map((line, index) => `${index + 1}. ${line}`)
          .join("\n"),
    }[kind]();
    const body = `${draft.body.slice(0, start)}${transform}${draft.body.slice(end)}`;
    updateDraft({ body });
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(start, start + transform.length);
    });
  }

  const words = countWords(draft?.body ?? "");

  return (
    <section className={`project-page story-page${focusMode ? " story-page--focus" : ""}`}>
      <ProjectContextHeader
        creativeModule="story"
        project={activeProject}
        section="Development"
        title="The Story"
      />
      {documents.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : documents.isError ? (
        <SurfaceBoundary state="error" />
      ) : !story || !draft || !baseRecord ? (
        <SurfaceBoundary
          action={
            canEdit ? (
              <Button
                icon={<BookOpenText />}
                onClick={() => createStory.mutate()}
                variant="primary"
              >
                Start the story
              </Button>
            ) : undefined
          }
          description={
            canEdit
              ? "Begin in prose. Find the film before formatting the screenplay."
              : "The story document has not been started yet."
          }
          state="empty"
          title="A blank page, on purpose"
        />
      ) : (
        <div className="story-workspace">
          <main className="story-document-shell">
            <header className="story-document-header">
              <div>
                <input
                  aria-label="Story document title"
                  disabled={!canEdit}
                  onChange={(event) => updateDraft({ title: event.currentTarget.value })}
                  value={draft.title}
                />
                <span className="story-save-state" role="status">
                  {saveStory.isPending
                    ? "Saving…"
                    : conflict
                      ? "Conflict"
                      : dirty
                        ? "Unsaved changes"
                        : "All changes saved"}
                </span>
              </div>
              <label>
                <span className="swp-visually-hidden">Story status</span>
                <select
                  disabled={!canEdit}
                  onChange={(event) => updateDraft({ status: event.currentTarget.value })}
                  value={draft.status}
                >
                  <option value="draft">Draft</option>
                  <option value="in_review">In review</option>
                  <option value="approved">Approved</option>
                  <option value="superseded">Superseded</option>
                </select>
              </label>
            </header>
            <div aria-label="Story formatting" className="story-toolbar" role="toolbar">
              <IconButton
                disabled={!canEdit}
                label="Section heading"
                onClick={() => formatSelection("heading")}
              >
                <Heading2 />
              </IconButton>
              <IconButton disabled={!canEdit} label="Bold" onClick={() => formatSelection("bold")}>
                <Bold />
              </IconButton>
              <IconButton
                disabled={!canEdit}
                label="Italic"
                onClick={() => formatSelection("italic")}
              >
                <Italic />
              </IconButton>
              <span aria-hidden="true" />
              <IconButton
                disabled={!canEdit}
                label="Bulleted list"
                onClick={() => formatSelection("bullets")}
              >
                <List />
              </IconButton>
              <IconButton
                disabled={!canEdit}
                label="Numbered list"
                onClick={() => formatSelection("numbers")}
              >
                <ListOrdered />
              </IconButton>
              <span aria-hidden="true" />
              <IconButton
                label="Zoom out"
                onClick={() => setZoom((value) => Math.max(80, value - 10))}
              >
                <Minus />
              </IconButton>
              <output>{zoom}%</output>
              <IconButton
                label="Zoom in"
                onClick={() => setZoom((value) => Math.min(140, value + 10))}
              >
                <Plus />
              </IconButton>
              <IconButton
                label={focusMode ? "Show story compass" : "Focus on document"}
                onClick={() => setFocusMode((value) => !value)}
              >
                <Focus />
              </IconButton>
              {canEdit ? (
                <>
                  <Button
                    disabled={!dirty || saveStory.isPending}
                    icon={<Save />}
                    onClick={() => saveStory.mutate({ record: baseRecord, next: draft })}
                    variant="quiet"
                  >
                    Save
                  </Button>
                  <Button
                    disabled={dirty || saveStory.isPending || deleteStory.isPending}
                    icon={<Trash2 />}
                    onClick={() => setDeleteOpen(true)}
                    variant="quiet"
                  >
                    Delete story
                  </Button>
                </>
              ) : null}
            </div>
            {conflict ? (
              <div className="conflict-banner" role="alert">
                <span>{conflict}</span>
                <Button
                  onClick={() => {
                    setConflict(undefined);
                    setDirty(false);
                    void documents.refetch();
                  }}
                  variant="secondary"
                >
                  Load server version
                </Button>
              </div>
            ) : null}
            <div
              className="story-paper-wrap"
              style={{ "--story-zoom": zoom / 100 } as React.CSSProperties}
            >
              <textarea
                aria-label="Story body"
                disabled={!canEdit}
                onChange={(event) => updateDraft({ body: event.currentTarget.value })}
                placeholder="Tell the story in your own words. Start with an image, a person, a problem—whatever lets you keep moving."
                ref={editorRef}
                spellCheck
                value={draft.body}
              />
            </div>
            <footer className="story-statusbar">
              <span>{words.toLocaleString("en-GB")} words</span>
              <span>About {Math.max(1, Math.ceil(words / 220))} min read</span>
              <span>Markdown-style formatting</span>
            </footer>
          </main>
          <aside className="story-compass">
            <header>
              <div>
                <p>Story compass</p>
                <h2>Keep the dramatic engine visible.</h2>
              </div>
              <Status
                tone={
                  compassFields.every((field) => draft.compass[field.key].trim())
                    ? "success"
                    : "neutral"
                }
              >
                {compassFields.filter((field) => draft.compass[field.key].trim()).length}/
                {compassFields.length}
              </Status>
            </header>
            {compassFields.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <small>{field.prompt}</small>
                <textarea
                  disabled={!canEdit}
                  onChange={(event) =>
                    updateDraft({
                      compass: { ...draft.compass, [field.key]: event.currentTarget.value },
                    })
                  }
                  rows={field.key === "premise" || field.key === "ending" ? 3 : 2}
                  value={draft.compass[field.key]}
                />
              </label>
            ))}
          </aside>
        </div>
      )}
      {deleteOpen && baseRecord ? (
        <div className="dialog-layer">
          <button
            aria-label="Cancel story deletion"
            className="dialog-layer__scrim"
            onClick={() => setDeleteOpen(false)}
            type="button"
          />
          <div aria-labelledby="delete-story-title" aria-modal="true" role="dialog">
            <div className="form-dialog">
              <header>
                <h2 id="delete-story-title">Delete this story document?</h2>
                <p>The document leaves the writing desk but remains recoverable in history.</p>
              </header>
              {deleteStory.isError ? (
                <p className="form-error" role="alert">
                  The story could not be deleted. Refresh and try again.
                </p>
              ) : null}
              <footer>
                <Button onClick={() => setDeleteOpen(false)} variant="quiet">
                  Keep story
                </Button>
                <Button
                  disabled={deleteStory.isPending}
                  icon={<Trash2 />}
                  onClick={() => deleteStory.mutate(baseRecord)}
                  variant="primary"
                >
                  Delete story
                </Button>
              </footer>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function prefixLines(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
