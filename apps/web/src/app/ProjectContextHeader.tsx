import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ChevronRight } from "lucide-react";
import { Status } from "@swp/ui";

import type { ProjectSummary } from "./schemas";

export function ProjectContextHeader({
  actions,
  project,
  section,
  title,
}: {
  readonly actions?: ReactNode;
  readonly project: ProjectSummary;
  readonly section: string;
  readonly title: string;
}) {
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
            <Status
              tone={
                project.readinessState === "ready"
                  ? "success"
                  : project.readinessState === "stale"
                    ? "warning"
                    : "danger"
              }
            >
              {project.readinessState.replaceAll("_", " ")}
            </Status>
          </div>
          <p>
            {project.title} · {project.phase}
          </p>
        </div>
        {actions ? <div className="project-header__actions">{actions}</div> : null}
      </header>
      <ProjectPulseBar project={project} />
    </>
  );
}

function ProjectPulseBar({ project }: { readonly project: ProjectSummary }) {
  const { moduleKey } = useParams();
  const values = [
    ["Readiness", `${Math.round(project.readinessScore)}%`],
    ["Phase", project.phase],
    ["Status", project.status],
    ["Timezone", project.timezone],
    ["Current view", moduleKey?.replaceAll("-", " ") ?? "Overview"],
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
