import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck2, ClipboardCheck, RefreshCw } from "lucide-react";
import { Link, useOutletContext, useParams } from "react-router";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { shootDaySchema, shootDaysSchema, type ShootDay } from "./schemas";

export function ShootDaysPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const path = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/operations`;
  const days = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["operations", projectId, "shoot-days"],
    queryFn: () => apiRequest(`${path}/shoot-days`, shootDaysSchema),
    refetchInterval: 30_000,
  });
  const update = useMutation({
    mutationFn: ({ day, status }: { day: ShootDay; status: "approved" | "planned" }) =>
      apiRequest(`${path}/shoot-days/${encodeURIComponent(day.id)}`, shootDaySchema, {
        method: "PATCH",
        headers: { "If-Match": `"${day.version}"` },
        body: jsonBody({ status }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["operations", projectId] }),
  });
  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;
  return (
    <section className="project-page operations-page">
      <ProjectContextHeader
        project={activeProject}
        section="Scheduling"
        title="Shoot Days"
        actions={
          <Link
            className="swp-button swp-button--primary"
            to={`/projects/${activeProject.id}/schedules`}
          >
            <CalendarCheck2 aria-hidden="true" /> Build from schedule
          </Link>
        }
      />
      <div className="operations-toolbar">
        <p>
          Each day pins one immutable schedule revision. A newer schedule revision marks the
          generated day stale without rewriting its source.
        </p>
        <Button
          disabled={days.isFetching}
          icon={<RefreshCw />}
          onClick={() => void days.refetch()}
          variant="quiet"
        >
          Refresh
        </Button>
      </div>
      {days.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : days.isError ? (
        <SurfaceBoundary state="error" />
      ) : days.data?.items.length ? (
        <div className="operations-table-wrap">
          <table className="operations-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Date & call</th>
                <th>Pinned revision</th>
                <th>Conflicts</th>
                <th>Readiness</th>
                <th>
                  <span className="swp-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {days.data.items.map((day) => (
                <tr key={day.id}>
                  <td data-label="Day">
                    <strong>{day.title}</strong>
                    <small>
                      {day.unit} · day {day.dayCount}
                    </small>
                  </td>
                  <td data-label="Date & call">
                    <span>
                      {day.shootDate
                        ? new Intl.DateTimeFormat("en-GB", {
                            dateStyle: "medium",
                            timeZone: "UTC",
                          }).format(new Date(`${day.shootDate}T12:00:00Z`))
                        : "Date not set"}
                    </span>
                    <small>
                      {day.generalCallAt
                        ? `Call ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: day.timezone }).format(day.generalCallAt)}`
                        : "Call not set"}
                      {day.estimatedWrapAt
                        ? ` · wrap ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: day.timezone }).format(day.estimatedWrapAt)}`
                        : ""}
                    </small>
                  </td>
                  <td data-label="Pinned revision">
                    <span>{day.revisionName ?? "No source"}</span>
                    {day.scheduleStale ? (
                      <Status tone="warning">Stale source</Status>
                    ) : (
                      <small>Current</small>
                    )}
                  </td>
                  <td data-label="Conflicts">
                    <Status tone={day.openConflicts ? "danger" : "success"}>
                      {day.openConflicts ? `${day.openConflicts} open` : "Clear"}
                    </Status>
                  </td>
                  <td data-label="Readiness">
                    <Status
                      tone={
                        day.readinessState === "ready"
                          ? "success"
                          : day.readinessState === "warning" || day.readinessState === "stale"
                            ? "warning"
                            : "danger"
                      }
                    >
                      {day.readinessState.replaceAll("_", " ")}
                    </Status>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({
                            day,
                            status: day.status === "approved" ? "planned" : "approved",
                          })
                        }
                        variant="quiet"
                      >
                        {day.status === "approved" ? "Return to plan" : "Approve day"}
                      </Button>
                      <Link
                        className="swp-button swp-button--quiet"
                        to={`/projects/${activeProject.id}/call-sheets?shootDay=${encodeURIComponent(day.id)}`}
                      >
                        <ClipboardCheck aria-hidden="true" /> Call sheet
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <SurfaceBoundary
          action={
            <Link
              className="swp-button swp-button--primary"
              to={`/projects/${activeProject.id}/schedules`}
            >
              Generate from schedule
            </Link>
          }
          state="empty"
          title="No shoot days generated"
        />
      )}
      {update.error ? (
        <p className="form-error" role="alert">
          {update.error.message}
        </p>
      ) : null}
    </section>
  );
}
