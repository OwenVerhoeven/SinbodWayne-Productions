import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  ArrowRight,
  FolderPlus,
  Lightbulb,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { Button, Status, SurfaceBoundary, Wordmark } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import { projectListSchema, projectSchema, type ProjectSummary } from "../app/schemas";
import { useAuth } from "../auth/auth-context";
import { creativeStatusLabel, creativeStatusTone } from "../creative/creative-progress";

const productionTypeSchema = z.enum([
  "short_film",
  "narrative_video",
  "music_video",
  "youtube",
  "commercial",
  "episodic",
]);
const ideaSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  title: z.string(),
  type: productionTypeSchema,
  source: z.string().nullable(),
  status: z.string(),
  summary: z.string().nullable(),
  notes: z.string(),
  links: z.array(z.string()),
  tags: z.array(z.string()),
  promotedAt: z.number().nullable(),
  version: z.number(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const ideaListSchema = z.object({ items: z.array(ideaSchema) });
const promotionSchema = z.object({ projectId: z.string(), idea: ideaSchema });
type Idea = z.infer<typeof ideaSchema>;

export function ProjectListPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const auth = useAuth();
  const canEdit = auth.account?.role !== "viewer";
  const [view, setView] = useState<"projects" | "ideas">("projects");
  const [search, setSearch] = useState("");
  const [directoryState, setDirectoryState] = useState<"active" | "archived">("active");
  const [createOpen, setCreateOpen] = useState(false);
  const [ideaEditor, setIdeaEditor] = useState<Idea | "new">();
  const [promoteIdea, setPromoteIdea] = useState<Idea>();
  const [projectToDelete, setProjectToDelete] = useState<ProjectSummary>();
  const [ideaToDelete, setIdeaToDelete] = useState<Idea>();
  const projects = useQuery({
    enabled: view === "projects",
    queryKey: ["projects", search, directoryState],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects?limit=100&q=${encodeURIComponent(search)}&state=${directoryState}`,
        projectListSchema,
      ),
  });
  const ideas = useQuery({
    enabled: view === "ideas",
    queryKey: ["ideas", search, directoryState],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/ideas?limit=100&q=${encodeURIComponent(search)}&state=${directoryState}`,
        ideaListSchema,
      ),
  });
  const createProject = useMutation({
    mutationFn: (input: { title: string; code: string; type: string }) =>
      apiRequest("/api/v1/app/projects", projectSchema, { method: "POST", body: jsonBody(input) }),
    onSuccess: async () => {
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const changeProjectLifecycle = useMutation({
    mutationFn: (project: ProjectSummary) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(project.id)}/${project.archivedAt ? "restore" : "archive"}`,
        projectSchema,
        {
          method: "POST",
          headers: { "If-Match": `"${project.version}"` },
          body: jsonBody({}),
        },
      ),
    onSuccess: async () => {
      setProjectToDelete(undefined);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const saveIdea = useMutation({
    mutationFn: (input: {
      idea?: Idea;
      title: string;
      summary: string;
      type: string;
      source: string;
      tags: string[];
      notes: string;
      links: string[];
    }) =>
      apiRequest(
        input.idea ? `/api/v1/app/ideas/${encodeURIComponent(input.idea.id)}` : "/api/v1/app/ideas",
        ideaSchema,
        {
          method: input.idea ? "PATCH" : "POST",
          ...(input.idea ? { headers: { "If-Match": `"${input.idea.version}"` } } : {}),
          body: jsonBody({
            title: input.title,
            summary: input.summary,
            type: input.type,
            source: input.source,
            tags: input.tags,
            notes: input.notes,
            links: input.links,
          }),
        },
      ),
    onSuccess: async () => {
      setIdeaEditor(undefined);
      await queryClient.invalidateQueries({ queryKey: ["ideas"] });
    },
  });
  const changeIdeaLifecycle = useMutation({
    mutationFn: (idea: Idea) =>
      apiRequest(
        `/api/v1/app/ideas/${encodeURIComponent(idea.id)}/${idea.archivedAt ? "restore" : "archive"}`,
        ideaSchema,
        { method: "POST", headers: { "If-Match": `"${idea.version}"` }, body: jsonBody({}) },
      ),
    onSuccess: async () => {
      setIdeaToDelete(undefined);
      await queryClient.invalidateQueries({ queryKey: ["ideas"] });
    },
  });
  const promote = useMutation({
    mutationFn: (input: { idea: Idea; code: string; type: string }) =>
      apiRequest(
        `/api/v1/app/ideas/${encodeURIComponent(input.idea.id)}/promote`,
        promotionSchema,
        {
          method: "POST",
          headers: {
            "If-Match": `"${input.idea.version}"`,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: jsonBody({ code: input.code, type: input.type }),
        },
      ),
    onSuccess: async (result) => {
      setPromoteIdea(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ideas"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      void navigate(`/projects/${result.projectId}/overview`);
    },
  });
  const projectItems = projects.data?.items ?? [];
  const ideaItems = ideas.data?.items ?? [];

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createProject.mutate({
      title: String(form.get("title") ?? ""),
      code: String(form.get("code") ?? ""),
      type: String(form.get("type") ?? "short_film"),
    });
  }

  function submitIdea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    saveIdea.mutate({
      ...(ideaEditor && ideaEditor !== "new" ? { idea: ideaEditor } : {}),
      title: String(form.get("title") ?? ""),
      summary: String(form.get("summary") ?? ""),
      type: String(form.get("type") ?? "short_film"),
      source: String(form.get("source") ?? ""),
      notes: String(form.get("notes") ?? ""),
      tags: commaList(form.get("tags")),
      links: lineList(form.get("links")),
    });
  }

  function submitPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!promoteIdea) return;
    const form = new FormData(event.currentTarget);
    promote.mutate({
      idea: promoteIdea,
      code: String(form.get("code") ?? ""),
      type: String(form.get("type") ?? promoteIdea.type),
    });
  }

  return (
    <section className="project-directory">
      <header className="directory-header">
        <div>
          <Wordmark />
          <h1>{view === "projects" ? "Productions" : "Idea inbox"}</h1>
          <p>
            {view === "projects"
              ? "Move each project from its first idea to a verified Ready to Shoot issue."
              : "Capture first sparks before a screenplay or production exists, then promote without losing history."}
          </p>
        </div>
        {canEdit && view === "projects" ? (
          <Button icon={<FolderPlus />} onClick={() => setCreateOpen(true)} variant="primary">
            New production
          </Button>
        ) : canEdit ? (
          <Button icon={<Plus />} onClick={() => setIdeaEditor("new")} variant="primary">
            Capture idea
          </Button>
        ) : null}
      </header>
      <div aria-label="Workspace directory" className="directory-tabs" role="tablist">
        <button
          aria-selected={view === "projects"}
          onClick={() => setView("projects")}
          role="tab"
          type="button"
        >
          Productions
        </button>
        <button
          aria-selected={view === "ideas"}
          onClick={() => setView("ideas")}
          role="tab"
          type="button"
        >
          Idea inbox
        </button>
      </div>
      <div className="directory-toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="swp-visually-hidden">Search {view}</span>
          <input
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={`Search ${view}`}
            value={search}
          />
        </label>
        <Button
          icon={<ArchiveRestore />}
          onClick={() => setDirectoryState((value) => (value === "active" ? "archived" : "active"))}
          aria-pressed={directoryState === "archived"}
          variant="quiet"
        >
          {directoryState === "archived" ? `Active ${view}` : `Deleted ${view}`}
        </Button>
      </div>
      {view === "projects" ? (
        projects.isLoading ? (
          <SurfaceBoundary state="loading" />
        ) : projects.isError ? (
          <SurfaceBoundary state="error" />
        ) : projectItems.length ? (
          <div className="project-table-wrap">
            <table className="record-table">
              <thead>
                <tr>
                  <th>Production</th>
                  <th>Type</th>
                  <th>Writing status</th>
                  <th>Updated</th>
                  {canEdit ? <th>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {projectItems.map((project) => (
                  <tr key={project.id}>
                    <th data-label="Production" scope="row">
                      {project.archivedAt ? (
                        <span>
                          <strong>{project.title}</strong>
                          <span>{project.code}</span>
                        </span>
                      ) : (
                        <Link to={`/projects/${project.id}/overview`}>
                          <strong>{project.title}</strong>
                          <span>
                            {project.code}
                            {project.workingTitle ? ` · ${project.workingTitle}` : ""}
                          </span>
                        </Link>
                      )}
                    </th>
                    <td data-label="Type">{project.type.replaceAll("_", " ")}</td>
                    <td data-label="Writing status">
                      <Status tone={creativeStatusTone(project.creativeStatus)}>
                        {creativeStatusLabel(project.creativeStatus)}
                      </Status>
                    </td>
                    <td data-label="Updated">
                      <time dateTime={new Date(project.updatedAt).toISOString()}>
                        {relativeDay(project.updatedAt)}
                      </time>
                    </td>
                    {canEdit ? (
                      <td data-label="Actions">
                        <Button
                          icon={project.archivedAt ? <RotateCcw /> : <Trash2 />}
                          onClick={() => {
                            if (project.archivedAt) changeProjectLifecycle.mutate(project);
                            else setProjectToDelete(project);
                          }}
                          variant="quiet"
                        >
                          {project.archivedAt ? "Restore" : "Delete"}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <SurfaceBoundary
            action={
              canEdit && directoryState === "active" ? (
                <Button icon={<FolderPlus />} onClick={() => setCreateOpen(true)} variant="primary">
                  Create production
                </Button>
              ) : undefined
            }
            description={
              directoryState === "active"
                ? "Create a standalone project or start from a workspace template."
                : "Deleted productions remain recoverable until an authorised retention action."
            }
            state="empty"
            title={directoryState === "active" ? "No active productions" : "No deleted productions"}
          />
        )
      ) : ideas.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : ideas.isError ? (
        <SurfaceBoundary state="error" />
      ) : ideaItems.length ? (
        <div className="idea-grid">
          {ideaItems.map((idea) => (
            <article className="idea-card" key={idea.id}>
              <header>
                <Lightbulb aria-hidden="true" />
                <Status
                  tone={idea.projectId ? "success" : idea.status === "parked" ? "warning" : "info"}
                >
                  {idea.status}
                </Status>
              </header>
              <h2>{idea.title}</h2>
              <p>{idea.summary || "No one-sentence idea yet."}</p>
              <dl>
                <div>
                  <dt>Type</dt>
                  <dd>{idea.type.replaceAll("_", " ")}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{idea.source || "Original"}</dd>
                </div>
              </dl>
              {idea.tags.length ? (
                <div className="tag-row">
                  {idea.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              ) : null}
              {canEdit ? (
                <footer>
                  <Button icon={<Pencil />} onClick={() => setIdeaEditor(idea)} variant="quiet">
                    Edit
                  </Button>
                  <Button
                    icon={idea.archivedAt ? <RotateCcw /> : <Trash2 />}
                    onClick={() => {
                      if (idea.archivedAt) changeIdeaLifecycle.mutate(idea);
                      else setIdeaToDelete(idea);
                    }}
                    variant="quiet"
                  >
                    {idea.archivedAt ? "Restore" : "Delete"}
                  </Button>
                  {idea.projectId ? (
                    <Button onClick={() => void navigate(`/projects/${idea.projectId}/overview`)}>
                      Open production
                    </Button>
                  ) : !idea.archivedAt ? (
                    <Button
                      icon={<ArrowRight />}
                      onClick={() => setPromoteIdea(idea)}
                      variant="primary"
                    >
                      Promote
                    </Button>
                  ) : null}
                </footer>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <SurfaceBoundary
          action={
            canEdit && directoryState === "active" ? (
              <Button icon={<Plus />} onClick={() => setIdeaEditor("new")} variant="primary">
                Capture first idea
              </Button>
            ) : undefined
          }
          description="Ideas keep their source, notes, references, and history when promoted."
          state="empty"
          title={directoryState === "active" ? "The idea inbox is clear" : "No deleted ideas"}
        />
      )}
      {projectToDelete ? (
        <DialogScrim label="Cancel project deletion" onClose={() => setProjectToDelete(undefined)}>
          <div aria-labelledby="delete-project-title" className="form-dialog">
            <header>
              <h2 id="delete-project-title">Delete “{projectToDelete.title}”?</h2>
              <p>
                The production moves to Deleted productions. Its screenplay and linked work stay
                intact and can be restored.
              </p>
            </header>
            <MutationError active={changeProjectLifecycle.isError} />
            <footer>
              <Button onClick={() => setProjectToDelete(undefined)} variant="quiet">
                Keep project
              </Button>
              <Button
                disabled={changeProjectLifecycle.isPending}
                icon={<Trash2 />}
                onClick={() => changeProjectLifecycle.mutate(projectToDelete)}
                variant="primary"
              >
                Delete project
              </Button>
            </footer>
          </div>
        </DialogScrim>
      ) : null}
      {ideaToDelete ? (
        <DialogScrim label="Cancel idea deletion" onClose={() => setIdeaToDelete(undefined)}>
          <div aria-labelledby="delete-idea-title" className="form-dialog">
            <header>
              <h2 id="delete-idea-title">Delete “{ideaToDelete.title}”?</h2>
              <p>The idea moves to Deleted ideas and can be restored later.</p>
            </header>
            <MutationError active={changeIdeaLifecycle.isError} />
            <footer>
              <Button onClick={() => setIdeaToDelete(undefined)} variant="quiet">
                Keep idea
              </Button>
              <Button
                disabled={changeIdeaLifecycle.isPending}
                icon={<Trash2 />}
                onClick={() => changeIdeaLifecycle.mutate(ideaToDelete)}
                variant="primary"
              >
                Delete idea
              </Button>
            </footer>
          </div>
        </DialogScrim>
      ) : null}
      {createOpen ? (
        <DialogScrim label="Cancel project creation" onClose={() => setCreateOpen(false)}>
          <form
            aria-labelledby="new-production-title"
            className="form-dialog"
            onSubmit={submitProject}
          >
            <header>
              <h2 id="new-production-title">New production</h2>
              <p>Create the production record. Guided setup continues inside the project.</p>
            </header>
            <label>
              <span>Title</span>
              <input autoFocus minLength={2} name="title" required />
            </label>
            <label>
              <span>Project code</span>
              <input
                autoCapitalize="characters"
                maxLength={24}
                name="code"
                pattern="[A-Za-z0-9-]+"
                required
              />
            </label>
            <ProductionTypeSelect />
            <MutationError active={createProject.isError} />
            <footer>
              <Button onClick={() => setCreateOpen(false)} variant="quiet">
                Cancel
              </Button>
              <Button disabled={createProject.isPending} type="submit" variant="primary">
                {createProject.isPending ? "Creating…" : "Create production"}
              </Button>
            </footer>
          </form>
        </DialogScrim>
      ) : null}
      {ideaEditor ? (
        <DialogScrim label="Cancel idea editing" onClose={() => setIdeaEditor(undefined)}>
          <form aria-labelledby="capture-idea-title" className="form-dialog" onSubmit={submitIdea}>
            <header>
              <h2 id="capture-idea-title">{ideaEditor === "new" ? "Capture idea" : "Edit idea"}</h2>
              <p>Keep the spark and its provenance. Promotion preserves this history.</p>
            </header>
            <label>
              <span>Working title</span>
              <input
                autoFocus
                defaultValue={ideaEditor === "new" ? "" : ideaEditor.title}
                minLength={2}
                name="title"
                required
              />
            </label>
            <label>
              <span>One-sentence idea</span>
              <textarea
                defaultValue={ideaEditor === "new" ? "" : (ideaEditor.summary ?? "")}
                maxLength={1_000}
                name="summary"
                required
                rows={3}
              />
            </label>
            <ProductionTypeSelect
              defaultValue={ideaEditor === "new" ? "short_film" : ideaEditor.type}
            />
            <label>
              <span>Source / inspiration</span>
              <input
                defaultValue={ideaEditor === "new" ? "" : (ideaEditor.source ?? "")}
                maxLength={500}
                name="source"
              />
            </label>
            <label>
              <span>Tags</span>
              <input
                defaultValue={ideaEditor === "new" ? "" : ideaEditor.tags.join(", ")}
                name="tags"
                placeholder="night, memory, Amsterdam"
              />
            </label>
            <label>
              <span>Notes</span>
              <textarea
                defaultValue={ideaEditor === "new" ? "" : ideaEditor.notes}
                maxLength={8_000}
                name="notes"
                rows={4}
              />
            </label>
            <label>
              <span>Reference links</span>
              <textarea
                defaultValue={ideaEditor === "new" ? "" : ideaEditor.links.join("\n")}
                name="links"
                placeholder="One https:// link per line"
                rows={3}
              />
            </label>
            <MutationError active={saveIdea.isError} />
            <footer>
              <Button onClick={() => setIdeaEditor(undefined)} variant="quiet">
                Cancel
              </Button>
              <Button disabled={saveIdea.isPending} type="submit" variant="primary">
                {ideaEditor === "new" ? "Capture idea" : "Save changes"}
              </Button>
            </footer>
          </form>
        </DialogScrim>
      ) : null}
      {promoteIdea ? (
        <DialogScrim label="Cancel idea promotion" onClose={() => setPromoteIdea(undefined)}>
          <form
            aria-labelledby="promote-idea-title"
            className="form-dialog"
            onSubmit={submitPromotion}
          >
            <header>
              <h2 id="promote-idea-title">Promote “{promoteIdea.title}”</h2>
              <p>The same idea record and history will become part of the new production.</p>
            </header>
            <label>
              <span>Project code</span>
              <input
                autoCapitalize="characters"
                maxLength={24}
                name="code"
                pattern="[A-Za-z0-9-]+"
                required
              />
            </label>
            <ProductionTypeSelect defaultValue={promoteIdea.type} />
            <MutationError active={promote.isError} />
            <footer>
              <Button onClick={() => setPromoteIdea(undefined)} variant="quiet">
                Cancel
              </Button>
              <Button
                disabled={promote.isPending}
                icon={<ArrowRight />}
                type="submit"
                variant="primary"
              >
                Promote
              </Button>
            </footer>
          </form>
        </DialogScrim>
      ) : null}
    </section>
  );
}

function DialogScrim({
  label,
  onClose,
  children,
}: {
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="dialog-layer">
      <button aria-label={label} className="dialog-layer__scrim" onClick={onClose} type="button" />
      <div aria-modal="true" role="dialog">
        {children}
      </div>
    </div>
  );
}
function ProductionTypeSelect({ defaultValue = "short_film" }: { readonly defaultValue?: string }) {
  return (
    <label>
      <span>Type</span>
      <select defaultValue={defaultValue} name="type">
        <option value="short_film">Short film</option>
        <option value="narrative_video">Narrative video</option>
        <option value="music_video">Music video</option>
        <option value="youtube">YouTube production</option>
        <option value="commercial">Promotional / commercial</option>
        <option value="episodic">Episodic</option>
      </select>
    </label>
  );
}
function MutationError({ active }: { readonly active: boolean }) {
  return active ? (
    <p className="form-error" role="alert">
      The request could not be completed. Review the fields or current version and try again.
    </p>
  ) : null;
}
function commaList(value: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function lineList(value: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function relativeDay(value: number): string {
  return new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" }).format(
    Math.round((value - Date.now()) / 86_400_000),
    "day",
  );
}
