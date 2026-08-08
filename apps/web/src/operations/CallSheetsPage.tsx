import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, FileDown, Plus, Send, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import {
  callSheetDraftSchema,
  callSheetIssueSchema,
  callSheetsSchema,
  recipientIssueSchema,
  type CallSheetDraft,
  type RecipientIssue,
} from "./schemas";

type IssuedLinks = NonNullable<ReturnType<typeof callSheetIssueSchema.parse>["recipientLinks"]>;

export function CallSheetsPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(Boolean(params.get("shootDay")));
  const [issuedLinks, setIssuedLinks] = useState<IssuedLinks>([]);
  const path = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/operations`;
  const callSheets = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["operations", projectId, "call-sheets"],
    queryFn: () => apiRequest(`${path}/call-sheets`, callSheetsSchema),
    refetchInterval: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["operations", projectId] });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiRequest(`${path}/call-sheets`, callSheetDraftSchema, {
        method: "POST",
        body: jsonBody(body),
      }),
    onSuccess: () => {
      setCreating(false);
      void refresh();
    },
  });
  const issue = useMutation({
    mutationFn: ({
      draft,
      supersedesIssueId,
    }: {
      draft: CallSheetDraft;
      supersedesIssueId?: string;
    }) =>
      apiRequest(
        `${path}/call-sheets/${encodeURIComponent(draft.id)}/issue`,
        callSheetIssueSchema,
        {
          method: "POST",
          headers: { "If-Match": `"${draft.version}"`, "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({
            confidentiality: "SINBOD WAYNE — CONFIDENTIAL",
            supersedesIssueId: supersedesIssueId ?? null,
          }),
        },
      ),
    onSuccess: (data) => {
      setIssuedLinks(data.recipientLinks ?? []);
      void refresh();
    },
  });
  const confirm = useMutation({
    mutationFn: (recipient: RecipientIssue) =>
      apiRequest(
        `${path}/call-sheet-recipient-issues/${encodeURIComponent(recipient.recipientIssueId)}/confirm-manual`,
        recipientIssueSchema,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({ note: "Confirmed manually by producer." }),
        },
      ),
    onSuccess: refresh,
  });

  useEffect(() => {
    if (params.get("shootDay")) setCreating(true);
  }, [params]);

  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const shootDayId = String(form.get("shootDayId") ?? "");
    const shootDay = callSheets.data?.shootDays.find((day) => day.id === shootDayId);
    const selected = new Set(form.getAll("recipientId").map(String));
    const fallbackCall = shootDay?.generalCallAt ?? Date.now();
    create.mutate({
      shootDayId,
      callSheetType: "shoot_day",
      title: String(form.get("title") ?? ""),
      paperSize: activeProject?.id ? "A4" : "A4",
      layout: "standard",
      manualWeather: {
        source: "manual",
        summary: String(form.get("weather") ?? ""),
        frozenAt: Date.now(),
      },
      sections: [],
      recipients: (callSheets.data?.people ?? [])
        .filter((person) => selected.has(person.id))
        .map((person) => ({
          personId: person.id,
          label: "Production",
          privateNote: "",
          requiredConfirmation: true,
          calls: [
            {
              label: "General",
              callAt: fallbackCall,
              timezone: shootDay?.timezone ?? activeProject?.timezone ?? "Europe/Amsterdam",
            },
          ],
        })),
    });
  }

  async function copyLink(link: IssuedLinks[number]) {
    await navigator.clipboard.writeText(link.url);
    await apiRequest(
      `${path}/call-sheet-recipient-issues/${encodeURIComponent(link.recipientIssueId)}/link-copied`,
      recipientIssueSchema,
      { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: jsonBody({}) },
    ).catch(() => undefined);
    void refresh();
  }

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;
  return (
    <section className="project-page operations-page">
      <ProjectContextHeader
        project={activeProject}
        section="Documents"
        title="Call Sheets"
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)} variant="primary">
            New call sheet
          </Button>
        }
      />
      <aside className="provider-notice">
        <TriangleAlert aria-hidden="true" />
        <div>
          <strong>Email and SMS: Not configured</strong>
          <p>
            {callSheets.data?.providers.manualFallback ??
              "Secure links, print/download, and manual confirmation remain available."}
          </p>
        </div>
      </aside>
      {issuedLinks.length ? (
        <section aria-labelledby="new-links-title" className="issued-links">
          <header>
            <div>
              <p>Shown once</p>
              <h2 id="new-links-title">Copy recipient links now</h2>
            </div>
            <Button onClick={() => setIssuedLinks([])} variant="quiet">
              Dismiss
            </Button>
          </header>
          <p>
            Only token hashes are stored. These complete URLs cannot be recovered after this panel
            closes; create a replacement scoped link if one is lost.
          </p>
          <ul>
            {issuedLinks.map((link) => (
              <li key={link.recipientIssueId}>
                <div>
                  <strong>{link.displayName}</strong>
                  <small>
                    Expires{" "}
                    {new Intl.DateTimeFormat("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(link.expiresAt)}
                  </small>
                </div>
                <Button icon={<Clipboard />} onClick={() => void copyLink(link)}>
                  Copy secure link
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {callSheets.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : callSheets.isError ? (
        <SurfaceBoundary state="error" />
      ) : callSheets.data?.drafts.length ? (
        <div className="operations-stack">
          {callSheets.data.drafts.map((draft) => {
            const recipients = callSheets.data.recipientIssues.filter(
              (recipient) =>
                recipient.callSheetDraftId === draft.id &&
                recipient.issueNumber === draft.latestIssueNumber,
            );
            return (
              <article className="operations-card" key={draft.id}>
                <header>
                  <div>
                    <p>{draft.callSheetType.replaceAll("_", " ")}</p>
                    <h2>{draft.title}</h2>
                    <span>
                      {draft.shootDate ?? "No date"}
                      {draft.unit ? ` · ${draft.unit}` : ""} · {draft.recipientCount} recipients
                    </span>
                  </div>
                  <Status tone={draft.status === "issued" ? "success" : "warning"}>
                    {draft.status}
                  </Status>
                </header>
                <dl className="issue-metrics">
                  <div>
                    <dt>Pinned schedule</dt>
                    <dd>
                      {draft.sourceScheduleRevisionId
                        ? draft.sourceScheduleRevisionId.slice(0, 13)
                        : "None"}
                    </dd>
                  </div>
                  <div>
                    <dt>Issues</dt>
                    <dd>{draft.issueCount}</dd>
                  </div>
                  <div>
                    <dt>Next issue</dt>
                    <dd>{draft.nextIssueNumber}</dd>
                  </div>
                  <div>
                    <dt>Layout</dt>
                    <dd>
                      {draft.paperSize} · {draft.layout}
                    </dd>
                  </div>
                </dl>
                {recipients.length ? (
                  <div className="recipient-status-list">
                    <h3>Latest recipient variants</h3>
                    <ul>
                      {recipients.map((recipient) => (
                        <li key={recipient.recipientIssueId}>
                          <div>
                            <strong>{recipient.personName}</strong>
                            <small>{recipient.label ?? "Production"}</small>
                          </div>
                          <Status
                            tone={
                              recipient.deliveryState === "confirmed"
                                ? "success"
                                : recipient.deliveryState === "failed"
                                  ? "danger"
                                  : recipient.deliveryState === "viewed"
                                    ? "info"
                                    : "warning"
                            }
                          >
                            {recipient.deliveryState.replaceAll("_", " ")}
                          </Status>
                          {!recipient.confirmedAt ? (
                            <Button
                              disabled={confirm.isPending}
                              icon={<CheckCircle2 />}
                              onClick={() => confirm.mutate(recipient)}
                              variant="quiet"
                            >
                              Confirm manually
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <footer>
                  <Button
                    disabled={!draft.recipientCount || issue.isPending}
                    icon={<Send />}
                    onClick={() => issue.mutate({ draft })}
                    variant="primary"
                  >
                    Issue {draft.nextIssueNumber}
                  </Button>
                  {draft.latestIssueId ? (
                    <>
                      <Button
                        disabled={issue.isPending}
                        onClick={() =>
                          issue.mutate({
                            draft,
                            supersedesIssueId: draft.latestIssueId!,
                          })
                        }
                      >
                        Issue correction
                      </Button>
                      <Link
                        className="swp-button swp-button--quiet"
                        target="_blank"
                        to={`/print/call_sheet_issue/${encodeURIComponent(draft.latestIssueId)}`}
                      >
                        <FileDown aria-hidden="true" /> Print issue {draft.latestIssueNumber}
                      </Link>
                    </>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <SurfaceBoundary
          action={
            <Button onClick={() => setCreating(true)} variant="primary">
              Create from a shoot day
            </Button>
          }
          state="empty"
          title="No call sheets"
        />
      )}
      {create.error || issue.error || confirm.error ? (
        <p className="form-error" role="alert">
          {(create.error ?? issue.error ?? confirm.error)?.message}
        </p>
      ) : null}
      {creating ? (
        <div className="modal-layer" role="presentation">
          <section
            aria-labelledby="call-create-title"
            aria-modal="true"
            className="modal-card modal-card--wide"
            role="dialog"
          >
            <header>
              <div>
                <p>Pinned document draft</p>
                <h2 id="call-create-title">Create call sheet</h2>
              </div>
              <button aria-label="Close" onClick={() => setCreating(false)} type="button">
                ×
              </button>
            </header>
            <form onSubmit={submitCreate}>
              <label>
                Shoot day
                <select defaultValue={params.get("shootDay") ?? ""} name="shootDayId" required>
                  <option disabled value="">
                    Select a shoot day
                  </option>
                  {callSheets.data?.shootDays.map((day) => (
                    <option key={day.id} value={day.id}>
                      {day.shootDate ?? "No date"} · {day.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title
                <input
                  defaultValue="Shoot Day call sheet"
                  maxLength={200}
                  minLength={2}
                  name="title"
                  required
                />
              </label>
              <label>
                Manual weather and contingency
                <textarea
                  maxLength={4_000}
                  name="weather"
                  placeholder="Dry, 14–19 °C. Rain cover held nearby."
                  rows={3}
                />
              </label>
              <fieldset>
                <legend>Recipients</legend>
                <p className="field-help">
                  Only checked people receive recipient-specific immutable variants.
                </p>
                <div className="choice-grid">
                  {callSheets.data?.people.map((person) => (
                    <label className="choice-row" key={person.id}>
                      <input name="recipientId" type="checkbox" value={person.id} />
                      <span>
                        <strong>{person.title}</strong>
                        <small>
                          {person.email ??
                            person.phone ??
                            "No electronic contact — manual link still available"}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <footer>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
                <Button disabled={create.isPending} type="submit" variant="primary">
                  {create.isPending ? "Creating…" : "Create draft"}
                </Button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
