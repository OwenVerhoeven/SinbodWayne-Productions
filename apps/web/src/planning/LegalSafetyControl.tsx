import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileWarning, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { Button, Status, SurfaceBoundary } from "@swp/ui";
import { z } from "zod";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import { useAuth } from "../auth/auth-context";
import { DialogFrame, Field } from "./BudgetControl";
import type { PlanningControls } from "./schemas";

type Requirement = PlanningControls["legalSafety"]["requirements"][number];
type DialogState =
  | { readonly kind: "requirement"; readonly record?: Requirement }
  | { readonly kind: "risk" }
  | { readonly kind: "hazard"; readonly riskId: string }
  | { readonly kind: "control"; readonly hazardId: string }
  | { readonly kind: "hold" }
  | { readonly kind: "release"; readonly holdId: string; readonly title: string };

const resultSchema = z.unknown();
const requirementTypes = [
  ["chain_of_title", "Chain of title"],
  ["writer_creator_agreement", "Writer / creator agreement"],
  ["cast_crew_agreement", "Cast / crew agreement"],
  ["deal_memo", "Deal memo"],
  ["appearance_release", "Appearance release"],
  ["location_release", "Location release"],
  ["minor_guardian_permission", "Minor / guardian permission"],
  ["permit", "Permit"],
  ["insurance", "Insurance certificate"],
  ["music_rights", "Music / sync / master rights"],
  ["artwork_clearance", "Artwork clearance"],
  ["archive_clearance", "Archive clearance"],
  ["trademark_clearance", "Trademark clearance"],
  ["product_clearance", "Product clearance"],
  ["drone_permission", "Drone permission"],
  ["road_permission", "Road permission"],
  ["fire_permission", "Fire permission"],
  ["animal_permission", "Animal permission"],
  ["weapon_permission", "Weapon permission"],
  ["stunt_permission", "Stunt permission"],
  ["special_effect_permission", "Special-effect permission"],
  ["public_space_permission", "Public-space permission"],
  ["privacy_consent", "Privacy / consent"],
  ["custom", "Custom requirement"],
] as const;

export function LegalSafetyControl({
  data,
  endpoint,
  projectId,
}: {
  readonly data: PlanningControls;
  readonly endpoint: string;
  readonly projectId: string;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>();
  const [error, setError] = useState<string>();
  const requirements = data.legalSafety.requirements.filter((row) => !row.archivedAt);
  const activeHolds = data.legalSafety.legalHolds.filter((hold) => !hold.releasedAt);
  const now = Date.now();
  const expiring = requirements.filter(
    (row) => row.expiresAt && row.expiresAt <= now + 30 * 86_400_000 && row.expiresAt > now,
  ).length;
  const blockers = requirements.filter(
    (row) => row.isBlocking && !["approved", "executed", "not_required"].includes(row.status),
  ).length;
  const openHazards = data.legalSafety.risks
    .flatMap((risk) => risk.hazards)
    .filter((hazard) => !hazard.archivedAt && !["closed", "accepted"].includes(hazard.status));
  const mutation = useMutation({
    mutationFn: (input: {
      path: string;
      method?: "POST" | "PATCH";
      body: unknown;
      version?: number | undefined;
    }) =>
      apiRequest(`${endpoint}${input.path}`, resultSchema, {
        method: input.method ?? "POST",
        ...(input.version === undefined ? {} : { headers: { "If-Match": `"${input.version}"` } }),
        body: jsonBody(input.body),
      }),
    onError: (failure) =>
      setError(
        failure instanceof ApiError
          ? failure.message
          : "The legal or safety record could not be saved.",
      ),
    onSuccess: async () => {
      setDialog(undefined);
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["planning-controls", projectId] });
    },
  });

  return (
    <>
      <section aria-label="Legal and safety summary" className="planning-metrics">
        <Metric
          label="Blocking requirements"
          tone={blockers ? "danger" : "success"}
          value={String(blockers)}
        />
        <Metric
          label="Expiring in 30 days"
          tone={expiring ? "warning" : undefined}
          value={String(expiring)}
        />
        <Metric
          label="Open hazards"
          tone={openHazards.length ? "warning" : "success"}
          value={String(openHazards.length)}
        />
        <Metric
          label="Active legal holds"
          tone={activeHolds.length ? "danger" : undefined}
          value={String(activeHolds.length)}
        />
      </section>
      <div className="planning-provider-note" role="status">
        <FileWarning aria-hidden="true" />
        <div>
          <strong>External signature · Not configured</strong>
          <span>{data.legalSafety.providers.externalSignature.manualFallback}</span>
        </div>
        <Link to={`/projects/${encodeURIComponent(projectId)}/files`}>Upload signed evidence</Link>
      </div>
      <div className="planning-split">
        <section className="planning-section">
          <header>
            <div>
              <h2>Requirement register</h2>
              <p>
                Restricted by default. The application tracks evidence; it does not make legal
                determinations.
              </p>
            </div>
            <Button
              icon={<Plus />}
              onClick={() => setDialog({ kind: "requirement" })}
              variant="primary"
            >
              Add requirement
            </Button>
          </header>
          {requirements.length ? (
            <div className="record-table-wrap">
              <table className="record-table planning-table">
                <thead>
                  <tr>
                    <th>Requirement</th>
                    <th>Type</th>
                    <th>Due / expiry</th>
                    <th>Evidence</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.map((row) => (
                    <tr key={row.id}>
                      <th data-label="Requirement" scope="row">
                        <button
                          className="record-title"
                          onClick={() => setDialog({ kind: "requirement", record: row })}
                          type="button"
                        >
                          <strong>{row.title}</strong>
                          <span>{row.summary || row.jurisdiction || "No scope note"}</span>
                        </button>
                      </th>
                      <td data-label="Type">{human(row.requirementType)}</td>
                      <td data-label="Due / expiry">
                        {row.expiresAt
                          ? `Expires ${date(row.expiresAt)}`
                          : row.dueAt
                            ? `Due ${date(row.dueAt)}`
                            : "No deadline"}
                      </td>
                      <td data-label="Evidence">
                        {row.currentFileVersionId ? (
                          <Status tone="info">file pinned</Status>
                        ) : (
                          <Status tone="warning">manual upload needed</Status>
                        )}
                      </td>
                      <td data-label="Status">
                        <Status tone={requirementTone(row)}>
                          {human(row.status)}
                          {row.isBlocking ? " · blocker" : ""}
                        </Status>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <SurfaceBoundary
              action={
                <Button onClick={() => setDialog({ kind: "requirement" })}>Add requirement</Button>
              }
              state="empty"
              title="No requirements recorded"
            />
          )}
        </section>
        <section className="planning-section">
          <header>
            <div>
              <h2>Risk assessments</h2>
              <p>Scores are likelihood × impact; controls retain their own evidence and status.</p>
            </div>
            <Button icon={<Plus />} onClick={() => setDialog({ kind: "risk" })}>
              New assessment
            </Button>
          </header>
          <div className="risk-list">
            {data.legalSafety.risks
              .filter((risk) => !risk.archivedAt)
              .map((risk) => (
                <article key={risk.id}>
                  <header>
                    <div>
                      <strong>{risk.title}</strong>
                      <span>{risk.summary || "No assessment summary"}</span>
                    </div>
                    <Status tone={risk.status === "approved" ? "success" : "warning"}>
                      {human(risk.status)}
                    </Status>
                  </header>
                  <div className="risk-actions">
                    <Button
                      icon={<Plus />}
                      onClick={() => setDialog({ kind: "hazard", riskId: risk.id })}
                      variant="quiet"
                    >
                      Add hazard
                    </Button>
                  </div>
                  {risk.hazards
                    .filter((hazard) => !hazard.archivedAt)
                    .map((hazard) => (
                      <div className="hazard-row" key={hazard.id}>
                        <div
                          className={`risk-score risk-score--${riskTone(hazard.residualScore ?? hazard.initialScore)}`}
                        >
                          <span>{hazard.residualScore === null ? "Initial" : "Residual"}</span>
                          <strong>{hazard.residualScore ?? hazard.initialScore}</strong>
                        </div>
                        <div>
                          <strong>{hazard.title}</strong>
                          <span>
                            {hazard.affectedPeople ||
                              hazard.description ||
                              "Affected people not recorded"}
                          </span>
                          <small>
                            {hazard.controls.filter((control) => !control.archivedAt).length}{" "}
                            controls ·{" "}
                            {
                              hazard.controls.filter(
                                (control) =>
                                  control.status !== "complete" &&
                                  control.status !== "not_required",
                              ).length
                            }{" "}
                            outstanding
                          </small>
                        </div>
                        <Button
                          onClick={() => setDialog({ kind: "control", hazardId: hazard.id })}
                          variant="quiet"
                        >
                          Add control
                        </Button>
                      </div>
                    ))}
                </article>
              ))}
          </div>
        </section>
      </div>
      <section className="planning-section legal-hold-section">
        <header>
          <div>
            <h2>Legal holds</h2>
            <p>
              Active holds block destructive file and retention actions. Only the workspace owner
              may place or release one.
            </p>
          </div>
          {auth.account?.role === "workspace_owner" ? (
            <Button icon={<LockKeyhole />} onClick={() => setDialog({ kind: "hold" })}>
              Place legal hold
            </Button>
          ) : (
            <Status tone="neutral">Owner controlled</Status>
          )}
        </header>
        {data.legalSafety.legalHolds.length ? (
          <ol className="hold-list">
            {data.legalSafety.legalHolds.map((hold) => (
              <li key={hold.id}>
                <LockKeyhole aria-hidden="true" />
                <div>
                  <strong>{hold.title}</strong>
                  <span>{hold.reason}</span>
                  <small>
                    {hold.scope} · placed {dateTime(hold.placedAt)} by {hold.placedBy}
                    {hold.releasedAt ? ` · released ${dateTime(hold.releasedAt)}` : ""}
                  </small>
                </div>
                {hold.releasedAt ? (
                  <Status tone="neutral">released</Status>
                ) : auth.account?.role === "workspace_owner" ? (
                  <Button
                    onClick={() =>
                      setDialog({ kind: "release", holdId: hold.id, title: hold.title })
                    }
                    variant="quiet"
                  >
                    Release
                  </Button>
                ) : (
                  <Status tone="danger">active</Status>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="planning-empty-line">No legal holds are active or recorded.</p>
        )}
      </section>
      {dialog ? (
        <LegalDialog
          dialog={dialog}
          error={error}
          onClose={() => {
            setDialog(undefined);
            setError(undefined);
          }}
          onSubmit={(input) => mutation.mutate(input)}
          pending={mutation.isPending}
          timezone={data.project.timezone}
        />
      ) : null}
    </>
  );
}

function LegalDialog({
  dialog,
  error,
  onClose,
  onSubmit,
  pending,
  timezone,
}: {
  readonly dialog: DialogState;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    path: string;
    method?: "POST" | "PATCH";
    body: unknown;
    version?: number | undefined;
  }) => void;
  readonly pending: boolean;
  readonly timezone: string;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "requirement") {
      const body = {
        title: text(form, "title"),
        requirementType: text(form, "requirementType"),
        status: text(form, "status"),
        summary: nullable(form, "summary"),
        jurisdiction: nullable(form, "jurisdiction"),
        dueAt: localTime(form, "dueAt", timezone),
        expiresAt: localTime(form, "expiresAt", timezone),
        priority: text(form, "priority"),
        isBlocking: form.get("isBlocking") === "on",
        signedExecutedState: text(form, "signedExecutedState"),
        currentFileVersionId: nullable(form, "currentFileVersionId"),
        restricted: form.get("restricted") === "on",
      };
      onSubmit({
        path: `/requirements${dialog.record ? `/${encodeURIComponent(dialog.record.id)}` : ""}`,
        method: dialog.record ? "PATCH" : "POST",
        version: dialog.record?.version,
        body,
      });
    } else if (dialog.kind === "risk")
      onSubmit({
        path: "/risks",
        body: {
          title: text(form, "title"),
          status: text(form, "status"),
          summary: nullable(form, "summary"),
          reviewAt: localTime(form, "reviewAt", timezone),
        },
      });
    else if (dialog.kind === "hazard")
      onSubmit({
        path: `/risks/${encodeURIComponent(dialog.riskId)}/hazards`,
        body: {
          title: text(form, "title"),
          description: nullable(form, "description"),
          affectedPeople: nullable(form, "affectedPeople"),
          likelihood: Number(form.get("likelihood")),
          impact: Number(form.get("impact")),
          residualLikelihood: numberOrNull(form, "residualLikelihood"),
          residualImpact: numberOrNull(form, "residualImpact"),
          status: text(form, "status"),
        },
      });
    else if (dialog.kind === "control")
      onSubmit({
        path: `/hazards/${encodeURIComponent(dialog.hazardId)}/controls`,
        body: {
          title: text(form, "title"),
          description: nullable(form, "description"),
          status: text(form, "status"),
          dueAt: localTime(form, "dueAt", timezone),
        },
      });
    else if (dialog.kind === "hold")
      onSubmit({
        path: "/legal-holds",
        body: { title: text(form, "title"), reason: text(form, "reason"), scope: "project" },
      });
    else
      onSubmit({
        path: `/legal-holds/${encodeURIComponent(dialog.holdId)}/release`,
        body: { reason: text(form, "reason") },
      });
  }
  const requirement = dialog.kind === "requirement" ? dialog.record : undefined;
  const title =
    dialog.kind === "requirement"
      ? requirement
        ? "Edit requirement"
        : "Add requirement"
      : dialog.kind === "risk"
        ? "New risk assessment"
        : dialog.kind === "hazard"
          ? "Add hazard"
          : dialog.kind === "control"
            ? "Add control measure"
            : dialog.kind === "hold"
              ? "Place legal hold"
              : `Release ${dialog.title}`;
  return (
    <DialogFrame error={error} onClose={onClose} title={title}>
      <form className="planning-form" onSubmit={submit}>
        {dialog.kind === "requirement" ? (
          <>
            <Field label="Title">
              <input
                autoFocus
                defaultValue={requirement?.title}
                minLength={2}
                name="title"
                required
              />
            </Field>
            <div className="planning-form__grid">
              <Field label="Type">
                <select
                  defaultValue={requirement?.requirementType ?? "permit"}
                  name="requirementType"
                >
                  {requirementTypes.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select defaultValue={requirement?.status ?? "missing"} name="status">
                  <option value="missing">Missing</option>
                  <option value="draft">Draft</option>
                  <option value="requested">Requested</option>
                  <option value="pending">Pending</option>
                  <option value="executed">Executed</option>
                  <option value="approved">Approved</option>
                  <option value="expired">Expired</option>
                  <option value="not_required">Not required</option>
                  <option value="blocked">Blocked</option>
                </select>
              </Field>
              <Field label="Priority">
                <select defaultValue={requirement?.priority ?? "normal"} name="priority">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </Field>
              <Field label="Execution evidence">
                <select
                  defaultValue={requirement?.signedExecutedState ?? "unsigned"}
                  name="signedExecutedState"
                >
                  <option value="not_required">Not required</option>
                  <option value="unsigned">Unsigned</option>
                  <option value="pending_external">Pending externally</option>
                  <option value="executed">Executed</option>
                  <option value="manual_uploaded">Manual signed upload</option>
                </select>
              </Field>
              <Field label={`Due (${timezone})`}>
                <input
                  defaultValue={localInput(requirement?.dueAt, timezone)}
                  name="dueAt"
                  type="datetime-local"
                />
              </Field>
              <Field label={`Expires (${timezone})`}>
                <input
                  defaultValue={localInput(requirement?.expiresAt, timezone)}
                  name="expiresAt"
                  type="datetime-local"
                />
              </Field>
            </div>
            <Field label="Jurisdiction">
              <input defaultValue={requirement?.jurisdiction ?? ""} name="jurisdiction" />
            </Field>
            <Field label="Summary / notes">
              <textarea defaultValue={requirement?.summary ?? ""} name="summary" rows={4} />
            </Field>
            <Field label="Evidence file version ID">
              <input
                defaultValue={requirement?.currentFileVersionId ?? ""}
                name="currentFileVersionId"
                placeholder="Paste a verified file-version ID"
              />
            </Field>
            <label className="planning-check">
              <input defaultChecked={requirement?.isBlocking} name="isBlocking" type="checkbox" />
              <span>Blocking readiness requirement</span>
            </label>
            <label className="planning-check">
              <input
                defaultChecked={requirement?.restricted ?? true}
                name="restricted"
                type="checkbox"
              />
              <span>Restricted legal record</span>
            </label>
          </>
        ) : null}
        {dialog.kind === "risk" ? (
          <>
            <Field label="Assessment title">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Status">
              <select defaultValue="draft" name="status">
                <option value="draft">Draft</option>
                <option value="in_review">In review</option>
                <option value="approved">Approved</option>
                <option value="superseded">Superseded</option>
              </select>
            </Field>
            <Field label={`Review date (${timezone})`}>
              <input name="reviewAt" type="datetime-local" />
            </Field>
            <Field label="Summary">
              <textarea name="summary" rows={5} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "hazard" ? (
          <>
            <Field label="Hazard">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={4} />
            </Field>
            <Field label="Affected people">
              <input name="affectedPeople" />
            </Field>
            <div className="planning-form__grid">
              <ScoreSelect label="Likelihood" name="likelihood" />
              <ScoreSelect label="Impact" name="impact" />
              <ScoreSelect allowBlank label="Residual likelihood" name="residualLikelihood" />
              <ScoreSelect allowBlank label="Residual impact" name="residualImpact" />
            </div>
            <Field label="Status">
              <select defaultValue="open" name="status">
                <option value="open">Open</option>
                <option value="controlled">Controlled</option>
                <option value="accepted">Accepted</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
          </>
        ) : null}
        {dialog.kind === "control" ? (
          <>
            <Field label="Control measure">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={4} />
            </Field>
            <Field label="Status">
              <select defaultValue="planned" name="status">
                <option value="planned">Planned</option>
                <option value="in_progress">In progress</option>
                <option value="complete">Complete</option>
                <option value="not_required">Not required</option>
              </select>
            </Field>
            <Field label={`Due (${timezone})`}>
              <input name="dueAt" type="datetime-local" />
            </Field>
          </>
        ) : null}
        {dialog.kind === "hold" ? (
          <>
            <div className="planning-danger-note">
              <LockKeyhole aria-hidden="true" />
              <p>
                This hold prevents destructive retention actions across this project until an owner
                releases it.
              </p>
            </div>
            <Field label="Hold title">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Reason">
              <textarea minLength={12} name="reason" required rows={5} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "release" ? (
          <>
            <div className="planning-danger-note">
              <ShieldCheck aria-hidden="true" />
              <p>Release is audited and does not delete the hold record or its history.</p>
            </div>
            <Field label="Release reason">
              <textarea autoFocus minLength={12} name="reason" required rows={5} />
            </Field>
          </>
        ) : null}
        <footer>
          <Button onClick={onClose} variant="quiet">
            Cancel
          </Button>
          <Button
            disabled={pending}
            type="submit"
            variant={dialog.kind === "hold" ? "danger" : "primary"}
          >
            {pending
              ? "Saving…"
              : dialog.kind === "hold"
                ? "Place hold"
                : dialog.kind === "release"
                  ? "Release hold"
                  : "Save"}
          </Button>
        </footer>
      </form>
    </DialogFrame>
  );
}

function ScoreSelect({
  allowBlank = false,
  label,
  name,
}: {
  readonly allowBlank?: boolean;
  readonly label: string;
  readonly name: string;
}) {
  return (
    <Field label={label}>
      <select defaultValue={allowBlank ? "" : "1"} name={name} required={!allowBlank}>
        {allowBlank ? <option value="">Not assessed</option> : null}
        {[1, 2, 3, 4, 5].map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    </Field>
  );
}
function Metric({
  label,
  tone,
  value,
}: {
  readonly label: string;
  readonly tone?: "danger" | "warning" | "success" | undefined;
  readonly value: string;
}) {
  return (
    <div className={tone ? `planning-metric planning-metric--${tone}` : "planning-metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function requirementTone(row: Requirement): "success" | "danger" | "warning" | "info" {
  if (["approved", "executed", "not_required"].includes(row.status)) return "success";
  if (
    row.status === "blocked" ||
    row.status === "expired" ||
    (row.isBlocking && row.status === "missing")
  )
    return "danger";
  if (row.status === "missing") return "warning";
  return "info";
}
function riskTone(score: number) {
  return score >= 15 ? "danger" : score >= 8 ? "warning" : "low";
}
function human(value: string) {
  return value.replaceAll("_", " ");
}
function date(value: number) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(value);
}
function dateTime(value: number) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
function text(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}
function nullable(form: FormData, name: string) {
  return text(form, name) || null;
}
function numberOrNull(form: FormData, name: string) {
  const value = text(form, name);
  return value ? Number(value) : null;
}
function localTime(form: FormData, name: string, timeZone: string) {
  const value = text(form, name);
  return value ? zonedLocalToUtc(value, timeZone) : null;
}
function zonedLocalToUtc(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("Invalid local date and time.");
  const wanted = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let guess = wanted;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = partsAt(guess, timeZone);
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    guess += wanted - observed;
  }
  const check = partsAt(guess, timeZone);
  if (Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute) !== wanted)
    throw new Error("This local time does not exist in the project timezone.");
  return guess;
}
function partsAt(epoch: number, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epoch);
  const take = (type: string) => Number(values.find((part) => part.type === type)?.value ?? 0);
  return {
    year: take("year"),
    month: take("month"),
    day: take("day"),
    hour: take("hour"),
    minute: take("minute"),
  };
}
function localInput(epoch: number | null | undefined, timeZone: string) {
  if (!epoch) return "";
  const part = partsAt(epoch, timeZone);
  return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}T${String(part.hour).padStart(2, "0")}:${String(part.minute).padStart(2, "0")}`;
}
