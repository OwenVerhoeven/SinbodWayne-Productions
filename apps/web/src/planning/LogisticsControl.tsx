import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BusFront, MapPinned, Plus, UtensilsCrossed } from "lucide-react";
import { Button, Status, SurfaceBoundary } from "@swp/ui";
import { z } from "zod";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import { DialogFrame, Field } from "./BudgetControl";
import type { PlanningControls } from "./schemas";

type DialogState =
  { readonly kind: "logistics" } | { readonly kind: "transport" } | { readonly kind: "catering" };
const resultSchema = z.unknown();

export function LogisticsControl({
  data,
  endpoint,
  projectId,
}: {
  readonly data: PlanningControls;
  readonly endpoint: string;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>();
  const [error, setError] = useState<string>();
  const plans = data.logistics.plans.filter((plan) => !plan.archivedAt);
  const transport = data.logistics.transport.filter((plan) => !plan.archivedAt);
  const catering = data.logistics.catering.filter((plan) => !plan.archivedAt);
  const primary = plans[0];
  const mutation = useMutation({
    mutationFn: (input: { path: string; body: unknown }) =>
      apiRequest(`${endpoint}${input.path}`, resultSchema, {
        method: "POST",
        body: jsonBody(input.body),
      }),
    onError: (failure) =>
      setError(
        failure instanceof ApiError ? failure.message : "The logistics record could not be saved.",
      ),
    onSuccess: async () => {
      setDialog(undefined);
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["planning-controls", projectId] });
    },
  });
  const readyCount = [
    primary?.baseCamp,
    primary?.toilets,
    primary?.powerCharging,
    primary?.accessNotes,
    primary?.emergencyNotes,
  ].filter((value) => value?.trim()).length;
  return (
    <>
      <section
        aria-label="Logistics readiness"
        className={`logistics-readiness logistics-readiness--${data.logistics.readiness.state}`}
      >
        <header>
          <div>
            <span>Logistics readiness</span>
            <h2>
              {data.logistics.readiness.state === "ready"
                ? "Ready"
                : data.logistics.readiness.state === "not_loaded"
                  ? "Not loaded"
                  : `${data.logistics.readiness.missing.length} gaps`}
            </h2>
          </div>
          <Status
            tone={
              data.logistics.readiness.state === "ready"
                ? "success"
                : data.logistics.readiness.state === "not_loaded"
                  ? "neutral"
                  : "danger"
            }
          >
            {data.logistics.readiness.state.replaceAll("_", " ")}
          </Status>
        </header>
        <div className="logistics-readiness__track">
          <span style={{ width: `${Math.round((readyCount / 5) * 100)}%` }} />
        </div>
        {data.logistics.readiness.missing.length ? (
          <ul>
            {data.logistics.readiness.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p>Core facilities, access, emergency notes, transport and catering are confirmed.</p>
        )}
      </section>
      <div className="planning-provider-grid">
        <div>
          <MapPinned aria-hidden="true" />
          <strong>Maps · Manual</strong>
          <span>{data.logistics.providers.maps.notice}</span>
        </div>
        <div>
          <BusFront aria-hidden="true" />
          <strong>Booking providers · Not configured</strong>
          <span>{data.logistics.providers.booking.notice}</span>
        </div>
      </div>
      <section className="planning-section">
        <header>
          <div>
            <h2>Base operations</h2>
            <p>
              Unit base, holding, facilities, access, power, security and emergency information feed
              call sheets and production packs.
            </p>
          </div>
          <Button
            icon={<Plus />}
            onClick={() => setDialog({ kind: "logistics" })}
            variant="primary"
          >
            New logistics plan
          </Button>
        </header>
        {plans.length ? (
          <div className="logistics-plan-list">
            {plans.map((plan) => (
              <article key={plan.id}>
                <header>
                  <div>
                    <strong>{plan.title}</strong>
                    <span>{plan.summary || "No plan summary"}</span>
                  </div>
                  <Status
                    tone={
                      plan.status === "approved" ||
                      plan.status === "ready" ||
                      plan.status === "confirmed"
                        ? "success"
                        : plan.status === "blocked"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {plan.status}
                  </Status>
                </header>
                <dl>
                  <Entry label="Base camp" value={plan.baseCamp} />
                  <Entry label="Holding" value={plan.holding} />
                  <Entry label="Green room" value={plan.greenRoom} />
                  <Entry label="Toilets" value={plan.toilets} />
                  <Entry label="Power / charging" value={plan.powerCharging} />
                  <Entry label="Waste" value={plan.waste} />
                  <Entry label="Security" value={plan.security} />
                  <Entry label="Access / loading" value={plan.accessNotes} />
                  <Entry label="Emergency" value={plan.emergencyNotes} />
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <SurfaceBoundary
            action={<Button onClick={() => setDialog({ kind: "logistics" })}>Create plan</Button>}
            state="empty"
            title="No logistics plan"
          />
        )}
      </section>
      <div className="planning-split">
        <section className="planning-section">
          <header>
            <div>
              <h2>Transport</h2>
              <p>Routes use validated external links and do not depend on a paid map SDK.</p>
            </div>
            <Button icon={<BusFront />} onClick={() => setDialog({ kind: "transport" })}>
              Add plan
            </Button>
          </header>
          {transport.length ? (
            <ol className="simple-plan-list">
              {transport.map((plan) => (
                <li key={plan.id}>
                  <div>
                    <strong>{plan.title}</strong>
                    <span>{plan.summary || "No transport note"}</span>
                    {plan.routeMapUrl ? (
                      <a href={plan.routeMapUrl} rel="noreferrer" target="_blank">
                        Open map link
                      </a>
                    ) : (
                      <small>No map link</small>
                    )}
                  </div>
                  <Status tone={confirmed(plan.status) ? "success" : "warning"}>
                    {human(plan.status)}
                  </Status>
                </li>
              ))}
            </ol>
          ) : (
            <p className="planning-empty-line">No transport plan recorded.</p>
          )}
        </section>
        <section className="planning-section">
          <header>
            <div>
              <h2>Catering</h2>
              <p>
                Counts and meal times are operational planning; sensitive dietary details remain in
                restricted person records.
              </p>
            </div>
            <Button icon={<UtensilsCrossed />} onClick={() => setDialog({ kind: "catering" })}>
              Add plan
            </Button>
          </header>
          {catering.length ? (
            <ol className="simple-plan-list">
              {catering.map((plan) => (
                <li key={plan.id}>
                  <div>
                    <strong>{plan.title}</strong>
                    <span>
                      {plan.headCount} people · {plan.mealTimes.join(", ") || "Meal times not set"}
                    </span>
                    <small>
                      {plan.costMinor === null || !plan.currency
                        ? "Cost not recorded"
                        : money(plan.costMinor, plan.currency)}
                    </small>
                  </div>
                  <Status tone={confirmed(plan.status) ? "success" : "warning"}>
                    {human(plan.status)}
                  </Status>
                </li>
              ))}
            </ol>
          ) : (
            <p className="planning-empty-line">No catering plan recorded.</p>
          )}
        </section>
      </div>
      {dialog ? (
        <LogisticsDialog
          currency={data.project.currency}
          dialog={dialog}
          error={error}
          onClose={() => {
            setDialog(undefined);
            setError(undefined);
          }}
          onSubmit={(input) => mutation.mutate(input)}
          pending={mutation.isPending}
        />
      ) : null}
    </>
  );
}

function LogisticsDialog({
  currency,
  dialog,
  error,
  onClose,
  onSubmit,
  pending,
}: {
  readonly currency: string;
  readonly dialog: DialogState;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (input: { path: string; body: unknown }) => void;
  readonly pending: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "logistics")
      onSubmit({
        path: "/logistics",
        body: {
          title: text(form, "title"),
          status: text(form, "status"),
          summary: nullable(form, "summary"),
          baseCamp: nullable(form, "baseCamp"),
          holding: nullable(form, "holding"),
          greenRoom: nullable(form, "greenRoom"),
          toilets: nullable(form, "toilets"),
          powerCharging: nullable(form, "powerCharging"),
          waste: nullable(form, "waste"),
          security: nullable(form, "security"),
          accessNotes: nullable(form, "accessNotes"),
          emergencyNotes: nullable(form, "emergencyNotes"),
        },
      });
    else if (dialog.kind === "transport")
      onSubmit({
        path: "/transport",
        body: {
          title: text(form, "title"),
          status: text(form, "status"),
          summary: nullable(form, "summary"),
          routeMapUrl: nullable(form, "routeMapUrl"),
        },
      });
    else
      onSubmit({
        path: "/catering",
        body: {
          title: text(form, "title"),
          status: text(form, "status"),
          summary: nullable(form, "summary"),
          headCount: Number(form.get("headCount")),
          costMinor: moneyOrNull(form, "cost"),
          currency: currency,
          mealTimes: text(form, "mealTimes")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
  }
  const title =
    dialog.kind === "logistics"
      ? "New logistics plan"
      : dialog.kind === "transport"
        ? "Add transport plan"
        : "Add catering plan";
  return (
    <DialogFrame error={error} onClose={onClose} title={title}>
      <form className="planning-form" onSubmit={submit}>
        <Field label="Title">
          <input autoFocus minLength={2} name="title" required />
        </Field>
        <Field label="Status">
          <select defaultValue={dialog.kind === "logistics" ? "draft" : "planned"} name="status">
            <option value="draft">Draft</option>
            <option value="planned">Planned</option>
            <option value="in_review">In review</option>
            <option value="approved">Approved</option>
            <option value="confirmed">Confirmed</option>
            <option value="ready">Ready</option>
            <option value="not_required">Not required</option>
            <option value="blocked">Blocked</option>
          </select>
        </Field>
        <Field label="Summary">
          <textarea name="summary" rows={3} />
        </Field>
        {dialog.kind === "logistics" ? (
          <div className="planning-form__grid">
            <Field label="Base camp / unit base">
              <textarea name="baseCamp" rows={2} />
            </Field>
            <Field label="Holding">
              <textarea name="holding" rows={2} />
            </Field>
            <Field label="Green room">
              <textarea name="greenRoom" rows={2} />
            </Field>
            <Field label="Toilets / accessibility">
              <textarea name="toilets" rows={2} />
            </Field>
            <Field label="Power / charging">
              <textarea name="powerCharging" rows={2} />
            </Field>
            <Field label="Waste">
              <textarea name="waste" rows={2} />
            </Field>
            <Field label="Security">
              <textarea name="security" rows={2} />
            </Field>
            <Field label="Access / loading">
              <textarea name="accessNotes" rows={2} />
            </Field>
            <Field label="Emergency logistics">
              <textarea name="emergencyNotes" rows={2} />
            </Field>
          </div>
        ) : null}
        {dialog.kind === "transport" ? (
          <Field label="External map / route link">
            <input name="routeMapUrl" placeholder="https://…" type="url" />
          </Field>
        ) : null}
        {dialog.kind === "catering" ? (
          <>
            <div className="planning-form__grid">
              <Field label="Head count">
                <input defaultValue="0" min="0" name="headCount" required type="number" />
              </Field>
              <Field label={`Cost (${currency})`}>
                <input min="0" name="cost" step="0.01" type="number" />
              </Field>
            </div>
            <Field label="Meal times (comma separated)">
              <input name="mealTimes" placeholder="Breakfast 07:00, Lunch 13:00" />
            </Field>
            <p className="planning-form__notice">
              Record allergy, dietary and accessibility details on restricted person records; this
              plan stores only operational counts and times.
            </p>
          </>
        ) : null}
        <footer>
          <Button onClick={onClose} variant="quiet">
            Cancel
          </Button>
          <Button disabled={pending} type="submit" variant="primary">
            {pending ? "Saving…" : "Save"}
          </Button>
        </footer>
      </form>
    </DialogFrame>
  );
}

function Entry({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <div className={value ? "" : "logistics-entry--missing"}>
      <dt>{label}</dt>
      <dd>{value || "Not recorded"}</dd>
    </div>
  );
}
function text(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}
function nullable(form: FormData, name: string) {
  return text(form, name) || null;
}
function moneyOrNull(form: FormData, name: string) {
  const value = text(form, name);
  return value ? Math.round(Number(value) * 100) : null;
}
function confirmed(status: string) {
  return ["approved", "confirmed", "ready", "not_required"].includes(status);
}
function human(value: string) {
  return value.replaceAll("_", " ");
}
function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
