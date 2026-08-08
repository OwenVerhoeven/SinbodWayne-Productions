# Implementation Plan

This is the authoritative milestone ledger for Sinbod Wayne Productions. A checked item means its implementation and acceptance evidence exist; creating a file, table, or route alone is insufficient. No required item is deferred. Production-day and post-production workflows are the only intentional future scope.

## Status legend

- `[ ]` planned or in progress, not yet proven complete
- `[x]` implemented and verified; evidence must be linked from `IMPLEMENTATION_STATUS.md`
- Milestones run in order where dependencies require it, while independent implementation and tests may proceed in parallel.

## Dependency map

```text
M0 foundation
 ├─> M1 identity, policy, collaboration
 ├─> M2 development and documents ─> M3 writing/scene graph ─> M4 breakdown
 ├─> M5 people/locations/comms
 ├─> M6 visual/technical
 └─> M7 finance/legal/resources

M1 + M2…M7 ─> M8 tasks/calendar/schedule
M3 + M4 + M5 + M6 + M7 + M8 ─> M9 call sheets/packs
M1…M9 ─> M10 readiness/export/NAS
M0…M10 ─> M11 hardening/deployment
```

## Milestone 0 — discovery, design, and engineering foundation

Dependencies: none.

- [x] Confirm the target repository and preserve the unrelated Filmcraft repository as read-only reference.
- [x] Inspect the available Filmcraft source and record a non-copying sibling visual direction.
- [x] Write the redacted product specification, repository guide, architecture/data/design/security/operations documentation, decision log, and traceability targets.
- [x] Initialize the npm TypeScript workspace and root commands.
- [x] Establish React/Vite/Worker development and Static Assets SPA routing.
- [x] Establish Hono API groups, boundary validation, typed envelopes, request IDs, pagination, and error taxonomy.
- [x] Configure local D1, private Workers KV through the immutable storage adapter, Workflow binding, and collaboration Durable Object.
- [x] Create checked-in migrations, schema typing, migration smoke tests, and derived-search rebuild procedure.
- [x] Implement opaque IDs, UTC time helpers, rational frame time, minor-unit money, page eighths, and stable ranks.
- [x] Implement object registry, audit foundation, deny-by-default policy seam, optimistic version assertion, and immutable-row guards.
- [x] Implement logical file/version metadata, private upload/download authorization seams, integrity metadata, and cleanup state.
- [x] Implement accessible tokens, application shell, navigation modes, feedback primitives, and empty/loading/error/denied/offline/conflict states.
- [x] Implement deterministic print-route foundation for A4 and Letter.
- [x] Configure unit, Worker/D1 integration, migration, Playwright, accessibility, and production-build harnesses.
- [x] Pass formatting, lint, typecheck, domain/unit, integration, migration, browser smoke, and build gates.

Acceptance tests:

- A clean clone installs and runs documented commands without secret material.
- Migrations create an empty, foreign-key-valid local database and can be reapplied safely according to policy.
- The Worker serves the SPA, typed API health response, security headers, request ID, authorized private KV round trip, and print route.
- The shell is keyboard operable at desktop/tablet/phone widths and has no console error or horizontal trap.
- A stale version assertion produces a recoverable conflict; an attempted mutation of an immutable record fails.

## Milestone 1 — secure login and shared workspace

Dependencies: M0 persistence, policy, audit, and test foundations.

- [x] Build first-party, case-sensitive username/password authentication with generic errors and bounded backoff.
- [x] Qualify and pin a current Worker-compatible password KDF; keep encoded verifier parameters only.
- [x] Build one-time hidden-input bootstrap and owner recovery that never logs or resets secrets on deployment.
- [x] Enforce exactly two approved active production identities and no registration/invitation/demo/default account path.
- [x] Implement hashed high-entropy sessions, secure production cookie, idle/absolute expiry, rotation, auth epoch, listing, logout, and revocation.
- [x] Implement password change that revokes other sessions and the accepted no-forced-first-login-rotation policy.
- [x] Implement same-origin/Fetch Metadata/content-type/CSRF mutation defenses.
- [x] Implement workspace/project membership, owner/producer policy, sensitive-field grants, and cross-tenant denial.
- [x] Implement comments, threads, mentions, assignments, approvals foundation, append-only activity, notifications/unread, announcements, and direct messages.
- [x] Implement conflict envelopes, bounded invalidation/presence channel, BroadcastChannel, and polling fallback without a CRDT claim.
- [x] Implement hashed, expiring, revocable public/share/recipient/service credential foundations and separate route contexts.
- [x] Audit authentication, permission, sensitive, share, and high-impact events with redaction.

Acceptance tests:

- Journey A passes end to end, including generic rate-limited failure, owner/producer boundaries, revocation, and direct-URL/cross-project denial.
- Two browsers see independent-object updates; same-object stale writes preserve both versions for review.
- Viewer/commenter/approver/candidate/recipient links reveal only their explicit field/object scope and revoke immediately.
- Production bootstrap is idempotent and verifies only the two approved active accounts; tests use isolated fictional identities.

## Milestone 2 — projects, idea development, documents, and templates

Dependencies: M1 identity and collaboration; M0 files and print.

- [x] Build workspace profile, defaults, configurable departments/roles/categories/statuses/units/templates/retention.
- [x] Build standalone and series/season/episode hierarchy plus guided project create/edit/template clone/archive/restore/guarded delete.
- [x] Implement full project metadata, phase lifecycle, enabled modules, headers, and always-visible readiness.
- [x] Build truthful cross-module dashboard, unified permitted search, command palette, and recent changes.
- [x] Build linked logical directory with default production folders, favorites, search/filter/order alternatives, archive/restore, and recent items.
- [x] Build idea inbox, attachments/references, history-preserving promotion, search/filter/archive.
- [x] Build versioned project brief and development documents: pitches, synopsis, treatment, statements, rationale, themes/motifs/tone.
- [x] Build structured outlines/acts/sequences/beats/cards and separate chronological story timeline.
- [x] Build character/world bible, relationships, research notebook, provenance, and clearance flags.
- [x] Build mood/lookbook and pitch-deck foundation with ordered sections, presentation, approval, and print.
- [x] Build version/compare/restore-as-new-head, comments/mentions, approvals, statuses, and versioned development templates.
- [x] Build structured general documents with sanitized blocks, tables/checklists/files, folders, templates, sharing, presentation, and print.
- [x] Export project brief, treatment, outline/beat sheet, character bible, bibliography, lookbook, pitch deck, and development pack.

Acceptance tests:

- Journey B passes through capture, promotion, complete story development, review, approval, and immutable export.
- Idea history and linked files remain attached after promotion.
- Archived/permission-denied/conflict/print states are honest and project search never leaks another workspace.

## Milestone 3 — screenplay, AV scripts, and canonical scene graph

Dependencies: M2 projects/documents; M0 IDs/files/print; M1 collaboration.

- [x] Build structured screenplay blocks and keyboard-first editor, autocomplete, find/replace, outline/navigation, title/page/header/footer controls, and visible save state.
- [x] Build deterministic Fountain import/export fixtures and warnings; TXT import; supported FDX import/export with unsupported report; reference-PDF review seam.
- [x] Build immutable named revisions, revision colors/marks, compare, approved/current distinction, rollback-as-new-head, comments anchored to stable blocks/ranges.
- [x] Build locked/unlocked scene numbering and alphanumeric insertion using stable canonical scene IDs.
- [x] Separate draft save from production sync.
- [x] Build sync preview for added, matched/revised, moved, ambiguous, split/merge, and removed scenes with downstream impact.
- [x] Require explicit uncertain/removed-scene decisions; apply sync transactionally with immutable audit and preserved downstream identity.
- [x] Build professional screenplay print/export with A4/Letter, watermark/confidentiality, title page, selected revision, and revision marks.
- [x] Build stable AV scripts, segments/rows/banners, configurable columns, media, timing/manual stopwatch/ranges/timecode, word/runtime totals, versions/compare/restore, approvals, templates, and print.

Acceptance tests:

- Journey C passes exactly: scenes 1–6, downstream links on scene 3, numbering lock, inserted 2A, move/revision/removal, review and resolution, omitted retained work, stable identity.
- Unit fixtures cover slugline changes, insertions, moves, ambiguous matches, splits, merges, and removals.
- Frame/duration calculations are exact at supported rational rates; import/export fixture round trips are deterministic with explicit loss reports.

## Milestone 4 — breakdown, elements, sides, and reports

Dependencies: M3 scene graph and revisions; M0 files/print.

- [x] Build scene list and breakdown fields, source/override distinction, omission, readiness, page-eighth and timing totals.
- [x] Seed industry categories and support versioned/custom categories.
- [x] Build stable source-range tags, manual/implied elements, aliases, profiles, owners, quantities, status, costs, continuity, requirements, and scene links.
- [x] Build explicit character proposals and transactional element/contact merge with preview, redirects, audit, and reference preservation.
- [x] Build all specified filters, bulk preview/undo paths, archive/restore, and complete/blocked indicators.
- [x] Build procurement linkage and departmental readiness for props, wardrobe, makeup, dressing, and consumables.
- [x] Build breakdown sheets/summary, element/cast/location/department lists, CSV and configurable print.
- [x] Build immutable report definitions/snapshots and sides by scene/character/location/day pinned to script revision.
- [x] Build DOOD for cast and selectable element categories with configurable legend.

Acceptance tests:

- Page eighths remain integer-exact and reports agree with filtered scene/element data.
- Merge preview shows every redirect and transactionally preserves references.
- Issued sides/report snapshots remain pinned when current script/file versions change.

## Milestone 5 — people, casting, locations, and communications

Dependencies: M1 policy/collaboration; M3 scenes; M4 elements; M0 files.

- [x] Build separate person/contact and authenticated-identity models with provenance, consent, retention, archive/restore, duplicate and merge review.
- [x] Build contact points, emergency/sensitive fields, project roles/departments, booking, dates, availability, rates/terms, deal/legal status, confirmations, custom lists, CSV preview/export, and reports.
- [x] Build casting roles linked to characters/scenes/sides, candidates and representation/media/resume, consent/retention, conflicts, auditions, message log, criteria/ratings/comparison, shortlist-to-booked pipeline.
- [x] Build narrow expiring candidate submission with constraints and no project visibility; booking links existing person data.
- [x] Build distinct locations/sets, contacts/maps/timezone/fees/availability/holds/status, scouts and versioned media, facilities/access/transport, technical restrictions, safety/emergency, and linked requirements/budget/tasks/days/files.
- [x] Build location comparison/readiness gaps and confidentiality-selectable scout/location/pack exports.
- [x] Build announcements, internal messages, object comments/mentions, versioned attachments, templates, evidence-based outbox, and provider/manual status.

Acceptance tests:

- Sensitive rates, private casting notes, emergency and dietary/accessibility data are field-redacted outside granted scopes.
- Candidate links accept only constrained submission data and cannot enumerate project objects or identities.
- Availability/conflict and location readiness agree across contacts, schedules, call sheets, and reports.
- No delivery/open state appears without provider or recipient evidence.

## Milestone 6 — visual and technical planning

Dependencies: M2 projects/files; M3 scenes; M4 elements; M5 locations/people.

- [x] Build multiple mood/look boards, groups, reusable ranked media/text, layout/background/captions/tags/favorites, comments/approvals, presentation and print.
- [x] Build bulk upload, immutable source media, crop/adjustment metadata, and non-destructive text/shape/arrow annotations.
- [x] Link board items to projects, scenes, characters, locations, elements, shots, and setups.
- [x] Build storyboards grouped by scene/sequence/custom, stable frames with complete creative/technical metadata, reorder alternatives, archive/restore, views and exports.
- [x] Create/link shots from frames with explicit provenance and no accidental duplication.
- [x] Build shot lists/groups, stable IDs/display numbers, source ranges, complete camera/creative/sound/effects/location/timing/risk/status fields, totals and readiness warnings.
- [x] Build camera/lighting setups with equipment, diagrams, power/grip/sound, personnel requirements, and setup/move duration.
- [x] Build accessible review/approval, list/thumbnail/setup/print/CSV views, configurable columns, ranked banners/meals/moves.
- [x] Build versioned/approved technical look plan and include pinned version in the production pack.

Acceptance tests:

- Annotation edits never mutate the source file and prior issues retain the pinned source version.
- Frame-to-shot provenance and object links survive reorder, archive/restore, and scene sync.
- Mobile/touch review and keyboard ordering both complete without inaccessible drag dependencies.

## Milestone 7 — finance, legal, safety, equipment, and logistics

Dependencies: M1 sensitive policy; M2 projects/files; M4 elements; M5 people/locations; M6 setups.

- [x] Build versioned working/approved budgets, account hierarchy, linked lines, deterministic subtotal/fringe/tax/markup/contingency, approved/committed/actual/paid amounts and variance.
- [x] Build vendors, quotes/comparison, purchase orders, invoices, expenses/receipts, petty cash, payment due/status, approvals/thresholds/history, import preview/CSV and print.
- [x] Enforce finance permission/redaction; remain explicitly outside payroll, tax filing, and double-entry accounting.
- [x] Build configurable legal/rights/insurance requirement register with ownership, related objects, dates, blocker state, template/file version, execution/approval and reminders.
- [x] Cover all specified agreements, releases, permits, insurance, rights, clearances, special activities, privacy/consent; track external signature evidence without legal claims.
- [x] Build legal holds that block destructive file/project retention actions.
- [x] Build risk assessments, hazards/affected people, likelihood/impact/residual score, controls, owners/approvals/reviews; method, emergency, medical, evacuation, contingency, safeguarding and briefing plans.
- [x] Build equipment assets/kits/member composition, rental/borrow/owned status, availability, reservations, overlap warnings, planned custodian, checklists and packing lists.
- [x] Extend production resources with sourcing, quantities/measurements/variants, continuity, fitting/test dates, tasks, readiness and department pull lists.
- [x] Build transport/vehicles/drivers/passengers/moves/routes; travel/accommodation; catering/meals/sensitive restrictions; facilities/base/power/waste/security/access/emergency; daily summary and cost links.

Acceptance tests:

- Money calculations use minor units and deterministic rounding; import/export and top sheet agree.
- Legal hold reliably blocks deletion independent of UI visibility.
- Risk and equipment overlap calculations produce configured warnings/blockers from related scene/day data.
- Sensitive and redacted exports omit protected fields without leaving hidden data in markup or files.

## Milestone 8 — tasks, approvals, calendars, schedules, and shoot days

Dependencies: M1 collaboration; M2–M7 shared production graph.

- [x] Build multiple task boards/columns, ranked cards, complete fields, owners, checklists, dependencies, files/comments/mentions/object links/approvals, templates, filters, archive/restore, bulk actions, and department views.
- [x] Build dependency cycle detection and blocking/overdue readiness links.
- [x] Build common approval requests and immutable decision history pinned to exact versions, including explicit self-approval policy.
- [x] Build calendar variants/templates, timeline/Gantt and month/week/list views, rows/events/milestones/working rules, links/files/comments, timezone-safe dependencies/conflicts and stable ICS export.
- [x] Build schedule variants/duplicate/compare/default, immutable revisions, all ranked item types, accessible order/bulk/omit/restore/boneyard, filters and configurable strips.
- [x] Build confirmed auto-order/group preview, day breaks, hard constraints, exact page/prep/setup/shoot/move/meal/wrap totals, split-scene segments and canonical scene links.
- [x] Detect configured cast, crew, location, equipment, travel, turnaround, availability and legal/safety conflicts as warning or blocker.
- [x] Generate shoot day from pinned revision and mark related issued/readiness artifacts stale after relevant schedule change.
- [x] Export one-liner, stripboard, shooting schedule, DOOD/day-out-of-days, conflict reports, daily sides, and schedule summary for A4/Letter.

Acceptance tests:

- Journey E passes with two variants, all requested item types, cast/equipment conflicts, resolution/override, pinned shoot day/reports, and correct estimated wrap.
- Dependency cycle and timezone/DST fixtures fail safely and ICS update identity stays stable.
- Schedule revision comparisons and stale reasons identify exact source changes.

## Milestone 9 — call sheets, sides, and production packs

Dependencies: M3–M8 complete linked production graph; M0 files/print; M1 public recipient context.

- [x] Build all call-sheet types, from-day/from-scratch source provenance, comprehensive linked population and manual weather/sun fallback.
- [x] Build multiple labeled person calls, private recipient notes/attachments, section order/visibility, configurable columns/layouts, versioned templates, and desktop/phone/email/print preview.
- [x] Issue immutable numbered call sheets with pinned source/file versions, content integrity, confidentiality, recipient variants, and audit.
- [x] Build unique scoped recipient links, isolated view evidence, confirmation/optional note, producer manual confirmation, and issue status dashboard.
- [x] Build superseding corrections while preserving prior issues and policy-controlled links.
- [x] Implement EmailProvider/SmsProvider interfaces, development outbox, secure-link/download/print/manual fallbacks, and truthful not-configured/failed states.
- [x] Generate immutable sides with revision marks/highlights/watermarks/title/page numbering from pinned revisions.
- [x] Build production-pack selection/order, role/recipient confidentiality filtering, deterministic preview/print/PDF/ZIP, immutable issue, manifest and complete pins.

Acceptance tests:

- Journey F passes with a day-generated draft, individual private data, desktop/phone/print, three isolated variants, one confirmation, correction, and immutable pack.
- Print fixtures cover long content and ensure no clipping, blank trailing pages, or recipient-private crossover.
- Issue/send/confirmation retries are idempotent and never invent delivery/view evidence.

## Milestone 10 — readiness, complete export, and NAS archive

Dependencies: all production-graph modules M1–M9.

- [x] Build versioned readiness profiles/rules for every specified project/day category and project-type configuration.
- [x] Derive automatic results from loaded source records; require actor/date/evidence for manual checks; never turn missing/unloaded data green.
- [x] Build detailed blocker/warning gaps grouped by department/day with source, owner, due date, evidence and resolution route.
- [x] Build scoped/reasoned/timestamped/expiring/audited overrides and owner-only restricted categories.
- [x] Mark Ready to Shoot by issuing an immutable evaluation with all results, approvals, overrides, pins and manifest integrity.
- [x] Detect relevant subsequent changes, mark issue Stale with exact deltas, and preserve/reissue history.
- [x] Build printable readiness certificate/summary and production-pack inclusion.
- [x] Build module PDF/print/CSV, human-readable exports, versioned full-project JSON and complete file/checksum manifest.
- [x] Build immutable export snapshots and durable archive job/lease/heartbeat/attempt/idempotency state using the private-object adapter, D1, and Workflows.
- [x] Build outbound-only NAS agent with explicit destination, space check, range resume, staging, traversal/link escape rejection, size/checksum verification, durable write, atomic promotion, safe logging and credential rotation.
- [x] Keep archive, verification, and owner-only cloud retention/delete distinct; require verified archive plus retention/legal-hold checks and typed confirmation.

Acceptance tests:

- Journey G passes from truthful blockers through permitted override, immutable readiness issue, stale detection, and reissue; restricted override denial is enforced server-side.
- Journey H passes file replacement/pinning, interrupted resume, checksum/missing-object failure, successful verification, idempotent acknowledgement, and no cloud deletion.
- Complete demo project can pass readiness; intentionally incomplete fixtures accurately remain blocked.
- NAS tests cover traversal, reparse/symlink escape, insufficient space, duplicate acknowledgements, interrupted transfer, missing object, mismatch, resume and atomic promotion.

## Milestone 11 — integration hardening and deployment

Dependencies: M0–M10 feature and test completion.

- [x] Build installable PWA shell, explicit offline status and scoped Dexie drafts for development/scout/task/checklist/visual notes only.
- [x] Queue offline writes with base versions and test safe apply versus conflict review; never cache auth/API/sensitive files as general offline data.
- [x] Complete deterministic fictional six-scene demo project through real migrations/APIs for every module, blocked-to-ready and NAS fixtures; keep it out of production bootstrap.
- [x] Automate journeys A–J across domain, Worker/D1 integration, and Playwright as appropriate.
- [x] Complete authorization/abuse, security, accessibility, dependency, privacy, performance, N+1, responsive, offline, and print reviews; resolve all critical/high findings.
- [x] Exercise empty/populated/loading/error/conflict/archived/denied/offline/not-configured/print states in a browser at desktop/tablet/phone widths.
- [x] Verify clean migrations, seed determinism, backup/restore procedure, FTS rebuild, rollback and operational ownership.
- [x] Run and record every verification command with exact result.
- [ ] When authorized, create only unique production resources, replace the reviewed D1 and Workers KV placeholder IDs, apply reviewed remote migrations, run hidden bootstrap, attach only the production subdomain, deploy, and smoke test login/shell/D1/KV/recipient/print/readiness/cloud archive request. **Externally blocked:** Wrangler is unauthenticated and neither production resource ID has been supplied.

Production NAS host, mount, destination, and service-credential provisioning are a later optional operational rollout. The locally implemented agent/protocol remain complete; production status must stay `Not configured` or another evidence-backed non-verified state until that rollout is exercised.

- [x] If cloud authorization is unavailable, leave local work complete and document exact unexecuted commands, required resource identifiers, bindings and operator inputs without claiming deployment.

Acceptance tests:

- Journey I passes two-user updates, same-version conflict, preserved drafts, offline reconnect safe apply/conflict.
- Journey J passes long A4/Letter documents, recipient privacy, phone layout, and keyboard-only create/edit/approve.
- Aggregate verification is green from a clean install/migration/seed.
- Deployment smoke evidence is recorded only if it was actually executed against the verified production target.

## Mandatory journey ledger

- [x] A — secure two-user access
- [x] B — idea to approved story
- [x] C — revision safety
- [x] D — full breakdown and planning
- [x] E — schedule and conflict
- [x] F — immutable call sheet and production pack
- [x] G — Ready to Shoot
- [x] H — file version and NAS
- [x] I — collaboration and offline conflict
- [x] J — print, mobile, and accessibility

Each journey must exercise real persisted data. Browser-visible fixtures may not bypass the API or hard-code final states.

## Decision log

| Date       | Decision                                                                                                                                                                | Rationale                                                                                             | Consequence                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-08 | Use an npm TypeScript workspace with React/Vite, Hono Worker, D1, private Workers KV, Workflows, and focused Durable Object collaboration.                              | Compact Cloudflare-native deployment with shared types and no mandatory paid SaaS.                    | Worker compatibility and the bounded KV profile are dependency gates.                                                                                                   |
| 2026-08-08 | Treat local Filmcraft source as visual research only.                                                                                                                   | Preserve the sibling brand language without copying source, resources, or trade dress.                | Tokens and patterns are documented independently.                                                                                                                       |
| 2026-08-08 | Keep D1 authoritative and use live channels only for invalidation/presence.                                                                                             | Reliable optimistic concurrency is more important than claiming character-level real-time editing.    | The product explicitly does not claim CRDT editing.                                                                                                                     |
| 2026-08-08 | Use stable canonical scene IDs and a separate transactional sync review.                                                                                                | Script numbers and text change; downstream work must not detach.                                      | Ambiguous/removed mappings always require decisions.                                                                                                                    |
| 2026-08-08 | Make revisions, approvals, issues, file versions, readiness and archive snapshots immutable.                                                                            | Issued production truth must remain reproducible and auditable.                                       | Corrections create superseding records.                                                                                                                                 |
| 2026-08-08 | Use private Workers KV behind `PrivateObjectStore` for the no-card/no-subscription profile; keep files immutable and stream downloads through authorized Worker routes. | Prevent public listing and accidental replacement while keeping initial deployment subscription-free. | Enforce 25 MiB/file, 1 GB total, 1,000 writes/day, no multipart, and retriable eventual propagation; R2 is a future optional adapter migration (ADR 0008).              |
| 2026-08-08 | Scope offline support to explicit note/task/checklist/visual drafts with base versions.                                                                                 | Avoid unsafe claims and silent last-write-wins across the full graph.                                 | Reconnect may require visible conflict review.                                                                                                                          |
| 2026-08-08 | Use an outbound-only pull/lease NAS agent with staged checksum verification.                                                                                            | The NAS must not be an internet-facing origin and verification must be evidence based.                | Archive, verification and cloud deletion remain separate.                                                                                                               |
| 2026-08-08 | Keep bootstrap credentials usable until changed, as explicitly accepted by the owner.                                                                                   | The owner declined forced first-login rotation.                                                       | Compensating controls include interactive provisioning, rate limiting, hashing, audit, change and revocation; this accepted risk must be revisited if exposure changes. |
| 2026-08-08 | Use deterministic browser print/Save as PDF as the mandatory document path; provider PDF is optional.                                                                   | Core operation cannot depend on a paid or unavailable service.                                        | Print routes and A4/Letter tests are release gates.                                                                                                                     |
| 2026-08-08 | Use adapters with evidence-based status for email, SMS, weather, scanning and external signatures.                                                                      | Manual fallbacks keep the product complete without false provider claims.                             | Unconfigured adapters display `Not configured`.                                                                                                                         |
