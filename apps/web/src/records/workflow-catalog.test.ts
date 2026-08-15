import { describe, expect, it } from "vitest";

import { recordFieldCatalog } from "./field-catalog";
import { recordWorkflowCatalog } from "./workflow-catalog";

describe("guided record workflows", () => {
  it("keeps every preserved registry backend covered while its navigation is focused", () => {
    const registryTypes = Object.keys(recordFieldCatalog);

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
