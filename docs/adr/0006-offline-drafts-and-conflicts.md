# ADR 0006: Deliberately scoped offline drafts and conflict review

- Status: Accepted
- Date: 2026-08-08

## Context

Scouts and mobile users need useful note/task editing with unreliable connectivity. Broad offline replication of finance, legal, writing sync, files, issued artifacts or readiness would increase privacy risk and make conflict semantics misleading. Silent last-write-wins is prohibited.

## Decision

The installable PWA caches the versioned application shell. An IndexedDB/Dexie store supports only:

- development notes;
- scout notes;
- task/checklist edits;
- visual-planning notes.

Every local draft includes user/workspace/project/object/type, base server version, bounded structured payload, local time and state. Sensitive API responses, credentials, exports and binary files are not placed in the general offline cache.

Reconnect sends the original base version. If current equals base, the server applies transactionally and returns evidence before local deletion. If stale, the server returns safe current/base/incoming data and the UI requires explicit review/merge/copy. If permission, archive or object state changed, the draft remains locally recoverable/exportable and the denial is shown.

The collaboration channel is only an invalidation/presence accelerator. D1 remains authoritative and no character-level CRDT claim is made.

## Consequences

- Offline support is truthful, testable and privacy-bounded.
- Unsupported modules disable mutation and explain why rather than queueing unsafe work.
- Conflict UI and draft lifecycle are required release features, not an edge-case toast.
- Local-device data requires expiration, sign-out cleanup policy and user-visible discard/export controls.

## Alternatives considered

- Full offline database replication: rejected due to scope, privacy and complex cross-module invariants.
- Last-write-wins queue: rejected because it loses user work silently.
- No offline support: rejected because scouts/tasks/notes have a concrete connectivity need.
