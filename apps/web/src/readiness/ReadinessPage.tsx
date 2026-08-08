import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, FileCheck2, History, ShieldAlert } from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, ProgressBar, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";

const readinessSchema = z.object({
  evaluationId: z.string(),
  evaluatedAt: z.number(),
  score: z.number(),
  state: z.enum(["blocked", "ready", "stale"]),
  staleReasons: z.array(z.string()),
  summary: z.object({
    blocking: z.number(),
    warnings: z.number(),
    passed: z.number(),
    notApplicable: z.number(),
    total: z.number(),
  }),
  groups: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      passed: z.number(),
      total: z.number(),
      results: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          description: z.string(),
          status: z.enum(["passed", "warning", "blocking", "not_applicable", "overridden"]),
          owner: z.string().nullable(),
          dueAt: z.number().nullable(),
          sourceLabel: z.string().nullable(),
          resolutionHref: z.string().nullable(),
          overrideAllowed: z.boolean(),
          ownerOnly: z.boolean(),
          evidence: z.string().nullable(),
        }),
      ),
    }),
  ),
  latestIssue: z
    .object({
      id: z.string(),
      issueNumber: z.number(),
      issuedAt: z.number(),
      actor: z.string(),
      manifestHash: z.string(),
      staleAt: z.number().nullable(),
    })
    .nullable(),
});

type ReadinessResult = z.infer<typeof readinessSchema>["groups"][number]["results"][number];

export function ReadinessPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const [overrideTarget, setOverrideTarget] = useState<ReadinessResult>();
  const readiness = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["readiness", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/readiness`,
        readinessSchema,
      ),
    refetchInterval: 15_000,
  });
  const evaluate = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/readiness/evaluate`,
        readinessSchema,
        { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: async (value) => queryClient.setQueryData(["readiness", projectId], value),
  });
  const issue = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/readiness/issues`,
        z.object({ issueId: z.string(), issueNumber: z.number() }),
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({ evaluationId: readiness.data?.evaluationId }),
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["readiness", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const override = useMutation({
    mutationFn: (input: { resultId: string; reason: string; expiresAt?: number }) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/readiness/overrides`,
        z.object({ overrideId: z.string() }),
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody(input),
        },
      ),
    onSuccess: async () => {
      setOverrideTarget(undefined);
      await queryClient.invalidateQueries({ queryKey: ["readiness", projectId] });
    },
  });

  const canIssue = readiness.data?.summary.blocking === 0 && readiness.data.state !== "stale";
  const groupedBlockers = useMemo(
    () =>
      readiness.data?.groups.reduce(
        (total, group) =>
          total + group.results.filter((result) => result.status === "blocking").length,
        0,
      ) ?? 0,
    [readiness.data],
  );

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  function submitOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overrideTarget) return;
    const form = new FormData(event.currentTarget);
    const expiry = String(form.get("expiresAt") ?? "");
    override.mutate({
      resultId: overrideTarget.id,
      reason: String(form.get("reason") ?? ""),
      ...(expiry ? { expiresAt: new Date(expiry).getTime() } : {}),
    });
  }

  return (
    <section className="project-page readiness-page">
      <ProjectContextHeader
        actions={
          <>
            <Button
              icon={<History />}
              onClick={() =>
                window.open(
                  `/print/readiness/${readiness.data?.latestIssue?.id ?? readiness.data?.evaluationId}`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Print summary
            </Button>
            <Button
              disabled={!canIssue || issue.isPending}
              icon={<FileCheck2 />}
              onClick={() => issue.mutate()}
              title={
                !canIssue
                  ? `${groupedBlockers} blocking checks remain or the evaluation is stale.`
                  : undefined
              }
              variant="primary"
            >
              {issue.isPending ? "Freezing…" : "Mark Ready to Shoot"}
            </Button>
          </>
        }
        project={activeProject}
        section="Readiness"
        title="Ready to Shoot"
      />
      {readiness.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : readiness.isError ? (
        <SurfaceBoundary state="error" />
      ) : readiness.data ? (
        <>
          {readiness.data.state === "stale" ? (
            <div className="stale-banner" role="alert">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>The latest Ready to Shoot issue is stale.</strong>
                <ul>
                  {readiness.data.staleReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
              <Button
                disabled={evaluate.isPending}
                onClick={() => evaluate.mutate()}
                variant="secondary"
              >
                Re-evaluate
              </Button>
            </div>
          ) : null}
          {readiness.data.latestIssue ? (
            <section aria-label="Latest readiness issue" className="readiness-issue">
              <div>
                <p>Immutable issue</p>
                <h2>Ready to Shoot issue {readiness.data.latestIssue.issueNumber}</h2>
              </div>
              <Status tone={readiness.data.latestIssue.staleAt ? "warning" : "success"}>
                {readiness.data.latestIssue.staleAt ? "stale" : "issued"}
              </Status>
              <dl>
                <div>
                  <dt>Issued by</dt>
                  <dd>{readiness.data.latestIssue.actor}</dd>
                </div>
                <div>
                  <dt>Issued</dt>
                  <dd>
                    <time dateTime={new Date(readiness.data.latestIssue.issuedAt).toISOString()}>
                      {new Intl.DateTimeFormat("en-GB", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(readiness.data.latestIssue.issuedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Manifest SHA-256</dt>
                  <dd>
                    <code title={readiness.data.latestIssue.manifestHash}>
                      {readiness.data.latestIssue.manifestHash.slice(0, 20)}...
                    </code>
                  </dd>
                </div>
              </dl>
            </section>
          ) : null}
          <div className="readiness-summary">
            <div className="readiness-summary__score">
              <span>{Math.round(readiness.data.score)}%</span>
              <ProgressBar label="Project readiness" value={readiness.data.score} />
            </div>
            <dl>
              <div>
                <dt>Blocking</dt>
                <dd className="text-danger">{readiness.data.summary.blocking}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd className="text-warning">{readiness.data.summary.warnings}</dd>
              </div>
              <div>
                <dt>Passed</dt>
                <dd className="text-success">{readiness.data.summary.passed}</dd>
              </div>
              <div>
                <dt>Evaluated</dt>
                <dd>
                  <time dateTime={new Date(readiness.data.evaluatedAt).toISOString()}>
                    {new Intl.DateTimeFormat("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(readiness.data.evaluatedAt)}
                  </time>
                </dd>
              </div>
            </dl>
          </div>
          <div className="readiness-groups">
            {readiness.data.groups.map((group) => (
              <details key={group.key} open>
                <summary>
                  <div>
                    <h2>{group.label}</h2>
                    <span>
                      {group.passed} of {group.total} passed
                    </span>
                  </div>
                  <ProgressBar
                    label={`${group.label} readiness`}
                    value={group.total ? (group.passed / group.total) * 100 : 0}
                  />
                </summary>
                <div className="readiness-results">
                  {group.results.map((result) => (
                    <article
                      className={`readiness-result readiness-result--${result.status}`}
                      key={result.id}
                    >
                      <span className="readiness-result__mark" aria-hidden="true">
                        {result.status === "passed" ? (
                          <Check />
                        ) : result.status === "blocking" ? (
                          <ShieldAlert />
                        ) : (
                          <AlertTriangle />
                        )}
                      </span>
                      <div>
                        <div className="readiness-result__title">
                          <h3>{result.label}</h3>
                          <Status
                            tone={
                              result.status === "passed"
                                ? "success"
                                : result.status === "blocking"
                                  ? "danger"
                                  : result.status === "overridden"
                                    ? "purple"
                                    : "warning"
                            }
                          >
                            {result.status.replaceAll("_", " ")}
                          </Status>
                        </div>
                        <p>{result.description}</p>
                        <dl>
                          <div>
                            <dt>Owner</dt>
                            <dd>{result.owner ?? "Unassigned"}</dd>
                          </div>
                          <div>
                            <dt>Source</dt>
                            <dd>{result.sourceLabel ?? "Missing"}</dd>
                          </div>
                          {result.evidence ? (
                            <div>
                              <dt>Evidence</dt>
                              <dd>{result.evidence}</dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>
                      <div className="readiness-result__actions">
                        {result.resolutionHref ? (
                          <a href={result.resolutionHref}>
                            Open source <ArrowRight />
                          </a>
                        ) : null}
                        {result.overrideAllowed ? (
                          <Button onClick={() => setOverrideTarget(result)} variant="quiet">
                            Override
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
          <div className="mobile-sticky-action">
            <Button
              disabled={!canIssue || issue.isPending}
              onClick={() => issue.mutate()}
              title={!canIssue ? `${groupedBlockers} blocking checks remain.` : undefined}
              variant="primary"
            >
              Mark Ready to Shoot
            </Button>
            {!canIssue ? <span>{groupedBlockers} blocking checks remain</span> : null}
          </div>
        </>
      ) : null}
      {overrideTarget ? (
        <div className="dialog-layer">
          <button
            aria-label="Cancel override"
            className="dialog-layer__scrim"
            onClick={() => setOverrideTarget(undefined)}
            type="button"
          />
          <form
            aria-labelledby="override-title"
            aria-modal="true"
            className="form-dialog"
            onSubmit={submitOverride}
            role="dialog"
          >
            <header>
              <div>
                <p>Readiness override</p>
                <h2 id="override-title">{overrideTarget.label}</h2>
              </div>
            </header>
            <p className="warning-copy">
              An override records accepted risk; it does not resolve the source requirement.
            </p>
            <label>
              <span>Reason</span>
              <textarea minLength={12} name="reason" required rows={5} />
            </label>
            <label>
              <span>Expires (optional)</span>
              <input name="expiresAt" type="datetime-local" />
            </label>
            {overrideTarget.ownerOnly ? (
              <p className="owner-only-note">
                <ShieldAlert /> This category requires Workspace Owner authority.
              </p>
            ) : null}
            <footer>
              <Button onClick={() => setOverrideTarget(undefined)} variant="quiet">
                Cancel
              </Button>
              <Button disabled={override.isPending} type="submit" variant="danger">
                Record override
              </Button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
