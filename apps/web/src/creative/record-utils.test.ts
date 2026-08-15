import { describe, expect, it } from "vitest";

import { navigationGroups } from "../app/module-catalog";
import type { DomainRecord } from "../app/schemas";
import { countWords, detailList, detailText, titleFromNote } from "./record-utils";

describe("focused creative studio", () => {
  it("exposes exactly the four intended project tools", () => {
    expect(navigationGroups.flatMap((group) => group.modules).map((module) => module.key)).toEqual([
      "overview",
      "ideas",
      "story",
      "screenplay",
    ]);
  });

  it("turns a quick note into a useful, bounded display title", () => {
    expect(titleFromNote("\nA bus that remembers every passenger\nMore notes")).toBe(
      "A bus that remembers every passenger",
    );
    expect(titleFromNote("x".repeat(100))).toBe(`${"x".repeat(69)}…`);
    expect(titleFromNote("  \n  ")).toBe("Untitled idea");
  });

  it("reads deliberately typed details and counts prose without drift", () => {
    const record: DomainRecord = {
      id: "idea-1",
      recordType: "idea",
      title: "Idea",
      status: "spark",
      summary: null,
      ownerDisplayName: null,
      sortRank: "a0",
      details: { body: "One  two\nthree", tags: ["night", 7, "memory"] },
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      archivedAt: null,
    };
    expect(detailText(record, "body")).toBe("One  two\nthree");
    expect(detailList(record, "tags")).toEqual(["night", "memory"]);
    expect(countWords(detailText(record, "body"))).toBe(3);
  });
});
