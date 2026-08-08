import { applyBasisPoints, budgetVariance, calculateBudgetLine } from "@swp/domain";

export interface PlanningBudgetLineInput {
  readonly currency: string;
  readonly rateMinor: number;
  readonly quantityMilli: number;
  readonly durationMilli: number;
  readonly fringeBps: number;
  readonly taxBps: number;
  readonly markupBps: number;
  readonly approvedMinor: number;
  readonly committedMinor: number;
  readonly actualMinor: number;
  readonly paidMinor: number;
}

export interface PlanningBudgetLineAmounts {
  readonly subtotalMinor: number;
  readonly estimateMinor: number;
  readonly approvedMinor: number;
  readonly committedMinor: number;
  readonly actualMinor: number;
  readonly paidMinor: number;
}

export interface PlanningBudgetTotals extends PlanningBudgetLineAmounts {
  readonly contingencyMinor: number;
  readonly varianceMinor: number;
}

function safeInteger(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range.`);
  }
  return Number(value);
}

export function calculatePlanningBudgetLine(
  input: PlanningBudgetLineInput,
): PlanningBudgetLineAmounts {
  const calculated = calculateBudgetLine({
    currency: input.currency,
    rateMinor: input.rateMinor,
    quantityMilli: input.quantityMilli,
    durationMilli: input.durationMilli,
    fringeBps: input.fringeBps,
    taxBps: input.taxBps,
    markupBps: input.markupBps,
  });
  return {
    subtotalMinor: calculated.subtotalMinor,
    estimateMinor: calculated.totalMinor,
    approvedMinor: input.approvedMinor,
    committedMinor: input.committedMinor,
    actualMinor: input.actualMinor,
    paidMinor: input.paidMinor,
  };
}

export function rollupBudgetTotals(
  lines: readonly PlanningBudgetLineAmounts[],
  contingencyBps: number,
): PlanningBudgetTotals {
  const sum = (field: keyof PlanningBudgetLineAmounts): number =>
    safeInteger(
      lines.reduce((total, line) => total + BigInt(line[field]), 0n),
      `Budget ${field}`,
    );
  const estimateBeforeContingency = sum("estimateMinor");
  const contingencyMinor = applyBasisPoints(estimateBeforeContingency, contingencyBps);
  const estimateMinor = safeInteger(
    BigInt(estimateBeforeContingency) + BigInt(contingencyMinor),
    "Budget estimate",
  );
  const approvedMinor = sum("approvedMinor");
  const committedMinor = sum("committedMinor");
  const actualMinor = sum("actualMinor");
  const paidMinor = sum("paidMinor");
  return {
    subtotalMinor: sum("subtotalMinor"),
    estimateMinor,
    contingencyMinor,
    approvedMinor,
    committedMinor,
    actualMinor,
    paidMinor,
    varianceMinor: budgetVariance(approvedMinor, actualMinor),
  };
}

export interface ReservationPlanningRow {
  readonly id: string;
  readonly equipmentItemId: string | null;
  readonly equipmentKitId: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly status: string;
}

export interface KitPlanningMember {
  readonly kitId: string;
  readonly itemId: string;
}

export interface ReservationConflictView {
  readonly resourceItemId: string;
  readonly reservationIds: readonly [string, string];
  readonly overlapMs: number;
  readonly severity: "blocker";
}

/** Expands kits to their physical child assets and checks half-open time windows. */
export function findReservationConflicts(
  reservations: readonly ReservationPlanningRow[],
  kitMembers: readonly KitPlanningMember[],
): readonly ReservationConflictView[] {
  const membersByKit = new Map<string, string[]>();
  for (const member of kitMembers) {
    const members = membersByKit.get(member.kitId) ?? [];
    members.push(member.itemId);
    membersByKit.set(member.kitId, members);
  }
  const byItem = new Map<string, ReservationPlanningRow[]>();
  for (const reservation of reservations) {
    if (reservation.status === "cancelled" || reservation.endsAt <= reservation.startsAt) continue;
    const itemIds = reservation.equipmentItemId
      ? [reservation.equipmentItemId]
      : (membersByKit.get(reservation.equipmentKitId ?? "") ?? []);
    for (const itemId of new Set(itemIds)) {
      const rows = byItem.get(itemId) ?? [];
      rows.push(reservation);
      byItem.set(itemId, rows);
    }
  }
  const conflicts: ReservationConflictView[] = [];
  for (const [resourceItemId, rows] of [...byItem.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ordered = [...rows].sort(
      (left, right) => left.startsAt - right.startsAt || left.id.localeCompare(right.id),
    );
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const left = ordered[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const right = ordered[rightIndex]!;
        if (right.startsAt >= left.endsAt) break;
        conflicts.push({
          resourceItemId,
          reservationIds: [left.id, right.id],
          overlapMs: Math.min(left.endsAt, right.endsAt) - right.startsAt,
          severity: "blocker",
        });
      }
    }
  }
  return conflicts;
}

export interface LogisticsReadinessInput {
  readonly loaded: boolean;
  readonly planStatus: string | null;
  readonly baseCamp: string | null;
  readonly toilets: string | null;
  readonly powerCharging: string | null;
  readonly accessNotes: string | null;
  readonly emergencyNotes: string | null;
  readonly transportStatuses: readonly string[];
  readonly cateringStatuses: readonly string[];
}

export interface LogisticsReadinessView {
  readonly state: "not_loaded" | "blocked" | "ready";
  readonly missing: readonly string[];
}

export function evaluateLogisticsReadiness(input: LogisticsReadinessInput): LogisticsReadinessView {
  if (!input.loaded) return { state: "not_loaded", missing: ["Logistics data has not loaded."] };
  const missing: string[] = [];
  if (!input.planStatus || !["ready", "approved", "confirmed"].includes(input.planStatus)) {
    missing.push("Approve or confirm the primary logistics plan.");
  }
  for (const [value, label] of [
    [input.baseCamp, "Record the base camp or unit-base arrangement."],
    [input.toilets, "Confirm toilet facilities."],
    [input.powerCharging, "Confirm power and charging."],
    [input.accessNotes, "Record access and loading instructions."],
    [input.emergencyNotes, "Record logistics emergency instructions."],
  ] as const) {
    if (!value?.trim()) missing.push(label);
  }
  if (input.transportStatuses.length === 0) {
    missing.push("Add a transport plan or explicitly mark transport not required.");
  } else if (
    input.transportStatuses.some(
      (status) => !["ready", "approved", "confirmed", "not_required"].includes(status),
    )
  ) {
    missing.push("Resolve unconfirmed transport plans.");
  }
  if (input.cateringStatuses.length === 0) {
    missing.push("Add a catering plan or explicitly mark catering not required.");
  } else if (
    input.cateringStatuses.some(
      (status) => !["ready", "approved", "confirmed", "not_required"].includes(status),
    )
  ) {
    missing.push("Resolve unconfirmed catering plans.");
  }
  return { state: missing.length === 0 ? "ready" : "blocked", missing };
}

export function spreadsheetSafeCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const guarded = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}
