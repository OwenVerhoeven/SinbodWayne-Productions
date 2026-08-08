# ADR 0002: Canonical scene identity

- Status: Accepted
- Date: 2026-08-08

## Context

Scene number, order, slugline and text all change during writing. Breakdown tags, cast, locations, elements, shots, frames, schedules, sides, calls, tasks, requirements and readiness must survive those changes. Treating a human-facing number or matching text as identity would silently detach or misattach expensive downstream work.

## Decision

Every production scene has an opaque stable `scene_id`. A screenplay revision contains immutable `scene_revision` records that point to canonical scenes. Display number, order, slugline, source block range and text are revision data, not identity.

Downstream relations always foreign-key `scene_id`; where reproducibility matters they additionally pin a script/scene revision. Split schedule segments point to one canonical scene. A removed scene with downstream work becomes explicitly omitted, remapped or archived; it is never cascade-deleted because it vanished from the current script.

Locked numbering preserves established display numbers. Insertions receive deterministic alphanumeric display numbers such as an inserted scene after 2; the suffix is display policy, not an ID.

## Consequences

- Scene relationships remain intact across renumbering, moves and text changes.
- Reports can distinguish current scene truth from the pinned source used by an issued artifact.
- Sync requires an explicit mapping layer between draft revision candidates and canonical scenes.
- Future on-set/post records can attach to the same canonical identity without rewriting history.

## Alternatives considered

- Scene number as key: rejected because numbering is mutable and locked insertions are alphanumeric.
- Slugline/text fingerprint as key: rejected because edits and repeated/ambiguous scenes are normal.
- New IDs on every revision: rejected because it moves mapping complexity into every downstream module and risks silent data loss.
