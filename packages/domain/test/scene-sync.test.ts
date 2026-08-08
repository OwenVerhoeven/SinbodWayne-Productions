import { describe, expect, it } from "vitest";

import {
  DomainError,
  applySceneSync,
  previewSceneSync,
  type CanonicalScene,
  type IncomingScene,
} from "../src";
import { fingerprint, id } from "./fixtures";

function canonical(
  sequence: number,
  displayNumber: string,
  slugline: string,
  hashCharacter: string,
  downstream = false,
): CanonicalScene {
  return {
    id: id(sequence),
    displayNumber,
    order: sequence - 1,
    slugline,
    contentFingerprint: fingerprint(hashCharacter),
    omitted: false,
    archived: false,
    downstreamLinks: downstream
      ? [
          { kind: "shot", objectId: id(100 + sequence) },
          { kind: "schedule_item", objectId: id(200 + sequence) },
          { kind: "task", objectId: id(300 + sequence) },
        ]
      : [],
  };
}

function incoming(
  draftSequence: number,
  proposedSequence: number,
  order: number,
  slugline: string,
  hashCharacter: string,
  priorSceneSequence?: number,
): IncomingScene {
  return {
    draftSceneId: id(draftSequence),
    proposedSceneId: id(proposedSequence),
    order,
    slugline,
    contentFingerprint: fingerprint(hashCharacter),
    ...(priorSceneSequence === undefined ? {} : { priorSceneId: id(priorSceneSequence) }),
    candidateSceneIds: [],
  };
}

describe("canonical screenplay sync", () => {
  const scenes = [
    canonical(1, "1", "INT. FLAT - NIGHT", "1"),
    canonical(2, "2", "EXT. BUS STOP - NIGHT", "2"),
    canonical(3, "3", "INT. NIGHT BUS - NIGHT", "3", true),
    canonical(4, "4", "EXT. CANAL - NIGHT", "4"),
    canonical(5, "5", "INT. KITCHEN - DAWN", "5"),
    canonical(6, "6", "EXT. STREET - DAWN", "6", true),
  ];

  it("previews insertion, relative move, revision, and removal while retaining downstream impact", () => {
    const draft = [
      incoming(401, 501, 0, scenes[0]!.slugline, "1", 1),
      incoming(402, 502, 1, scenes[1]!.slugline, "2", 2),
      incoming(407, 507, 2, "INT. BUS SHELTER - NIGHT", "7"),
      incoming(404, 504, 3, scenes[3]!.slugline, "4", 4),
      incoming(403, 503, 4, "INT. NIGHT BUS - LATER", "a", 3),
      incoming(405, 505, 5, scenes[4]!.slugline, "5", 5),
    ];
    const preview = previewSceneSync({
      canonicalScenes: scenes,
      incomingScenes: draft,
      lockedNumbering: true,
    });

    expect(preview.hasUnresolvedMappings).toBe(false);
    expect(preview.entries.find((entry) => entry.draftSceneId === id(407))).toMatchObject({
      status: "added",
      assignedDisplayNumber: "2A",
    });
    expect(preview.entries.find((entry) => entry.canonicalSceneId === id(3))).toMatchObject({
      revised: true,
      moved: true,
    });
    expect(preview.removed).toHaveLength(1);
    expect(preview.removed[0]).toMatchObject({ canonicalSceneId: id(6), displayNumber: "6" });
    expect(preview.removed[0]!.downstreamLinks.map((link) => link.kind)).toEqual([
      "shot",
      "schedule_item",
      "task",
    ]);

    expect(() =>
      applySceneSync({
        preview,
        canonicalScenes: scenes,
        incomingScenes: draft,
        removedDecisions: {},
        appliedAt: 1_700_000_000_000,
      }),
    ).toThrowError(/explicit decision/);

    const applied = applySceneSync({
      preview,
      canonicalScenes: scenes,
      incomingScenes: draft,
      removedDecisions: { [id(6)]: { action: "omit" } },
      appliedAt: 1_700_000_000_000,
    });
    const revisedScene = applied.scenes.find((scene) => scene.id === id(3));
    expect(revisedScene).toMatchObject({ slugline: "INT. NIGHT BUS - LATER", displayNumber: "3" });
    expect(revisedScene?.downstreamLinks).toEqual(scenes[2]!.downstreamLinks);
    expect(applied.scenes.find((scene) => scene.id === id(6))).toMatchObject({
      omitted: true,
      archived: false,
    });
    expect(applied.retainedDownstreamSceneIds).toContain(id(6));
  });

  it("does not classify scenes after an insertion as moved", () => {
    const draft = [
      incoming(411, 511, 0, scenes[0]!.slugline, "1", 1),
      incoming(412, 512, 1, "EXT. INSERT - NIGHT", "a"),
      ...scenes
        .slice(1)
        .map((scene, index) =>
          incoming(
            420 + index,
            520 + index,
            index + 2,
            scene.slugline,
            String(index + 2),
            index + 2,
          ),
        ),
    ];
    const preview = previewSceneSync({
      canonicalScenes: scenes,
      incomingScenes: draft,
      lockedNumbering: true,
    });
    expect(preview.entries.filter((entry) => entry.moved)).toHaveLength(0);
  });

  it("keeps duplicate sluglines ambiguous until a human maps them", () => {
    const repeated = [
      canonical(11, "11", "INT. OFFICE - DAY", "1"),
      canonical(12, "12", "INT. OFFICE - DAY", "2"),
    ];
    const draft = [incoming(601, 701, 0, "INT. OFFICE - DAY", "f")];
    const preview = previewSceneSync({
      canonicalScenes: repeated,
      incomingScenes: draft,
      lockedNumbering: true,
    });
    expect(preview.hasUnresolvedMappings).toBe(true);
    expect(preview.entries[0]).toMatchObject({ status: "ambiguous", reason: "ambiguous_slugline" });
    expect(preview.entries[0]!.candidateSceneIds).toEqual([id(11), id(12)]);
    expect(() =>
      applySceneSync({
        preview,
        canonicalScenes: repeated,
        incomingScenes: draft,
        removedDecisions: {},
        appliedAt: 1,
      }),
    ).toThrowError(/Ambiguous/);

    const resolved = previewSceneSync({
      canonicalScenes: repeated,
      incomingScenes: draft,
      lockedNumbering: true,
      manualMappings: { [id(601)]: id(12) },
    });
    expect(resolved.hasUnresolvedMappings).toBe(false);
    expect(resolved.entries[0]?.canonicalSceneId).toBe(id(12));
  });

  it("flags splits that try to reuse one prior identity and refuses colliding new IDs", () => {
    const draft = [
      incoming(801, 901, 0, "INT. ROOM - DAY", "a", 1),
      incoming(802, 902, 1, "INT. ROOM - LATER", "b", 1),
    ];
    const preview = previewSceneSync({
      canonicalScenes: [scenes[0]!],
      incomingScenes: draft,
      lockedNumbering: true,
    });
    expect(preview.entries[1]).toMatchObject({ status: "ambiguous", reason: "duplicate_mapping" });

    const simpleDraft = [incoming(803, 1, 0, "EXT. NEW - DAY", "c")];
    const simplePreview = previewSceneSync({
      canonicalScenes: [scenes[0]!],
      incomingScenes: simpleDraft,
      lockedNumbering: false,
    });
    expect(() =>
      applySceneSync({
        preview: simplePreview,
        canonicalScenes: [scenes[0]!],
        incomingScenes: simpleDraft,
        removedDecisions: { [id(1)]: { action: "archive" } },
        appliedAt: 1,
      }),
    ).toThrowError(DomainError);
  });

  it("creates explicit redirects when removed work is remapped", () => {
    const draft = [incoming(901, 991, 0, scenes[0]!.slugline, "1", 1)];
    const preview = previewSceneSync({
      canonicalScenes: [scenes[0]!, scenes[2]!],
      incomingScenes: draft,
      lockedNumbering: true,
    });
    const applied = applySceneSync({
      preview,
      canonicalScenes: [scenes[0]!, scenes[2]!],
      incomingScenes: draft,
      removedDecisions: { [id(3)]: { action: "remap", targetSceneId: id(1) } },
      appliedAt: 2,
    });
    expect(applied.redirects).toEqual([{ fromSceneId: id(3), toSceneId: id(1) }]);
  });
});
