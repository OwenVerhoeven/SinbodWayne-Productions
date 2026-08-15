import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpenText, Film, Lightbulb, ScrollText } from "lucide-react";
import { Link, useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { domainRecordListSchema } from "../app/schemas";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { countWords, detailText, formatRelativeTime } from "../creative/record-utils";
import {
  creativeStatusLabel,
  creativeStatusTone,
  useCreativeProgress,
} from "../creative/creative-progress";

const screenplaySummarySchema = z.object({
  id: z.string(),
  version: z.number(),
  sceneNumbersLocked: z.boolean(),
  currentRevision: z.object({ name: z.string() }).nullable(),
  scenes: z.array(z.object({ id: z.string(), pageEighths: z.number(), omitted: z.boolean() })),
  blocks: z.array(z.object({ text: z.string() })),
});

export function ProjectOverviewPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const ideaEndpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/records/idea`;
  const storyEndpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/records/development_document`;
  const ideas = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["records", projectId, "idea", "rank"],
    queryFn: () =>
      apiRequest(`${ideaEndpoint}?limit=100&state=active&order=rank`, domainRecordListSchema),
  });
  const stories = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["records", projectId, "development_document", "story"],
    queryFn: () => apiRequest(`${storyEndpoint}?limit=100&state=active`, domainRecordListSchema),
  });
  const screenplay = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["screenplay-summary", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/screenplay`,
        screenplaySummarySchema,
      ),
  });
  const progress = useCreativeProgress(projectId);

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  const rankedIdeas = ideas.data?.items ?? [];
  const strongestIdea = rankedIdeas[0];
  const story = stories.data?.items.find(
    (record) => detailText(record, "documentType") === "story",
  );
  const storyWords = countWords(detailText(story, "body"));
  const scriptWords =
    screenplay.data?.blocks.reduce((total, block) => total + countWords(block.text), 0) ?? 0;
  const scriptPages =
    screenplay.data?.scenes.reduce(
      (total, scene) => total + (scene.omitted ? 0 : scene.pageEighths),
      0,
    ) ?? 0;
  const moduleStatus = (key: "idea_box" | "story" | "screenplay") =>
    progress.data?.modules.find((module) => module.key === key)?.status ?? "not_yet_started";

  return (
    <section className="project-page focused-overview">
      <ProjectContextHeader
        creativeModule="overview"
        project={activeProject}
        section="Creative studio"
        title="Project Overview"
      />
      <header className="focused-overview__hero">
        <div>
          <p className="eyebrow">The creative room</p>
          <h2>{activeProject.workingTitle || activeProject.title}</h2>
          <p>
            Keep the path simple: collect the spark, discover the story, then write the screenplay.
            Everything here is shared with your team and protected by the same project permissions.
          </p>
        </div>
        <div className="focused-overview__identity" aria-label="Project identity">
          <Film aria-hidden="true" />
          <dl>
            <div>
              <dt>Project</dt>
              <dd>{activeProject.code}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>{activeProject.type.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Phase</dt>
              <dd>{activeProject.phase}</dd>
            </div>
          </dl>
        </div>
      </header>
      <ol className="creative-path">
        <li>
          <article className="creative-path__card creative-path__card--ideas">
            <header>
              <span>01</span>
              <Lightbulb aria-hidden="true" />
            </header>
            <div>
              <p>Collect</p>
              <h3>Idea Box</h3>
              <p>
                Capture thoughts without turning them into forms. Rank the ones worth returning to.
              </p>
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>
                  <Status tone={creativeStatusTone(moduleStatus("idea_box"))}>
                    {creativeStatusLabel(moduleStatus("idea_box"))}
                  </Status>
                </dd>
              </div>
              <div>
                <dt>Ideas</dt>
                <dd>{rankedIdeas.length}</dd>
              </div>
              <div>
                <dt>Top spark</dt>
                <dd>{strongestIdea?.title ?? "Nothing captured yet"}</dd>
              </div>
              {strongestIdea ? (
                <div>
                  <dt>Last shaped</dt>
                  <dd>{formatRelativeTime(strongestIdea.updatedAt)}</dd>
                </div>
              ) : null}
            </dl>
            <Link to={`/projects/${activeProject.id}/ideas`}>
              {rankedIdeas.length ? "Open the box" : "Capture the first idea"}{" "}
              <ArrowRight aria-hidden="true" />
            </Link>
          </article>
        </li>
        <li>
          <article className="creative-path__card creative-path__card--story">
            <header>
              <span>02</span>
              <BookOpenText aria-hidden="true" />
            </header>
            <div>
              <p>Discover</p>
              <h3>The Story</h3>
              <p>
                Write freely in prose while the story compass keeps character, desire, stakes and
                theme visible.
              </p>
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>
                  <Status tone={creativeStatusTone(moduleStatus("story"))}>
                    {creativeStatusLabel(moduleStatus("story"))}
                  </Status>
                </dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{storyWords.toLocaleString("en-GB")} words</dd>
              </div>
              <div>
                <dt>Compass</dt>
                <dd>
                  {story
                    ? `${["premise", "protagonist", "want", "obstacle", "stakes", "ending", "theme"].filter((key) => detailText(story, key).trim()).length}/7 answered`
                    : "Waiting for the story"}
                </dd>
              </div>
            </dl>
            <Link to={`/projects/${activeProject.id}/story`}>
              {story ? "Continue the story" : "Start the story"} <ArrowRight aria-hidden="true" />
            </Link>
          </article>
        </li>
        <li>
          <article className="creative-path__card creative-path__card--screenplay">
            <header>
              <span>03</span>
              <ScrollText aria-hidden="true" />
            </header>
            <div>
              <p>Write for the screen</p>
              <h3>Screenplay</h3>
              <p>
                Move into structured screenplay elements, scene navigation and immutable revisions.
              </p>
            </div>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>
                  <Status tone={creativeStatusTone(moduleStatus("screenplay"))}>
                    {creativeStatusLabel(moduleStatus("screenplay"))}
                  </Status>
                </dd>
              </div>
              <div>
                <dt>Scenes</dt>
                <dd>{screenplay.data?.scenes.length ?? 0}</dd>
              </div>
              <div>
                <dt>Pages</dt>
                <dd>
                  {Math.floor(scriptPages / 8)} {scriptPages % 8 ? `${scriptPages % 8}/8` : ""}
                </dd>
              </div>
              <div>
                <dt>Current revision</dt>
                <dd>{screenplay.data?.currentRevision?.name ?? "Working draft"}</dd>
              </div>
              <div>
                <dt>Script words</dt>
                <dd>{scriptWords.toLocaleString("en-GB")}</dd>
              </div>
            </dl>
            <Link to={`/projects/${activeProject.id}/screenplay`}>
              Open screenplay <ArrowRight aria-hidden="true" />
            </Link>
          </article>
        </li>
      </ol>
    </section>
  );
}
