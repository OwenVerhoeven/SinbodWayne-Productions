# ADR 0003: Separate, reviewable script synchronization

- Status: Accepted
- Date: 2026-08-08

## Context

Writers must save drafts frequently without rewriting production-planning truth. New revisions may insert, move, edit, split, merge or remove scenes. Automatic fuzzy matching can be useful but cannot silently decide ambiguous identity, especially when downstream breakdown, schedule, people, visual, legal or readiness work exists.

## Decision

Draft save, immutable revision creation and production sync are separate operations.

Sync has two phases:

1. **Preview:** compare a selected immutable script revision with the current canonical scene graph; classify added, matched/revised, moved, ambiguous, split/merge candidate and removed scenes; compute downstream impacts; store a reviewable immutable candidate set.
2. **Resolve and apply:** require explicit decisions for every ambiguity and every removed scene with downstream work; validate the base graph version; apply all mappings, new canonical scenes, revision pointers, omission/remap/archive decisions and audit in one D1 transaction; record an immutable applied sync.

Confidence scoring is advisory. Uncertain mappings never auto-apply. A retry uses an idempotency key and returns the original result. A graph change after preview makes the preview stale and requires regeneration or an explicit safe rebase.

Restoring an older script revision creates a new head/pointer transition and later sync; it does not erase revisions or prior syncs.

## Consequences

- Autosave remains fast and honest: `Saved` never means production modules changed.
- Users see the exact cost and relationships affected before applying a revision.
- Sync logic is a pure, fixture-heavy domain service plus a transactional persistence adapter.
- UI must support manual mapping, split/merge explanation, omitted work and safe cancellation.

## Alternatives considered

- Synchronize every draft save: rejected due to churn and silent downstream mutation.
- Match only by scene number/slugline: rejected as unsafe for insertions, moves and rewrites.
- Fully manual mapping for every scene: rejected because stable IDs and deterministic candidates can safely reduce work while preserving review.
