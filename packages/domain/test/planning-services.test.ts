import { describe, expect, it } from "vitest";

import {
  applyElementMerge,
  calculateScheduleTotals,
  detectDependencyCycle,
  detectResourceConflicts,
  detectScheduleTimingConflicts,
  previewElementMerge,
  topologicalOrder,
  wouldCreateDependencyCycle,
  type ElementRecord,
  type ResourceAssignment,
} from "../src";
import { id } from "./fixtures";

describe("transactional element merge planning", () => {
  const base = {
    workspaceId: id(1),
    projectId: id(2),
    categoryId: id(3),
    archived: false,
  } as const;
  const elements: ElementRecord[] = [
    { ...base, id: id(10), name: "Hero phone", aliases: ["Phone A"], quantity: 1 },
    { ...base, id: id(11), name: "Mobile phone", aliases: ["Phone A", "Cell"], quantity: 2 },
  ];

  it("previews aliases, quantities, reference redirects, and duplicate removal before apply", () => {
    const references = [
      { referenceType: "scene_tag", referenceId: id(20), elementId: id(10) },
      { referenceType: "scene_tag", referenceId: id(20), elementId: id(11) },
      { referenceType: "shot", referenceId: id(21), elementId: id(11) },
    ] as const;
    const preview = previewElementMerge({
      elements,
      references,
      targetId: id(10),
      sourceIds: [id(11)],
      quantityStrategy: "sum",
    });
    expect(preview.resultingAliases).toEqual(["Cell", "Mobile phone", "Phone A"]);
    expect(preview.resultingQuantity).toBe(3);
    expect(preview.redirectedReferences).toHaveLength(2);
    expect(preview.removedDuplicateReferences).toHaveLength(1);

    const applied = applyElementMerge({ elements, preview });
    expect(applied.elements.find((element) => element.id === id(10))).toMatchObject({
      quantity: 3,
    });
    expect(applied.elements.find((element) => element.id === id(11))).toMatchObject({
      archived: true,
      mergedIntoId: id(10),
    });
    expect(applied.references.every((reference) => reference.elementId === id(10))).toBe(true);
  });

  it("denies cross-project and implicit cross-category merges", () => {
    expect(() =>
      previewElementMerge({
        elements: [elements[0]!, { ...elements[1]!, projectId: id(99) }],
        references: [],
        targetId: id(10),
        sourceIds: [id(11)],
        quantityStrategy: "keep_target",
      }),
    ).toThrowError(/different tenants or projects/);
    expect(() =>
      previewElementMerge({
        elements: [elements[0]!, { ...elements[1]!, categoryId: id(98) }],
        references: [],
        targetId: id(10),
        sourceIds: [id(11)],
        quantityStrategy: "keep_target",
      }),
    ).toThrowError(/Cross-category/);
  });
});

describe("cast, crew, location, equipment, turnaround, and travel conflicts", () => {
  function assignment(
    assignmentSequence: number,
    resourceSequence: number,
    startMs: number,
    endMs: number,
    locationSequence: number,
    resourceType: ResourceAssignment["resourceType"] = "equipment",
  ): ResourceAssignment {
    return {
      assignmentId: id(assignmentSequence),
      scheduleItemId: id(assignmentSequence + 100),
      resourceType,
      resourceId: id(resourceSequence),
      startMs,
      endMs,
      locationId: id(locationSequence),
      unit: "Main",
      minimumTurnaroundMs: 60,
    };
  }

  it("finds overlaps, availability gaps, short turnaround, and impossible travel", () => {
    const assignments = [
      assignment(10, 50, 0, 100, 70),
      assignment(11, 50, 50, 150, 70),
      assignment(12, 50, 200, 250, 71),
    ];
    const conflicts = detectResourceConflicts({
      assignments,
      availability: [{ resourceType: "equipment", resourceId: id(50), startMs: 0, endMs: 240 }],
      travelDurations: [{ fromLocationId: id(70), toLocationId: id(71), durationMs: 100 }],
    });
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(
      expect.arrayContaining(["overlap", "unavailable", "turnaround", "travel"]),
    );
  });

  it("treats adjacent half-open reservations as non-overlapping", () => {
    const conflicts = detectResourceConflicts({
      assignments: [
        assignment(20, 60, 0, 100, 70, "cast"),
        assignment(21, 60, 100, 200, 70, "cast"),
      ].map((row) => ({ ...row, minimumTurnaroundMs: 0 })),
      availability: [],
      travelDurations: [],
    });
    expect(conflicts).toEqual([]);
  });

  it.each(["cast", "crew", "location", "equipment"] as const)(
    "detects a %s double-booking",
    (resourceType) => {
      const conflicts = detectResourceConflicts({
        assignments: [
          assignment(30, 80, 0, 100, 70, resourceType),
          assignment(31, 80, 99, 200, 70, resourceType),
        ],
        availability: [],
        travelDurations: [],
      });
      expect(conflicts).toContainEqual(
        expect.objectContaining({ kind: "overlap", resourceType, resourceId: id(80) }),
      );
    },
  );
});

describe("dependency cycle safety", () => {
  const nodes = ["permit", "scout", "schedule", "call-sheet"] as const;
  const edges = [
    { prerequisiteId: "permit", dependentId: "scout" },
    { prerequisiteId: "scout", dependentId: "schedule" },
    { prerequisiteId: "schedule", dependentId: "call-sheet" },
  ] as const;

  it("orders acyclic dependencies and detects a proposed cycle with its path", () => {
    expect(topologicalOrder(nodes, edges)).toEqual(nodes);
    expect(
      wouldCreateDependencyCycle(nodes, edges, {
        prerequisiteId: "call-sheet",
        dependentId: "permit",
      }),
    ).toBe(true);
    expect(
      detectDependencyCycle(nodes, [
        ...edges,
        { prerequisiteId: "call-sheet", dependentId: "permit" },
      ]),
    ).toEqual(["call-sheet", "permit", "scout", "schedule", "call-sheet"]);
  });

  it("detects self-dependencies", () => {
    expect(detectDependencyCycle(["a"], [{ prerequisiteId: "a", dependentId: "a" }])).toEqual([
      "a",
      "a",
    ]);
  });
});

describe("schedule totals and hard timing conflicts", () => {
  const item = (sequence: number, startMs: number, endMs: number, pageEighths: number) => ({
    itemId: id(sequence),
    unit: "Main",
    startMs,
    endMs,
    pageEighths,
    prepMs: 10,
    setupMs: 20,
    shootMs: 100,
    moveMs: 30,
    mealMs: sequence === 91 ? 60 : 0,
  });

  it("totals eighths and integer durations and estimates wrap exactly", () => {
    const totals = calculateScheduleTotals(
      [item(90, 1_000, 1_160, 3), item(91, 1_160, 1_380, 5)],
      10_000,
    );
    expect(totals).toEqual({
      pageEighths: 8,
      prepMs: 20,
      setupMs: 40,
      shootMs: 200,
      moveMs: 60,
      mealMs: 60,
      totalMs: 380,
      estimatedWrapMs: 10_380,
    });
  });

  it("detects same-unit overlap and violated hard windows, but permits adjacent items", () => {
    const conflicts = detectScheduleTimingConflicts(
      [
        item(90, 1_000, 1_200, 3),
        item(91, 1_150, 1_300, 5),
        { ...item(92, 1_300, 1_400, 0), unit: "Second" },
      ],
      [
        { itemId: id(90), earliestStartMs: 1_050 },
        { itemId: id(91), latestEndMs: 1_250 },
      ],
    );
    expect(conflicts.map((conflict) => conflict.kind)).toEqual([
      "unit_overlap",
      "hard_window",
      "hard_window",
    ]);
  });
});
