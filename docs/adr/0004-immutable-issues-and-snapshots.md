# ADR 0004: Immutable decisions, issues, and snapshots

- Status: Accepted
- Date: 2026-08-08

## Context

Production decisions and documents must be reproducible. If a current script, schedule, file, permission or template changes, an already issued call sheet, sides pack, report, approval, production pack, readiness certificate or archive export must not silently change. Corrections and stale state also need a complete audit trail.

## Decision

The following records are append-only after successful creation:

- script/AV/development/document/schedule/budget/technical revisions;
- approval decisions and immutable decision history;
- issued call sheets, recipient variants, sides, reports and production packs;
- Ready to Shoot issues and their complete rule results/source pins/overrides;
- export snapshots, manifests and archive acknowledgements;
- audit events.

An issue/snapshot contains or references canonical structured content, the exact revision/file-version/source IDs, permission-filtered recipient scope, author/time, schema version, content/manifest integrity and idempotency identity. Database guards reject update/delete as defense in depth.

Corrections create a new issue with `supersedes_id`. Current-state projections can mark an issue Stale or Superseded and list exact change events, but do not edit the frozen issue body. Restores create a new revision/head transition.

Large canonical bodies live in private R2 with immutable D1 metadata and pins. Small bounded rule/decision snapshots may live in D1 JSON when schema-versioned.

## Consequences

- Historical documents remain reproducible for audits, recipient privacy, archive and future production modules.
- Storage grows; retention must explicitly preserve legal holds and known-good copies.
- Issuance is a durable/idempotent operation, not a normal row update.
- Generated display/PDF can be regenerated from the canonical snapshot, but a regenerated projection does not alter the issue integrity.

## Alternatives considered

- Update issued rows in place: rejected because historical truth and recipient variants would drift.
- Store only rendered PDFs: rejected because permissions, accessibility, deterministic regeneration, search and future schema migration need structured content and pins.
- Store every large body in D1: rejected due to database size/performance and binary-storage responsibilities.
