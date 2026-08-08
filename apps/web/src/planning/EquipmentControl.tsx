import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, CalendarClock, PackagePlus, Plus, TriangleAlert } from "lucide-react";
import { Button, Status, SurfaceBoundary } from "@swp/ui";
import { z } from "zod";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import { DialogFrame, Field } from "./BudgetControl";
import type { PlanningControls } from "./schemas";

type Kit = PlanningControls["equipment"]["kits"][number];
type DialogState =
  | { readonly kind: "item" }
  | { readonly kind: "kit" }
  | { readonly kind: "member"; readonly kit: Kit }
  | { readonly kind: "reservation" };
const resultSchema = z.unknown();

export function EquipmentControl({
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
  const items = data.equipment.items.filter((item) => !item.archivedAt);
  const kits = data.equipment.kits.filter((kit) => !kit.archivedAt);
  const reservations = data.equipment.reservations.filter((row) => !row.archivedAt);
  const unready = items.filter(
    (item) => !["available", "ready", "reserved"].includes(item.status),
  ).length;
  const mutation = useMutation({
    mutationFn: (input: { path: string; body: unknown }) =>
      apiRequest(`${endpoint}${input.path}`, resultSchema, {
        method: "POST",
        body: jsonBody(input.body),
      }),
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === "resource_conflict") {
        const count = Array.isArray(
          (failure.details as { conflicts?: unknown[] } | undefined)?.conflicts,
        )
          ? (failure.details as { conflicts: unknown[] }).conflicts.length
          : 1;
        setError(
          `${count} blocking equipment overlap${count === 1 ? "" : "s"} found. Add an explicit override reason only after reviewing the schedule.`,
        );
      } else
        setError(
          failure instanceof ApiError
            ? failure.message
            : "The equipment change could not be saved.",
        );
    },
    onSuccess: async () => {
      setDialog(undefined);
      setError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["planning-controls", projectId] });
    },
  });
  return (
    <>
      <section aria-label="Equipment summary" className="planning-metrics">
        <Metric label="Items" value={String(items.length)} />
        <Metric label="Kits" value={String(kits.length)} />
        <Metric label="Reservations" value={String(reservations.length)} />
        <Metric
          label="Blocking overlaps"
          tone={data.equipment.conflicts.length ? "danger" : "success"}
          value={String(data.equipment.conflicts.length)}
        />
        <Metric label="Not ready" tone={unready ? "warning" : "success"} value={String(unready)} />
      </section>
      {data.equipment.conflicts.length ? (
        <section aria-labelledby="equipment-conflicts-title" className="planning-alert">
          <TriangleAlert aria-hidden="true" />
          <div>
            <h2 id="equipment-conflicts-title">Reservation conflicts need review</h2>
            {data.equipment.conflicts.map((conflict) => (
              <p key={`${conflict.resourceItemId}:${conflict.reservationIds.join(":")}`}>
                <strong>{conflict.resourceTitle}</strong> overlaps for{" "}
                {duration(conflict.overlapMs)} across reservations{" "}
                {conflict.reservationIds.map((id) => id.slice(0, 8)).join(" / ")}.
              </p>
            ))}
          </div>
        </section>
      ) : null}
      <section className="planning-section">
        <header>
          <div>
            <h2>Equipment inventory</h2>
            <p>
              Owned, borrowed and rented assets remain distinct physical records with immutable file
              links.
            </p>
          </div>
          <div>
            <Button icon={<PackagePlus />} onClick={() => setDialog({ kind: "kit" })}>
              New kit
            </Button>
            <Button icon={<Plus />} onClick={() => setDialog({ kind: "item" })} variant="primary">
              Add item
            </Button>
          </div>
        </header>
        {items.length ? (
          <div className="record-table-wrap">
            <table className="record-table planning-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Source</th>
                  <th>Category</th>
                  <th>Condition / storage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <th data-label="Item" scope="row">
                      <div className="record-title">
                        <strong>{item.title}</strong>
                        <span>
                          {[item.manufacturer, item.model, item.serialAssetId]
                            .filter(Boolean)
                            .join(" · ") ||
                            item.summary ||
                            "No asset details"}
                        </span>
                      </div>
                    </th>
                    <td data-label="Source">{item.ownershipType}</td>
                    <td data-label="Category">{item.category}</td>
                    <td data-label="Condition / storage">
                      {[item.condition, item.storageLocation].filter(Boolean).join(" · ") ||
                        "Not recorded"}
                    </td>
                    <td data-label="Status">
                      <Status
                        tone={
                          item.status === "ready" || item.status === "available"
                            ? "success"
                            : item.status === "unavailable" || item.status === "service_required"
                              ? "danger"
                              : "warning"
                        }
                      >
                        {human(item.status)}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <SurfaceBoundary
            action={<Button onClick={() => setDialog({ kind: "item" })}>Add item</Button>}
            state="empty"
            title="No equipment items"
          />
        )}
      </section>
      <div className="planning-split">
        <section className="planning-section">
          <header>
            <div>
              <h2>Kits</h2>
              <p>Kit membership references child assets without duplicating them.</p>
            </div>
          </header>
          <div className="kit-list">
            {kits.map((kit) => (
              <article key={kit.id}>
                <header>
                  <Boxes aria-hidden="true" />
                  <div>
                    <strong>{kit.title}</strong>
                    <span>{kit.summary || `${kit.members.length} item types`}</span>
                  </div>
                  <Button onClick={() => setDialog({ kind: "member", kit })} variant="quiet">
                    Set member
                  </Button>
                </header>
                <ul>
                  {kit.members.map((member) => (
                    <li key={member.equipmentItemId}>
                      <span>{member.title}</span>
                      <strong>× {member.quantity}</strong>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          {!kits.length ? (
            <p className="planning-empty-line">No kits have been assembled.</p>
          ) : null}
        </section>
        <section className="planning-section">
          <header>
            <div>
              <h2>Reservations</h2>
              <p>
                Time windows are half-open: an item may be rebooked exactly when its prior
                reservation ends.
              </p>
            </div>
            <Button
              icon={<CalendarClock />}
              onClick={() => setDialog({ kind: "reservation" })}
              variant="primary"
            >
              Reserve
            </Button>
          </header>
          {reservations.length ? (
            <ol className="reservation-list">
              {reservations.map((row) => (
                <li key={row.id}>
                  <div>
                    <strong>{row.resourceTitle}</strong>
                    <span>
                      {dateTime(row.startsAt, row.timezone)} → {dateTime(row.endsAt, row.timezone)}
                    </span>
                    <small>{row.timezone}</small>
                  </div>
                  <Status
                    tone={row.status === "confirmed" || row.status === "ready" ? "success" : "info"}
                  >
                    {row.status}
                  </Status>
                </li>
              ))}
            </ol>
          ) : (
            <p className="planning-empty-line">No equipment is reserved yet.</p>
          )}
        </section>
      </div>
      {dialog ? (
        <EquipmentDialog
          data={data}
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

function EquipmentDialog({
  data,
  dialog,
  error,
  onClose,
  onSubmit,
  pending,
}: {
  readonly data: PlanningControls;
  readonly dialog: DialogState;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: (input: { path: string; body: unknown }) => void;
  readonly pending: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "item")
      onSubmit({
        path: "/equipment",
        body: {
          title: text(form, "title"),
          status: text(form, "status"),
          summary: nullable(form, "summary"),
          ownershipType: text(form, "ownershipType"),
          category: text(form, "category"),
          manufacturer: nullable(form, "manufacturer"),
          model: nullable(form, "model"),
          serialAssetId: nullable(form, "serialAssetId"),
          condition: nullable(form, "condition"),
          valueMinor: moneyOrNull(form, "value"),
          currency: nullable(form, "currency"),
          storageLocation: nullable(form, "storageLocation"),
        },
      });
    else if (dialog.kind === "kit")
      onSubmit({
        path: "/kits",
        body: { title: text(form, "title"), summary: nullable(form, "summary") },
      });
    else if (dialog.kind === "member")
      onSubmit({
        path: `/kits/${encodeURIComponent(dialog.kit.id)}/members`,
        body: {
          equipmentItemId: text(form, "equipmentItemId"),
          quantity: Number(form.get("quantity")),
        },
      });
    else {
      const [kind, id] = text(form, "resource").split(":", 2);
      onSubmit({
        path: "/reservations",
        body: {
          equipmentItemId: kind === "item" ? id : null,
          equipmentKitId: kind === "kit" ? id : null,
          startsAt: zonedLocalToUtc(text(form, "startsAt"), data.project.timezone),
          endsAt: zonedLocalToUtc(text(form, "endsAt"), data.project.timezone),
          timezone: data.project.timezone,
          status: text(form, "status"),
          overrideReason: nullable(form, "overrideReason") ?? undefined,
        },
      });
    }
  }
  const title =
    dialog.kind === "item"
      ? "Add equipment item"
      : dialog.kind === "kit"
        ? "Create equipment kit"
        : dialog.kind === "member"
          ? `Set member · ${dialog.kit.title}`
          : "Reserve equipment";
  return (
    <DialogFrame error={error} onClose={onClose} title={title}>
      <form className="planning-form" onSubmit={submit}>
        {dialog.kind === "item" ? (
          <>
            <Field label="Item name">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <div className="planning-form__grid">
              <Field label="Ownership">
                <select defaultValue="owned" name="ownershipType">
                  <option value="owned">Owned</option>
                  <option value="borrowed">Borrowed</option>
                  <option value="rented">Rented</option>
                </select>
              </Field>
              <Field label="Status">
                <select defaultValue="available" name="status">
                  <option value="available">Available</option>
                  <option value="planned">Planned</option>
                  <option value="reserved">Reserved</option>
                  <option value="ready">Ready</option>
                  <option value="unavailable">Unavailable</option>
                  <option value="service_required">Service required</option>
                </select>
              </Field>
              <Field label="Category">
                <input defaultValue="camera" name="category" required />
              </Field>
              <Field label="Manufacturer">
                <input name="manufacturer" />
              </Field>
              <Field label="Model">
                <input name="model" />
              </Field>
              <Field label="Serial / asset ID">
                <input name="serialAssetId" />
              </Field>
              <Field label="Condition">
                <input name="condition" />
              </Field>
              <Field label="Storage location">
                <input name="storageLocation" />
              </Field>
              <Field label={`Value (${data.project.currency})`}>
                <input min="0" name="value" step="0.01" type="number" />
              </Field>
              <Field label="Currency">
                <input
                  defaultValue={data.project.currency}
                  maxLength={3}
                  minLength={3}
                  name="currency"
                />
              </Field>
            </div>
            <Field label="Notes">
              <textarea name="summary" rows={4} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "kit" ? (
          <>
            <Field label="Kit name">
              <input autoFocus minLength={2} name="title" required />
            </Field>
            <Field label="Purpose / notes">
              <textarea name="summary" rows={4} />
            </Field>
          </>
        ) : null}
        {dialog.kind === "member" ? (
          <>
            <Field label="Equipment item">
              <select name="equipmentItemId" required>
                {data.equipment.items
                  .filter((item) => !item.archivedAt)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {item.category}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Quantity">
              <input defaultValue="1" min="1" name="quantity" required type="number" />
            </Field>
            <p className="planning-form__notice">
              Setting an existing member updates its quantity; it never creates a duplicate physical
              asset.
            </p>
          </>
        ) : null}
        {dialog.kind === "reservation" ? (
          <>
            <Field label="Resource">
              <select autoFocus name="resource" required>
                <optgroup label="Items">
                  {data.equipment.items
                    .filter((item) => !item.archivedAt)
                    .map((item) => (
                      <option key={item.id} value={`item:${item.id}`}>
                        {item.title}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Kits">
                  {data.equipment.kits
                    .filter((kit) => !kit.archivedAt)
                    .map((kit) => (
                      <option key={kit.id} value={`kit:${kit.id}`}>
                        {kit.title}
                      </option>
                    ))}
                </optgroup>
              </select>
            </Field>
            <div className="planning-form__grid">
              <Field label={`Starts (${data.project.timezone})`}>
                <input name="startsAt" required type="datetime-local" />
              </Field>
              <Field label={`Ends (${data.project.timezone})`}>
                <input name="endsAt" required type="datetime-local" />
              </Field>
              <Field label="Status">
                <select defaultValue="planned" name="status">
                  <option value="planned">Planned</option>
                  <option value="held">Held</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="ready">Ready</option>
                </select>
              </Field>
            </div>
            <Field label="Conflict override reason (only after review)">
              <textarea minLength={12} name="overrideReason" rows={3} />
            </Field>
            <p className="planning-form__notice">
              The server expands kit membership and checks every physical child asset. A conflict is
              blocked unless a named producer records an explicit reason.
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
function human(value: string) {
  return value.replaceAll("_", " ");
}
function duration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function dateTime(epoch: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(epoch);
}
function zonedLocalToUtc(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("Select a valid local date and time.");
  const wanted = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let guess = wanted;
  for (let index = 0; index < 3; index += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(guess);
    const take = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    guess +=
      wanted - Date.UTC(take("year"), take("month") - 1, take("day"), take("hour"), take("minute"));
  }
  return guess;
}
