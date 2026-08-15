import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Lightbulb, Plus, Save, Search, Sparkles, Trash2 } from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { domainRecordListSchema, domainRecordSchema, type DomainRecord } from "../app/schemas";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { useAuth } from "../auth/auth-context";
import { detailList, detailText, formatRelativeTime, titleFromNote } from "./record-utils";

interface IdeaDraft {
  title: string;
  status: string;
  summary: string;
  notes: string;
  source: string;
  tags: string;
}

const changedSchema = z.object({ changed: z.literal(true) });

export function IdeaBoxPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canEdit = auth.account?.role !== "viewer";
  const [capture, setCapture] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<IdeaDraft>();
  const [error, setError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/records/idea`;

  const ideas = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["records", projectId, "idea", "rank"],
    queryFn: () =>
      apiRequest(`${endpoint}?limit=100&state=active&order=rank`, domainRecordListSchema),
  });
  const items = ideas.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("en-GB");
    if (!query) return items;
    return items.filter((idea) =>
      [idea.title, idea.summary ?? "", ...detailList(idea, "tags")]
        .join(" ")
        .toLocaleLowerCase("en-GB")
        .includes(query),
    );
  }, [items, search]);

  useEffect(() => {
    if (!selected) {
      setDraft(undefined);
      return;
    }
    setSelectedId(selected.id);
    setDraft({
      title: selected.title,
      status: selected.status,
      summary: selected.summary ?? "",
      notes: detailText(selected, "notes"),
      source: detailText(selected, "source"),
      tags: detailList(selected, "tags").join(", "),
    });
  }, [selected?.id, selected?.version]);

  const createIdea = useMutation({
    mutationFn: (note: string) =>
      apiRequest(endpoint, domainRecordSchema, {
        method: "POST",
        body: jsonBody({
          title: titleFromNote(note),
          status: "spark",
          summary: note,
          details: {
            notes: "",
            source: "",
            tags: [],
            links: [],
            type: activeProject?.type ?? "film",
          },
        }),
      }),
    onSuccess: async (created) => {
      setCapture("");
      setSelectedId(created.id);
      setError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["records", projectId, "idea"] }),
        queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] }),
      ]);
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const saveIdea = useMutation({
    mutationFn: ({ idea, next }: { idea: DomainRecord; next: IdeaDraft }) =>
      apiRequest(`${endpoint}/${encodeURIComponent(idea.id)}`, domainRecordSchema, {
        method: "PATCH",
        headers: { "If-Match": `"${idea.version}"` },
        body: jsonBody({
          title: next.title,
          status: next.status,
          summary: next.summary,
          details: {
            ...idea.details,
            notes: next.notes,
            source: next.source,
            tags: next.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          },
        }),
      }),
    onSuccess: async () => {
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["records", projectId, "idea"] });
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const rankIdea = useMutation({
    mutationFn: ({
      idea,
      beforeId,
      afterId,
    }: {
      idea: DomainRecord;
      beforeId?: string;
      afterId?: string;
    }) =>
      apiRequest(`${endpoint}/${encodeURIComponent(idea.id)}/rank`, domainRecordSchema, {
        method: "PATCH",
        headers: { "If-Match": `"${idea.version}"` },
        body: jsonBody({ beforeId: beforeId ?? null, afterId: afterId ?? null }),
      }),
    onSuccess: async () =>
      queryClient.invalidateQueries({ queryKey: ["records", projectId, "idea"] }),
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  const archiveIdea = useMutation({
    mutationFn: (idea: DomainRecord) =>
      apiRequest(`${endpoint}/${encodeURIComponent(idea.id)}/archive`, changedSchema, {
        method: "POST",
        headers: { "If-Match": `"${idea.version}"` },
      }),
    onSuccess: async () => {
      setSelectedId(undefined);
      setDeleteOpen(false);
      setError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["records", projectId, "idea"] }),
        queryClient.invalidateQueries({ queryKey: ["creative-progress", projectId] }),
      ]);
    },
    onError: (mutationError) => setError(messageFor(mutationError)),
  });

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  function moveIdea(idea: DomainRecord, direction: -1 | 1) {
    const index = items.findIndex((item) => item.id === idea.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    if (direction < 0) {
      const afterId = items[index - 2]?.id;
      const beforeId = items[index - 1]?.id;
      rankIdea.mutate({
        idea,
        ...(afterId ? { afterId } : {}),
        ...(beforeId ? { beforeId } : {}),
      });
    } else {
      const afterId = items[index + 1]?.id;
      const beforeId = items[index + 2]?.id;
      rankIdea.mutate({
        idea,
        ...(afterId ? { afterId } : {}),
        ...(beforeId ? { beforeId } : {}),
      });
    }
  }

  return (
    <section className="project-page idea-box-page">
      <ProjectContextHeader
        creativeModule="idea_box"
        project={activeProject}
        section="Development"
        title="Idea Box"
      />
      <div className="creative-intro">
        <div>
          <p className="eyebrow">Capture before you judge</p>
          <h2>Every film starts as a loose thought.</h2>
          <p>Drop it here quickly. Open it later to shape, tag and rank it against the rest.</p>
        </div>
        <span>
          {items.length} idea{items.length === 1 ? "" : "s"}
        </span>
      </div>
      {canEdit ? (
        <form
          className="idea-capture"
          onSubmit={(event) => {
            event.preventDefault();
            if (capture.trim()) createIdea.mutate(capture.trim());
          }}
        >
          <Lightbulb aria-hidden="true" />
          <label>
            <span className="swp-visually-hidden">Capture a new idea</span>
            <textarea
              maxLength={4000}
              onChange={(event) => setCapture(event.currentTarget.value)}
              placeholder="What if…  Write the thought before it disappears."
              rows={2}
              value={capture}
            />
          </label>
          <Button
            disabled={!capture.trim() || createIdea.isPending}
            icon={<Plus />}
            type="submit"
            variant="primary"
          >
            Add to box
          </Button>
        </form>
      ) : null}
      {error ? (
        <div className="conflict-banner" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {ideas.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : ideas.isError ? (
        <SurfaceBoundary state="error" />
      ) : items.length ? (
        <div className="idea-workspace">
          <section aria-label="Ranked ideas" className="idea-gallery">
            <header className="idea-gallery__header">
              <div>
                <p>Ranked gallery</p>
                <span>Strongest ideas rise to the top.</span>
              </div>
              <label className="creative-search">
                <Search aria-hidden="true" />
                <span className="swp-visually-hidden">Search ideas</span>
                <input
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder="Search ideas"
                  value={search}
                />
              </label>
            </header>
            <ol>
              {filtered.map((idea) => {
                const rank = items.findIndex((item) => item.id === idea.id);
                return (
                  <li
                    className={
                      idea.id === selected?.id ? "idea-card idea-card--selected" : "idea-card"
                    }
                    key={idea.id}
                  >
                    <button
                      className="idea-card__open"
                      onClick={() => setSelectedId(idea.id)}
                      type="button"
                    >
                      <span className="idea-card__rank">{String(rank + 1).padStart(2, "0")}</span>
                      <span className="idea-card__content">
                        <span className="idea-card__meta">
                          <Status
                            tone={
                              idea.status === "developing"
                                ? "info"
                                : idea.status === "favourite"
                                  ? "success"
                                  : "neutral"
                            }
                          >
                            {idea.status}
                          </Status>
                          <time dateTime={new Date(idea.updatedAt).toISOString()}>
                            {formatRelativeTime(idea.updatedAt)}
                          </time>
                        </span>
                        <strong>{idea.title}</strong>
                        <span>{idea.summary || "Open this idea and give it some shape."}</span>
                        {detailList(idea, "tags").length ? (
                          <small>
                            {detailList(idea, "tags")
                              .map((tag) => `#${tag}`)
                              .join("  ")}
                          </small>
                        ) : null}
                      </span>
                    </button>
                    {canEdit ? (
                      <span className="idea-card__rank-actions">
                        <IconButton
                          disabled={rank === 0 || rankIdea.isPending}
                          label={`Move ${idea.title} up`}
                          onClick={() => moveIdea(idea, -1)}
                        >
                          <ArrowUp />
                        </IconButton>
                        <IconButton
                          disabled={rank === items.length - 1 || rankIdea.isPending}
                          label={`Move ${idea.title} down`}
                          onClick={() => moveIdea(idea, 1)}
                        >
                          <ArrowDown />
                        </IconButton>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
          <aside aria-label="Idea details" className="idea-inspector">
            {selected && draft ? (
              <>
                <header>
                  <div>
                    <p>
                      Idea #
                      {String(items.findIndex((item) => item.id === selected.id) + 1).padStart(
                        2,
                        "0",
                      )}
                    </p>
                    <span>Last shaped {formatRelativeTime(selected.updatedAt)}</span>
                  </div>
                  <Sparkles aria-hidden="true" />
                </header>
                <label>
                  <span>Working title</span>
                  <input
                    disabled={!canEdit}
                    onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
                    value={draft.title}
                  />
                </label>
                <label>
                  <span>The idea</span>
                  <textarea
                    disabled={!canEdit}
                    onChange={(event) => setDraft({ ...draft, summary: event.currentTarget.value })}
                    rows={6}
                    value={draft.summary}
                  />
                </label>
                <div className="idea-inspector__pair">
                  <label>
                    <span>Stage</span>
                    <select
                      disabled={!canEdit}
                      onChange={(event) =>
                        setDraft({ ...draft, status: event.currentTarget.value })
                      }
                      value={draft.status}
                    >
                      <option value="spark">Spark</option>
                      <option value="developing">Developing</option>
                      <option value="favourite">Favourite</option>
                      <option value="promoted">Promoted to project</option>
                      <option value="on_hold">On hold</option>
                    </select>
                  </label>
                  <label>
                    <span>Source</span>
                    <input
                      disabled={!canEdit}
                      onChange={(event) =>
                        setDraft({ ...draft, source: event.currentTarget.value })
                      }
                      placeholder="Dream, conversation…"
                      value={draft.source}
                    />
                  </label>
                </div>
                <label>
                  <span>Tags</span>
                  <input
                    disabled={!canEdit}
                    onChange={(event) => setDraft({ ...draft, tags: event.currentTarget.value })}
                    placeholder="thriller, one-location, night"
                    value={draft.tags}
                  />
                </label>
                <label>
                  <span>Notes to future you</span>
                  <textarea
                    disabled={!canEdit}
                    onChange={(event) => setDraft({ ...draft, notes: event.currentTarget.value })}
                    placeholder="Questions, images, possible endings…"
                    rows={5}
                    value={draft.notes}
                  />
                </label>
                {canEdit ? (
                  <footer>
                    <Button
                      icon={<Save />}
                      onClick={() => saveIdea.mutate({ idea: selected, next: draft })}
                      variant="primary"
                    >
                      Save idea
                    </Button>
                    <Button icon={<Trash2 />} onClick={() => setDeleteOpen(true)} variant="quiet">
                      Delete
                    </Button>
                  </footer>
                ) : null}
              </>
            ) : null}
          </aside>
        </div>
      ) : (
        <SurfaceBoundary
          description={
            canEdit
              ? "Capture a loose thought above. You can organise it later."
              : "No ideas have been shared in this project yet."
          }
          state="empty"
          title="The box is open"
        />
      )}
      {deleteOpen && selected ? (
        <div className="dialog-layer">
          <button
            aria-label="Cancel idea deletion"
            className="dialog-layer__scrim"
            onClick={() => setDeleteOpen(false)}
            type="button"
          />
          <div aria-labelledby="delete-project-idea-title" aria-modal="true" role="dialog">
            <div className="form-dialog">
              <header>
                <h2 id="delete-project-idea-title">Delete “{selected.title}”?</h2>
                <p>The idea leaves the gallery but remains recoverable in project history.</p>
              </header>
              {archiveIdea.isError ? (
                <p className="form-error" role="alert">
                  The idea could not be deleted. Refresh and try again.
                </p>
              ) : null}
              <footer>
                <Button onClick={() => setDeleteOpen(false)} variant="quiet">
                  Keep idea
                </Button>
                <Button
                  disabled={archiveIdea.isPending}
                  icon={<Trash2 />}
                  onClick={() => archiveIdea.mutate(selected)}
                  variant="primary"
                >
                  Delete idea
                </Button>
              </footer>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return "Someone changed this idea first. Your text is still here; reload before saving again.";
  return error instanceof Error ? error.message : "The idea could not be saved.";
}
