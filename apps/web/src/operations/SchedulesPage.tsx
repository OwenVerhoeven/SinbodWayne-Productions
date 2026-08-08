import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Download, Plus, Sunrise } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import {
  scheduleSummarySchema,
  schedulesSchema,
  shootDaySchema,
  type ScheduleSummary,
} from "./schemas";

export function SchedulesPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const path = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/operations`;
  const schedules = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["operations", projectId, "schedules"],
    queryFn: () => apiRequest(`${path}/schedules`, schedulesSchema),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operations", projectId] });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`${path}/schedules`, scheduleSummarySchema, {
        method: "POST",
        body: jsonBody(body),
      }),
    onSuccess: () => {
      setCreating(false);
      void refresh();
    },
  });
  const approve = useMutation({
    mutationFn: (schedule: ScheduleSummary) =>
      apiRequest(
        `${path}/schedules/${encodeURIComponent(schedule.id)}/approve`,
        z.object({ id: z.string() }).passthrough(),
        {
          method: "POST",
          body: jsonBody({
            name: `${schedule.title} — approved ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(Date.now())}`,
          }),
        },
      ),
    onSuccess: refresh,
  });
  const duplicate = useMutation({
    mutationFn: (schedule: ScheduleSummary) =>
      apiRequest(
        `${path}/schedules/${encodeURIComponent(schedule.id)}/duplicate`,
        scheduleSummarySchema,
        { method: "POST", body: jsonBody({ title: `${schedule.title} copy` }) },
      ),
    onSuccess: refresh,
  });
  const generateDay = useMutation({
    mutationFn: (input: { schedule: ScheduleSummary; generalCallAt: number | null }) =>
      apiRequest(`${path}/shoot-days`, shootDaySchema, {
        method: "POST",
        body: jsonBody({
          scheduleRevisionId: input.schedule.currentRevisionId,
          dayBreakItemId: input.schedule.revision?.dayBreakItemId,
          generalCallAt: input.generalCallAt,
        }),
      }),
    onSuccess: refresh,
  });

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const shootDate = String(form.get("shootDate") ?? "");
    const call = String(form.get("generalCall") ?? "07:00");
    create.mutate({
      title,
      name: `${title} revision 1`,
      isDefault: schedules.data?.items.length === 0,
      items: [
        {
          itemType: "day_break",
          title: "Shoot Day 1",
          shootDate,
          unit: "Main",
          dayCount: 1,
          generalCallLocal: call,
          estimatedStartLocal: call,
          timezone: activeProject?.timezone ?? "Europe/Amsterdam",
          pageEighths: 0,
          prepDurationMs: 0,
          setupDurationMs: 0,
          shootDurationMs: 0,
          moveDurationMs: 0,
          mealDurationMs: 0,
          hardConstraints: [],
          details: {},
          assignments: [],
        },
        {
          itemType: "banner",
          title: "Add approved scenes and operational strips in the next revision",
          shootDate,
          unit: "Main",
          dayCount: 1,
          timezone: activeProject?.timezone ?? "Europe/Amsterdam",
          pageEighths: 0,
          prepDurationMs: 0,
          setupDurationMs: 0,
          shootDurationMs: 0,
          moveDurationMs: 0,
          mealDurationMs: 0,
          hardConstraints: [],
          details: {},
          assignments: [],
        },
      ],
      availability: [],
      travelDurations: [],
    });
  }

  function generate(schedule: ScheduleSummary) {
    const revision = schedule.revision;
    if (!revision?.dayBreakItemId) return;
    const date = window.prompt(
      "General call date and time (local ISO)",
      `${new Date().toISOString().slice(0, 10)}T07:00`,
    );
    const parsed = date ? new Date(date).getTime() : Number.NaN;
    generateDay.mutate({ schedule, generalCallAt: Number.isFinite(parsed) ? parsed : null });
  }

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;
  return (
    <section className="project-page operations-page">
      <ProjectContextHeader
        project={activeProject}
        section="Scheduling"
        title="Schedules & Stripboards"
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)} variant="primary">
            New variant
          </Button>
        }
      />
      <div className="operations-toolbar">
        <p>
          Variants preserve immutable revisions. Approval creates a new pinned revision; it never
          mutates a working one.
        </p>
      </div>
      {schedules.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : schedules.isError ? (
        <SurfaceBoundary state="error" />
      ) : schedules.data?.items.length ? (
        <div className="operations-table-wrap">
          <table className="operations-table">
            <thead>
              <tr>
                <th>Variant</th>
                <th>Revision</th>
                <th>Pages</th>
                <th>Plan time</th>
                <th>Conflicts</th>
                <th>Status</th>
                <th>
                  <span className="swp-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {schedules.data.items.map((schedule) => (
                <tr key={schedule.id}>
                  <td data-label="Variant">
                    <strong>{schedule.title}</strong>
                    {schedule.isDefault ? <small>Working default</small> : null}
                  </td>
                  <td data-label="Revision">
                    {schedule.revision ? (
                      <>
                        <span>{schedule.revision.name}</span>
                        <small>
                          r{schedule.revision.revisionNumber} · {schedule.revision.itemCount} strips
                        </small>
                      </>
                    ) : (
                      "No revision"
                    )}
                  </td>
                  <td data-label="Pages">
                    {schedule.revision ? formatEighths(schedule.revision.totals.pageEighths) : "—"}
                  </td>
                  <td data-label="Plan time">
                    {schedule.revision ? formatDuration(schedule.revision.totals.totalMs) : "—"}
                  </td>
                  <td data-label="Conflicts">
                    <Status tone={schedule.revision?.openConflicts ? "danger" : "success"}>
                      {schedule.revision?.openConflicts
                        ? `${schedule.revision.openConflicts} open`
                        : "Clear"}
                    </Status>
                  </td>
                  <td data-label="Status">
                    <Status
                      tone={
                        schedule.approvedRevisionId === schedule.currentRevisionId
                          ? "success"
                          : "warning"
                      }
                    >
                      {schedule.approvedRevisionId === schedule.currentRevisionId
                        ? "Approved"
                        : "Working"}
                    </Status>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        disabled={!schedule.currentRevisionId || approve.isPending}
                        icon={<CheckCircle2 />}
                        onClick={() => approve.mutate(schedule)}
                        variant="quiet"
                      >
                        Approve snapshot
                      </Button>
                      <Button
                        disabled={!schedule.currentRevisionId || duplicate.isPending}
                        icon={<Copy />}
                        onClick={() => duplicate.mutate(schedule)}
                        variant="quiet"
                      >
                        Duplicate
                      </Button>
                      <Button
                        disabled={!schedule.revision?.dayBreakItemId || generateDay.isPending}
                        icon={<Sunrise />}
                        onClick={() => generate(schedule)}
                        variant="quiet"
                      >
                        Generate day
                      </Button>
                      {schedule.currentRevisionId ? (
                        <a
                          className="swp-button swp-button--quiet"
                          href={`${path}/schedules/${encodeURIComponent(schedule.id)}/revisions/${encodeURIComponent(schedule.currentRevisionId)}/export.csv`}
                        >
                          <Download aria-hidden="true" /> CSV
                        </a>
                      ) : null}
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
            <Button onClick={() => setCreating(true)} variant="primary">
              Create the first schedule
            </Button>
          }
          state="empty"
          title="No schedule variants"
        />
      )}
      {create.error || approve.error || duplicate.error || generateDay.error ? (
        <p className="form-error" role="alert">
          {String(
            (create.error ?? approve.error ?? duplicate.error ?? generateDay.error) instanceof Error
              ? (create.error ?? approve.error ?? duplicate.error ?? generateDay.error)?.message
              : "The operation failed.",
          )}
        </p>
      ) : null}
      {creating ? (
        <div className="modal-layer" role="presentation">
          <section
            aria-labelledby="schedule-create-title"
            aria-modal="true"
            className="modal-card"
            role="dialog"
          >
            <header>
              <div>
                <p>New explicit variant</p>
                <h2 id="schedule-create-title">Create schedule</h2>
              </div>
              <button aria-label="Close" onClick={() => setCreating(false)} type="button">
                ×
              </button>
            </header>
            <form onSubmit={submitCreate}>
              <label>
                Variant name
                <input
                  autoFocus
                  maxLength={200}
                  minLength={2}
                  name="title"
                  placeholder="Primary schedule"
                  required
                />
              </label>
              <div className="form-grid">
                <label>
                  Shoot date
                  <input
                    defaultValue={new Date().toISOString().slice(0, 10)}
                    name="shootDate"
                    required
                    type="date"
                  />
                </label>
                <label>
                  General call
                  <input defaultValue="07:00" name="generalCall" required type="time" />
                </label>
              </div>
              <p className="field-help">
                The first revision starts with a day break and editable planning banner. Add scene
                strips through a subsequent revision/API import.
              </p>
              <footer>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
                <Button disabled={create.isPending} type="submit" variant="primary">
                  {create.isPending ? "Creating…" : "Create variant"}
                </Button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function formatEighths(value: number): string {
  return `${Math.floor(value / 8)} ${value % 8}/8`;
}
function formatDuration(value: number): string {
  const minutes = Math.floor(value / 60_000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
