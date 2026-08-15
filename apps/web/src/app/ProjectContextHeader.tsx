import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { Button, Status } from "@swp/ui";

import type { ProjectSummary } from "./schemas";
import { useAuth } from "../auth/auth-context";
import {
  creativeStatusLabel,
  creativeStatusTone,
  type CreativeModule,
  useCreativeProgress,
  useToggleCreativeCompletion,
} from "../creative/creative-progress";

export function ProjectContextHeader({
  actions,
  creativeModule,
  project,
  section,
  title,
}: {
  readonly actions?: ReactNode;
  readonly creativeModule?: CreativeModule;
  readonly project: ProjectSummary;
  readonly section: string;
  readonly title: string;
}) {
  const auth = useAuth();
  const progress = useCreativeProgress(creativeModule ? project.id : undefined);
  const completion = useToggleCreativeCompletion(project.id);
  const moduleProgress = progress.data?.modules.find((module) => module.key === creativeModule);
  const displayedStatus =
    creativeModule === "overview"
      ? (progress.data?.projectStatus ?? project.creativeStatus)
      : moduleProgress?.status;
  const canEdit = auth.account?.role !== "viewer";

  return (
    <>
      <header className="project-header">
        <div>
          <nav aria-label="Breadcrumb" className="breadcrumb">
            <Link to="/projects">Projects</Link>
            <ChevronRight aria-hidden="true" />
            <Link to={`/projects/${project.id}/overview`}>{project.code}</Link>
            <ChevronRight aria-hidden="true" />
            <span aria-current="page">{section}</span>
          </nav>
          <div className="project-header__title">
            <h1>{title}</h1>
            {displayedStatus ? (
              <Status tone={creativeStatusTone(displayedStatus)}>
                {creativeStatusLabel(displayedStatus)}
              </Status>
            ) : null}
          </div>
          <p>
            {project.title} · {project.phase}
          </p>
        </div>
        {actions || (creativeModule && moduleProgress && canEdit) ? (
          <div className="project-header__actions">
            {actions}
            {creativeModule && moduleProgress && canEdit ? (
              <Button
                disabled={completion.isPending}
                onClick={() =>
                  completion.mutate({
                    moduleKey: creativeModule,
                    completed: !moduleProgress.completed,
                    version: progress.data?.version ?? project.version,
                  })
                }
                variant={moduleProgress.completed ? "quiet" : "primary"}
              >
                {moduleProgress.completed ? "Undo completion" : "Mark complete"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      <ProjectPulseBar project={project} writingStatus={progress.data?.projectStatus} />
      {completion.isError ? (
        <div className="conflict-banner" role="alert">
          The writing status changed elsewhere. Refresh the project and try again.
        </div>
      ) : null}
    </>
  );
}

function ProjectPulseBar({
  project,
  writingStatus,
}: {
  readonly project: ProjectSummary;
  readonly writingStatus: string | undefined;
}) {
  const values = [
    ["Writing", creativeStatusLabel(writingStatus ?? project.creativeStatus)],
    ["Phase", project.phase],
    ["Status", project.status],
    ["Timezone", project.timezone],
  ];
  return (
    <dl className="project-pulse">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
