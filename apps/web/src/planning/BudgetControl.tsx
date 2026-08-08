import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FilePlus2, Plus, X } from "lucide-react";
import { Button, IconButton, Status, SurfaceBoundary } from "@swp/ui";
import { z } from "zod";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { BudgetLineView, BudgetView, PlanningControls } from "./schemas";

type DialogState =
  | { readonly kind: "budget" }
  | { readonly kind: "version"; readonly budget: BudgetView }
  | { readonly kind: "account"; readonly budget: BudgetView; readonly versionId: string }
  | {
      readonly kind: "line";
      readonly budget: BudgetView;
      readonly versionId: string;
      readonly line?: BudgetLineView;
    }
  | { readonly kind: "approve"; readonly budget: BudgetView; readonly versionId: string };

const mutationResultSchema = z.unknown();

export function BudgetControl({
  data,
  endpoint,
  projectId,
}: {
  readonly data: PlanningControls;
  readonly endpoint: string;
  readonly projectId: string;
}) {
  const queryClient = useQueryClient();
  const activeBudgets = data.budget.budgets.filter((budget) => !budget.archivedAt);
  const [selectedBudgetId, setSelectedBudgetId] = useState(activeBudgets[0]?.id ?? "");
  const [dialog, setDialog] = useState<DialogState>();
  const budget = activeBudgets.find((item) => item.id === selectedBudgetId) ?? activeBudgets[0];
  const working = budget?.versions.find((version) => version.id === budget.workingVersionId);
  const current =
    working ??
    budget?.versions.find((version) => version.id === budget.approvedVersionId) ??
    budget?.versions[0];
  const [error, setError] = useState<string>();

  const change = useMutation({
    mutationFn: (input: {
      path: string;
      method?: "POST" | "PUT";
      body: unknown;
      version?: number | undefined;
      idempotencyKey?: string | undefined;
    }) => {
      const headers: Record<string, string> = {};
      if (input.version !== undefined) headers["If-Match"] = `"${input.version}"`;
      if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
      return apiRequest(`${endpoint}${input.path}`, mutationResultSchema, {
        method: input.method ?? "POST",
        headers,
        body: jsonBody(input.body),
      });
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? `${failure.message} Refresh the current version before retrying.`
          : "The budget change could not be saved. Your form remains open.",
      );
    },
    onSuccess: async () => {
      setDialog(undefined);
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["planning-controls", projectId] });
    },
  });

  const accounts = current?.accounts ?? [];
  const variance = current ? current.totalActualMinor - current.totalApprovedMinor : 0;
  const format = useMemo(
    () => moneyFormatter(current?.currency ?? data.project.currency),
    [current?.currency, data.project.currency],
  );

  if (!budget || !current) {
    return (
      <SurfaceBoundary
        action={
          <Button icon={<Plus />} onClick={() => setDialog({ kind: "budget" })} variant="primary">
            Create budget
          </Button>
        }
        description="Start a working version with a controlled account structure."
        state="empty"
        title="No budget yet"
      />
    );
  }

  return (
    <>
      <div className="planning-toolbar">
        <label>
          <span>Budget</span>
          <select
            onChange={(event) => setSelectedBudgetId(event.currentTarget.value)}
            value={budget.id}
          >
            {activeBudgets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="planning-toolbar__actions">
          <Button icon={<Plus />} onClick={() => setDialog({ kind: "budget" })}>
            New budget
          </Button>
          {!working ? (
            <Button
              icon={<FilePlus2 />}
              onClick={() => setDialog({ kind: "version", budget })}
              variant="primary"
            >
              New working version
            </Button>
          ) : null}
          {working ? (
            <Button
              icon={<Plus />}
              onClick={() => setDialog({ kind: "account", budget, versionId: working.id })}
            >
              Add account
            </Button>
          ) : null}
          {working ? (
            <Button
              icon={<Plus />}
              onClick={() => setDialog({ kind: "line", budget, versionId: working.id })}
              variant="primary"
            >
              Add line
            </Button>
          ) : null}
        </div>
      </div>
      <section aria-label="Budget totals" className="planning-metrics">
        <Metric label="Estimate" value={format.format(current.totalEstimateMinor / 100)} />
        <Metric label="Approved" value={format.format(current.totalApprovedMinor / 100)} />
        <Metric label="Committed" value={format.format(current.totalCommittedMinor / 100)} />
        <Metric label="Actual" value={format.format(current.totalActualMinor / 100)} />
        <Metric
          label="Variance"
          tone={variance > 0 ? "danger" : variance < 0 ? "success" : undefined}
          value={format.format(variance / 100)}
        />
      </section>
      <div className="planning-status-line">
        <div>
          <Status tone={current.status === "approved" ? "success" : "warning"}>
            {current.status}
          </Status>
          <span>
            Version {current.versionNumber} · {current.name}
          </span>
          {current.isCurrentApproved ? <span>Current approved pointer</span> : null}
        </div>
        {working ? (
          <Button
            disabled={change.isPending || accounts.every((account) => account.lines.length === 0)}
            icon={<CheckCircle2 />}
            onClick={() => setDialog({ kind: "approve", budget, versionId: working.id })}
          >
            Approve working version
          </Button>
        ) : (
          <span className="planning-lock-note">
            Approved data is immutable. Create a new working version for corrections.
          </span>
        )}
      </div>
      <div className="record-table-wrap planning-table-wrap">
        <table className="record-table planning-table">
          <thead>
            <tr>
              <th>Account / line</th>
              <th>Quantity × duration</th>
              <th>Estimate</th>
              <th>Approved</th>
              <th>Committed</th>
              <th>Actual</th>
            </tr>
          </thead>
          <tbody>
            {accounts.flatMap((account) => [
              <tr className="planning-account-row" key={`account:${account.id}`}>
                <th colSpan={6} scope="rowgroup">
                  <span>{account.code}</span>
                  {account.title}
                </th>
              </tr>,
              ...account.lines.map((line) => (
                <tr key={line.id}>
                  <th data-label="Line" scope="row">
                    <button
                      className="record-title"
                      disabled={!working}
                      onClick={() =>
                        working && setDialog({ kind: "line", budget, versionId: working.id, line })
                      }
                      type="button"
                    >
                      <strong>{line.title}</strong>
                      <span>{line.notes || line.unit || "No line note"}</span>
                    </button>
                  </th>
                  <td data-label="Quantity × duration">
                    {formatScaled(line.quantityMilli)} × {formatScaled(line.durationMilli)}
                  </td>
                  <td data-label="Estimate">{format.format(line.estimateMinor / 100)}</td>
                  <td data-label="Approved">{format.format(line.approvedMinor / 100)}</td>
                  <td data-label="Committed">{format.format(line.committedMinor / 100)}</td>
                  <td data-label="Actual">{format.format(line.actualMinor / 100)}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <section aria-label="Budget version history" className="planning-history">
        <h2>Version history</h2>
        <ol>
          {budget.versions.map((version) => (
            <li key={version.id}>
              <span>v{version.versionNumber}</span>
              <strong>{version.name}</strong>
              <Status
                tone={
                  version.id === budget.approvedVersionId
                    ? "success"
                    : version.status === "working"
                      ? "warning"
                      : "neutral"
                }
              >
                {version.id === budget.approvedVersionId ? "current approved" : version.status}
              </Status>
              <time dateTime={new Date(version.createdAt).toISOString()}>
                {new Intl.DateTimeFormat("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(version.createdAt)}
              </time>
              <code>{version.contentHash.slice(0, 12)}…</code>
            </li>
          ))}
        </ol>
      </section>
      {dialog ? (
        <BudgetDialog
          budget={budget}
          currency={current.currency}
          dialog={dialog}
          error={error}
          onClose={() => {
            setDialog(undefined);
            setError(undefined);
          }}
          onSubmit={(action) => change.mutate(action)}
          pending={change.isPending}
        />
      ) : null}
    </>
  );
}

function BudgetDialog({
  budget,
  currency,
  dialog,
  error,
  onClose,
  onSubmit,
  pending,
}: {
  readonly budget: BudgetView;
  readonly currency: string;
  readonly dialog: DialogState;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (input: {
    path: string;
    method?: "POST" | "PUT";
    body: unknown;
    version?: number | undefined;
    idempotencyKey?: string | undefined;
  }) => void;
  readonly pending: boolean;
}) {
  const activeVersion = budget.versions.find(
    (version) =>
      version.id ===
      (dialog.kind === "line" || dialog.kind === "account" || dialog.kind === "approve"
        ? dialog.versionId
        : budget.workingVersionId),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "budget") {
      onSubmit({
        path: "/budgets",
        body: {
          title: text(form, "title"),
          currency: text(form, "currency"),
          contingencyBps: basisPoints(form, "contingency"),
        },
      });
    } else if (dialog.kind === "version") {
      onSubmit({
        path: `/budgets/${encodeURIComponent(dialog.budget.id)}/versions`,
        version: dialog.budget.version,
        body: {
          name: text(form, "name"),
          sourceVersionId: dialog.budget.approvedVersionId ?? undefined,
          contingencyBps: basisPoints(form, "contingency"),
          exchangeRateNote: nullable(form, "exchangeRateNote"),
        },
      });
    } else if (dialog.kind === "account") {
      onSubmit({
        path: `/budgets/${encodeURIComponent(dialog.budget.id)}/accounts`,
        version: dialog.budget.version,
        body: {
          versionId: dialog.versionId,
          code: text(form, "code"),
          title: text(form, "title"),
          parentAccountId: nullable(form, "parentAccountId"),
        },
      });
    } else if (dialog.kind === "approve") {
      onSubmit({
        path: `/budgets/${encodeURIComponent(dialog.budget.id)}/approve`,
        version: dialog.budget.version,
        idempotencyKey: `budget-approve:${crypto.randomUUID()}`,
        body: { versionId: dialog.versionId, comment: text(form, "comment") },
      });
    } else {
      const body = {
        versionId: dialog.versionId,
        accountId: text(form, "accountId"),
        title: text(form, "title"),
        notes: nullable(form, "notes"),
        unit: nullable(form, "unit"),
        quantityMilli: scaled(form, "quantity"),
        durationMilli: scaled(form, "duration"),
        rateMinor: minor(form, "rate"),
        fringeBps: basisPoints(form, "fringe"),
        taxBps: basisPoints(form, "tax"),
        markupBps: basisPoints(form, "markup"),
        approvedMinor: minor(form, "approved"),
        committedMinor: minor(form, "committed"),
        actualMinor: minor(form, "actual"),
        paidMinor: minor(form, "paid"),
      };
      onSubmit({
        path: `/budgets/${encodeURIComponent(dialog.budget.id)}/lines${dialog.line ? `/${encodeURIComponent(dialog.line.id)}` : ""}`,
        method: dialog.line ? "PUT" : "POST",
        version: dialog.budget.version,
        body,
      });
    }
  }
  const title =
    dialog.kind === "budget"
      ? "Create budget"
      : dialog.kind === "version"
        ? "Create working version"
        : dialog.kind === "account"
          ? "Add budget account"
          : dialog.kind === "approve"
            ? "Approve budget version"
            : dialog.line
              ? "Edit budget line"
              : "Add budget line";
  const line = dialog.kind === "line" ? dialog.line : undefined;
  return (
    <DialogFrame error={error} onClose={onClose} title={title}>
      <form className="planning-form" onSubmit={submit}>
        {dialog.kind === "budget" ? (
          <>
            <Field label="Budget title">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Currency">
              <input defaultValue={currency} maxLength={3} minLength={3} name="currency" required />
            </Field>
            <Field label="Contingency %">
              <input defaultValue="0" min="0" name="contingency" step="0.01" type="number" />
            </Field>
          </>
        ) : null}
        {dialog.kind === "version" ? (
          <>
            <Field label="Version name">
              <input
                autoFocus
                defaultValue={`${dialog.budget.title} revision`}
                minLength={2}
                name="name"
                required
              />
            </Field>
            <Field label="Contingency %">
              <input
                defaultValue={String(
                  (dialog.budget.versions.find(
                    (version) => version.id === dialog.budget.approvedVersionId,
                  )?.contingencyBps ?? 0) / 100,
                )}
                min="0"
                name="contingency"
                step="0.01"
                type="number"
              />
            </Field>
            <Field label="Exchange-rate note">
              <textarea name="exchangeRateNote" rows={3} />
            </Field>
            <p className="planning-form__notice">
              The current approved snapshot is cloned. Its row remains immutable and the current
              pointer changes only after this version is approved.
            </p>
          </>
        ) : null}
        {dialog.kind === "account" ? (
          <>
            <Field label="Account code">
              <input autoFocus maxLength={24} name="code" required />
            </Field>
            <Field label="Account title">
              <input minLength={2} name="title" required />
            </Field>
            <Field label="Parent account">
              <select name="parentAccountId">
                <option value="">Top level</option>
                {activeVersion?.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.title}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
        {dialog.kind === "line" ? (
          <>
            <Field label="Account">
              <select
                defaultValue={
                  line
                    ? activeVersion?.accounts.find((account) =>
                        account.lines.some((item) => item.id === line.id),
                      )?.id
                    : ""
                }
                name="accountId"
                required
              >
                <option disabled value="">
                  Select account
                </option>
                {activeVersion?.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Line title">
              <input autoFocus defaultValue={line?.title} minLength={2} name="title" required />
            </Field>
            <Field label="Notes">
              <textarea defaultValue={line?.notes ?? ""} name="notes" rows={3} />
            </Field>
            <div className="planning-form__grid">
              <NumberField
                defaultValue={line ? formatScaled(line.quantityMilli) : "1"}
                label="Quantity"
                name="quantity"
                step="0.001"
              />
              <NumberField
                defaultValue={line ? formatScaled(line.durationMilli) : "1"}
                label="Duration"
                name="duration"
                step="0.001"
              />
              <Field label="Unit">
                <input defaultValue={line?.unit ?? "day"} name="unit" />
              </Field>
              <MoneyField
                currency={currency}
                defaultValue={line ? line.rateMinor / 100 : 0}
                label="Rate"
                name="rate"
              />
              <NumberField
                defaultValue={(line?.fringeBps ?? 0) / 100}
                label="Fringe %"
                name="fringe"
                step="0.01"
              />
              <NumberField
                defaultValue={(line?.taxBps ?? 0) / 100}
                label="Tax %"
                name="tax"
                step="0.01"
              />
              <NumberField
                defaultValue={(line?.markupBps ?? 0) / 100}
                label="Markup %"
                name="markup"
                step="0.01"
              />
              <MoneyField
                currency={currency}
                defaultValue={(line?.approvedMinor ?? 0) / 100}
                label="Approved"
                name="approved"
              />
              <MoneyField
                currency={currency}
                defaultValue={(line?.committedMinor ?? 0) / 100}
                label="Committed"
                name="committed"
              />
              <MoneyField
                currency={currency}
                defaultValue={(line?.actualMinor ?? 0) / 100}
                label="Actual"
                name="actual"
              />
              <MoneyField
                currency={currency}
                defaultValue={(line?.paidMinor ?? 0) / 100}
                label="Paid"
                name="paid"
              />
            </div>
          </>
        ) : null}
        {dialog.kind === "approve" ? (
          <>
            <div className="planning-approval-summary">
              <Status tone="warning">Working v{activeVersion?.versionNumber}</Status>
              <strong>{activeVersion?.name}</strong>
              <span>
                {activeVersion?.accounts.reduce(
                  (total, account) => total + account.lines.length,
                  0,
                )}{" "}
                lines will be frozen
              </span>
            </div>
            <Field label="Approval comment">
              <textarea autoFocus minLength={8} name="comment" required rows={5} />
            </Field>
            <p className="planning-form__notice">
              Self-approval is enabled for the two-producer planning policy and is recorded in
              immutable decision history. Approval does not imply legal review.
            </p>
          </>
        ) : null}
        <footer>
          <Button onClick={onClose} variant="quiet">
            Cancel
          </Button>
          <Button disabled={pending} type="submit" variant="primary">
            {pending ? "Saving…" : dialog.kind === "approve" ? "Approve and freeze" : "Save"}
          </Button>
        </footer>
      </form>
    </DialogFrame>
  );
}

export function DialogFrame({
  children,
  error,
  onClose,
  title,
}: {
  readonly children: React.ReactNode;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly title: string;
}) {
  return (
    <div className="drawer-layer planning-dialog-layer">
      <button aria-label="Close dialog" className="drawer-scrim" onClick={onClose} type="button" />
      <div
        aria-labelledby="planning-dialog-title"
        aria-modal="true"
        className="planning-dialog"
        role="dialog"
      >
        <header>
          <h2 id="planning-dialog-title">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

function Metric({
  label,
  tone,
  value,
}: {
  readonly label: string;
  readonly tone?: "danger" | "success" | undefined;
  readonly value: string;
}) {
  return (
    <div className={tone ? `planning-metric planning-metric--${tone}` : "planning-metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
export function Field({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
}) {
  return (
    <label className="planning-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function NumberField({
  defaultValue,
  label,
  name,
  step = "1",
}: {
  readonly defaultValue: string | number;
  readonly label: string;
  readonly name: string;
  readonly step?: string;
}) {
  return (
    <Field label={label}>
      <input defaultValue={defaultValue} min="0" name={name} required step={step} type="number" />
    </Field>
  );
}
function MoneyField({
  currency,
  defaultValue,
  label,
  name,
}: {
  readonly currency: string;
  readonly defaultValue: number;
  readonly label: string;
  readonly name: string;
}) {
  return (
    <Field label={`${label} (${currency})`}>
      <input defaultValue={defaultValue} min="0" name={name} required step="0.01" type="number" />
    </Field>
  );
}
function text(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}
function nullable(form: FormData, name: string) {
  const value = text(form, name);
  return value || null;
}
function scaled(form: FormData, name: string) {
  return Math.round(Number(form.get(name) ?? 0) * 1_000);
}
function minor(form: FormData, name: string) {
  return Math.round(Number(form.get(name) ?? 0) * 100);
}
function basisPoints(form: FormData, name: string) {
  return Math.round(Number(form.get(name) ?? 0) * 100);
}
function formatScaled(value: number) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(value / 1_000);
}
function moneyFormatter(currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    });
  } catch {
    return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
