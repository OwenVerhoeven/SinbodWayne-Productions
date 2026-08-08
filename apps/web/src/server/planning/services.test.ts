import { describe, expect, it } from "vitest";

import {
  calculatePlanningBudgetLine,
  evaluateLogisticsReadiness,
  findReservationConflicts,
  rollupBudgetTotals,
  spreadsheetSafeCell,
} from "./services";

describe("planning-control calculations", () => {
  it("calculates budget lines and variance in integer minor units", () => {
    const line = calculatePlanningBudgetLine({
      currency: "EUR",
      rateMinor: 12_345,
      quantityMilli: 1_500,
      durationMilli: 2_000,
      fringeBps: 1_000,
      taxBps: 2_100,
      markupBps: 500,
      approvedMinor: 50_000,
      committedMinor: 48_000,
      actualMinor: 52_500,
      paidMinor: 20_000,
    });
    expect(line).toEqual({
      subtotalMinor: 37_035,
      estimateMinor: 51_331,
      approvedMinor: 50_000,
      committedMinor: 48_000,
      actualMinor: 52_500,
      paidMinor: 20_000,
    });
    expect(rollupBudgetTotals([line], 1_000)).toMatchObject({
      estimateMinor: 56_464,
      contingencyMinor: 5_133,
      varianceMinor: 2_500,
    });
  });

  it("detects direct-to-kit and kit-to-kit equipment overlaps but permits adjacent windows", () => {
    const conflicts = findReservationConflicts(
      [
        {
          id: "direct",
          equipmentItemId: "camera",
          equipmentKitId: null,
          startsAt: 0,
          endsAt: 100,
          status: "confirmed",
        },
        {
          id: "kit",
          equipmentItemId: null,
          equipmentKitId: "camera-kit",
          startsAt: 50,
          endsAt: 150,
          status: "planned",
        },
        {
          id: "adjacent",
          equipmentItemId: "camera",
          equipmentKitId: null,
          startsAt: 150,
          endsAt: 200,
          status: "planned",
        },
      ],
      [{ kitId: "camera-kit", itemId: "camera" }],
    );
    expect(conflicts).toEqual([
      {
        resourceItemId: "camera",
        reservationIds: ["direct", "kit"],
        overlapMs: 50,
        severity: "blocker",
      },
    ]);
  });

  it("never reports unloaded or incomplete logistics as ready", () => {
    expect(
      evaluateLogisticsReadiness({
        loaded: false,
        planStatus: null,
        baseCamp: null,
        toilets: null,
        powerCharging: null,
        accessNotes: null,
        emergencyNotes: null,
        transportStatuses: [],
        cateringStatuses: [],
      }).state,
    ).toBe("not_loaded");
    expect(
      evaluateLogisticsReadiness({
        loaded: true,
        planStatus: "draft",
        baseCamp: "",
        toilets: "",
        powerCharging: "",
        accessNotes: "",
        emergencyNotes: "",
        transportStatuses: [],
        cateringStatuses: [],
      }).state,
    ).toBe("blocked");
    expect(
      evaluateLogisticsReadiness({
        loaded: true,
        planStatus: "approved",
        baseCamp: "West lot",
        toilets: "Two accessible units",
        powerCharging: "32 A shore power",
        accessNotes: "Gate B",
        emergencyNotes: "Evacuate via Gate B",
        transportStatuses: ["confirmed"],
        cateringStatuses: ["not_required"],
      }),
    ).toEqual({ state: "ready", missing: [] });
  });

  it("guards spreadsheet formula prefixes", () => {
    expect(spreadsheetSafeCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
  });
});
