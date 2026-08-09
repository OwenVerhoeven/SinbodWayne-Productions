import { describe, expect, it } from "vitest";

import { allModules } from "../app/module-catalog";
import { recordFieldCatalog } from "./field-catalog";
import { recordWorkflowCatalog } from "./workflow-catalog";

describe("guided record workflows", () => {
  it("covers every registry module with every persisted planning field exactly once", () => {
    const registryTypes = allModules.flatMap((module) =>
      module.recordType ? [module.recordType] : [],
    );

    expect(Object.keys(recordFieldCatalog).sort()).toEqual([...registryTypes].sort());
    for (const recordType of registryTypes) {
      const workflow = recordWorkflowCatalog[recordType];
      const fieldKeys = recordFieldCatalog[recordType]?.map((field) => field.key) ?? [];
      const guidedKeys = workflow?.groups.flatMap((group) => group.fieldKeys) ?? [];

      expect(workflow, `${recordType} needs a filmmaker-specific workflow`).toBeDefined();
      expect(workflow?.intro.length).toBeGreaterThan(30);
      expect(workflow?.outcome.length).toBeGreaterThan(20);
      expect([...guidedKeys].sort(), `${recordType} field coverage`).toEqual([...fieldKeys].sort());
      expect(new Set(guidedKeys).size, `${recordType} duplicate fields`).toBe(guidedKeys.length);
    }
  });
});
