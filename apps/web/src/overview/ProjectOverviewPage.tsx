import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  FileText,
  MessageSquareText,
} from "lucide-react";
import { Link, useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { ProgressBar, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";

const dashboardSchema = z.object({
  readiness: z.object({
    score: z.number(),
    blocking: z.number(),
    warnings: z.number(),
    passed: z.number(),
    total: z.number(),
  }),
  script: z.object({
    revisionName: z.string().nullable(),
    approved: z.boolean(),
    unresolvedMappings: z.number(),
    updatedAt: z.number().nullable(),
  }),
  schedule: z.object({
    revisionName: z.string().nullable(),
    shootDate: z.number().nullable(),
    conflicts: z.number(),
  }),
  priorities: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      tone: z.enum(["danger", "warning", "info"]),
      href: z.string(),
    }),
  ),
  departments: z.array(
    z.object({
      name: z.string(),
      ready: z.number(),
      total: z.number(),
      blockers: z.number(),
      href: z.string(),
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string(),
      actor: z.string(),
      action: z.string(),
      objectTitle: z.string(),
      occurredAt: z.number(),
    }),
  ),
  announcements: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      author: z.string(),
      createdAt: z.number(),
    }),
  ),
  overdueTasks: z.number(),
  unconfirmedRecipients: z.number(),
  budgetVarianceMinor: z.number(),
  currency: z.string(),
  archiveHealth: z.enum(["healthy", "requested", "running", "failed", "not_requested"]),
});

export function ProjectOverviewPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const dashboard = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["dashboard", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/dashboard`,
        dashboardSchema,
      ),
    refetchInterval: 30_000,
  });

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  return (
    <section className="project-page overview-page">
      <ProjectContextHeader
        project={activeProject}
        section="Overview"
        title="Production Command Centre"
      />
      {dashboard.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : dashboard.isError ? (
        <SurfaceBoundary state="error" />
      ) : dashboard.data ? (
        <div className="command-grid">
          <section className="ops-panel readiness-panel">
            <header>
              <div>
                <p>Ready to Shoot</p>
                <h2>
                  {dashboard.data.readiness.blocking
                    ? `${dashboard.data.readiness.blocking} blockers remain`
                    : "Gate is clear"}
                </h2>
              </div>
              <CheckCircle2 aria-hidden="true" />
            </header>
            <div
              className="readiness-ring"
              style={
                { "--score": `${dashboard.data.readiness.score * 3.6}deg` } as React.CSSProperties
              }
            >
              <span>
                <strong>{Math.round(dashboard.data.readiness.score)}%</strong>
                <small>ready</small>
              </span>
            </div>
            <ProgressBar
              label={`${dashboard.data.readiness.passed} of ${dashboard.data.readiness.total} checks passed`}
              value={dashboard.data.readiness.score}
            />
            <dl className="metric-row">
              <div>
                <dt>Blocking</dt>
                <dd className="text-danger">{dashboard.data.readiness.blocking}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd className="text-warning">{dashboard.data.readiness.warnings}</dd>
              </div>
              <div>
                <dt>Passed</dt>
                <dd className="text-success">{dashboard.data.readiness.passed}</dd>
              </div>
            </dl>
            <Link className="panel-link" to={`/projects/${activeProject.id}/readiness`}>
              Open readiness control centre <ArrowRight aria-hidden="true" />
            </Link>
          </section>
          <section className="ops-panel priorities-panel">
            <header>
              <div>
                <p>Priority actions</p>
                <h2>Resolve what blocks the plan</h2>
              </div>
              <AlertTriangle aria-hidden="true" />
            </header>
            {dashboard.data.priorities.length ? (
              <ol className="priority-list">
                {dashboard.data.priorities.map((priority) => (
                  <li key={priority.id}>
                    <Status tone={priority.tone}>{priority.tone}</Status>
                    <div>
                      <strong>{priority.title}</strong>
                      <span>{priority.detail}</span>
                    </div>
                    <Link aria-label={`Open ${priority.title}`} to={priority.href}>
                      <ArrowRight />
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="panel-empty">
                <CheckCircle2 aria-hidden="true" />
                <span>No unresolved priority actions.</span>
              </div>
            )}
          </section>
          <section className="ops-panel schedule-panel">
            <header>
              <div>
                <p>Schedule</p>
                <h2>{dashboard.data.schedule.revisionName ?? "No working revision"}</h2>
              </div>
              <CalendarClock aria-hidden="true" />
            </header>
            <dl className="fact-list">
              <div>
                <dt>Shoot date</dt>
                <dd>
                  {dashboard.data.schedule.shootDate
                    ? new Intl.DateTimeFormat("en-GB", {
                        dateStyle: "full",
                        timeZone: activeProject.timezone,
                      }).format(dashboard.data.schedule.shootDate)
                    : "Not scheduled"}
                </dd>
              </div>
              <div>
                <dt>Conflicts</dt>
                <dd>
                  <Status tone={dashboard.data.schedule.conflicts ? "danger" : "success"}>
                    {dashboard.data.schedule.conflicts
                      ? `${dashboard.data.schedule.conflicts} unresolved`
                      : "Clear"}
                  </Status>
                </dd>
              </div>
              <div>
                <dt>Current script</dt>
                <dd>{dashboard.data.script.revisionName ?? "No issued revision"}</dd>
              </div>
              <div>
                <dt>Script sync</dt>
                <dd>
                  <Status tone={dashboard.data.script.unresolvedMappings ? "warning" : "success"}>
                    {dashboard.data.script.unresolvedMappings
                      ? `${dashboard.data.script.unresolvedMappings} decisions`
                      : "Synced"}
                  </Status>
                </dd>
              </div>
            </dl>
            <Link className="panel-link" to={`/projects/${activeProject.id}/schedules`}>
              Open schedule <ArrowRight aria-hidden="true" />
            </Link>
          </section>
          <section className="ops-panel departments-panel">
            <header>
              <div>
                <p>Departments</p>
                <h2>Preparation coverage</h2>
              </div>
              <CircleDashed aria-hidden="true" />
            </header>
            <ul className="department-list">
              {dashboard.data.departments.map((department) => (
                <li key={department.name}>
                  <div>
                    <span>{department.name}</span>
                    <strong>
                      {department.ready}/{department.total}
                    </strong>
                  </div>
                  <ProgressBar
                    label={`${department.name} readiness`}
                    value={department.total ? (department.ready / department.total) * 100 : 0}
                  />
                  {department.blockers ? <small>{department.blockers} blocking</small> : null}
                </li>
              ))}
            </ul>
          </section>
          <section className="ops-panel health-panel">
            <header>
              <div>
                <p>Production health</p>
                <h2>Current operational signals</h2>
              </div>
              <FileText aria-hidden="true" />
            </header>
            <dl className="health-grid">
              <div>
                <dt>Overdue tasks</dt>
                <dd className={dashboard.data.overdueTasks ? "text-danger" : "text-success"}>
                  {dashboard.data.overdueTasks}
                </dd>
              </div>
              <div>
                <dt>Call sheet replies</dt>
                <dd
                  className={dashboard.data.unconfirmedRecipients ? "text-warning" : "text-success"}
                >
                  {dashboard.data.unconfirmedRecipients}
                </dd>
              </div>
              <div>
                <dt>Budget variance</dt>
                <dd>
                  {new Intl.NumberFormat("en-GB", {
                    style: "currency",
                    currency: dashboard.data.currency,
                  }).format(dashboard.data.budgetVarianceMinor / 100)}
                </dd>
              </div>
              <div>
                <dt>Archive</dt>
                <dd>
                  <Status
                    tone={
                      dashboard.data.archiveHealth === "healthy"
                        ? "success"
                        : dashboard.data.archiveHealth === "failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {dashboard.data.archiveHealth.replaceAll("_", " ")}
                  </Status>
                </dd>
              </div>
            </dl>
          </section>
          <section className="ops-panel changes-panel">
            <header>
              <div>
                <p>Recent changes</p>
                <h2>Shared workspace activity</h2>
              </div>
              <MessageSquareText aria-hidden="true" />
            </header>
            {dashboard.data.changes.length ? (
              <ol className="change-list">
                {dashboard.data.changes.map((change) => (
                  <li key={change.id}>
                    <span className="change-avatar" aria-hidden="true">
                      {change.actor.charAt(0)}
                    </span>
                    <div>
                      <p>
                        <strong>{change.actor}</strong> {change.action} <b>{change.objectTitle}</b>
                      </p>
                      <time dateTime={new Date(change.occurredAt).toISOString()}>
                        {new Intl.DateTimeFormat("en-GB", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(change.occurredAt)}
                      </time>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="panel-empty">
                <MessageSquareText aria-hidden="true" />
                <span>No recent activity.</span>
              </div>
            )}
          </section>
          <section className="ops-panel announcements-panel">
            <header>
              <div>
                <p>Announcements</p>
                <h2>Team notes</h2>
              </div>
              <MessageSquareText aria-hidden="true" />
            </header>
            {dashboard.data.announcements.length ? (
              dashboard.data.announcements.map((item) => (
                <article key={item.id}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <footer>
                    {item.author} ·{" "}
                    <time dateTime={new Date(item.createdAt).toISOString()}>
                      {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(
                        item.createdAt,
                      )}
                    </time>
                  </footer>
                </article>
              ))
            ) : (
              <div className="panel-empty">
                <MessageSquareText aria-hidden="true" />
                <span>No announcements.</span>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
