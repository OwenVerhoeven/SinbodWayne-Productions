# Product Specification (Redacted)

## Identity and defaults

- Company: Sinbod Wayne
- Product: Sinbod Wayne Productions
- Browser title: Sinbod Wayne Productions — Pre-Production Studio
- Production URL: `https://productions.sinbodwayne.nl`
- Primary timezone: Europe/Amsterdam
- Locale and time: en-GB, 24-hour
- Currency and units: EUR, metric, degrees Celsius
- Default project timing: 24 fps, non-drop-frame; configurable per project/document
- Print: A4 default with Letter available
- Work types: short film, narrative video, music video, YouTube, commercial/promotional, and future episodic hierarchy

This repository intentionally contains no production credential values. Account identity and role requirements are implemented from an approved bootstrap manifest; secrets enter only through a hidden interactive provisioning path.

## Product outcome

Two authenticated Sinbod Wayne collaborators must be able to:

1. capture and promote an idea;
2. develop purpose, audience, story, characters, treatment, research, and references;
3. write/import a screenplay or AV script, issue revisions, and safely synchronize scenes;
4. break scenes into cast, locations, departments, equipment, effects, sound, safety, and custom elements;
5. confirm people, locations, suppliers, resources, budget, legal, insurance, logistics, and safety;
6. create boards, lookbooks, storyboards, shots, setups, and a technical look plan;
7. manage tasks, dependencies, calendars, schedule variants, stripboards, shoot days, conflicts, sides, and reports;
8. issue recipient-safe call sheets and production packs;
9. evaluate project/day readiness and freeze an approved or explicitly overridden Ready to Shoot issue;
10. export the complete pre-production graph and request a verified outbound archive to a private NAS.

The boundary ends before on-set execution. Take logging, actual timecards, daily production reports, continuity execution, media ingest, editing/review, finishing, post deliverables, and release-campaign work are outside this release.

## Completion standard

A module is complete only when its navigation, persisted records, relationships, API, validation, authorization, honest state handling, export where relevant, unit/integration coverage, and critical browser journey work together. Required capability may not be replaced by seed-only UI, a decorative control, a future-work label, or a provider-dependent dead end.

Issued revisions, decisions, reports, call sheets, sides, packs, readiness issues, and archive exports are immutable. Corrections supersede them. A logical file has immutable versions; issued artifacts pin exact versions.

## Users and collaboration

The production database has exactly three approved active accounts in one workspace:

- case-sensitive username `SinbodWayne`, display name `Sinbod Wayne`, role Workspace Owner and Producer;
- case-sensitive username `KyanWayne`, display name `Kyan Wayne`, role Producer.
- case-sensitive username `guest`, display name `Guest`, role Viewer with no create, edit, issue, approve, comment, upload, archive, or delete rights.

No public registration, invitations, anonymous creation, default email recovery, additional demos, or hidden administrators exist in production.

The owner controls account provisioning, ownership transfer, workspace deletion, retention, and sensitive owner-only overrides. The producer has full project creation and pre-production editing, including budget, legal, and casting-sensitive work, but not owner-only actions. The viewer is enforced as read-only by the Worker, including direct API requests.

The owner accepted that bootstrap credentials remain usable until voluntarily changed; the product does not require a first-login rotation. It does provide password change, session/device visibility, revocation, audit, bounded login backoff, and a recovery path that cannot permanently lock out both approved identities.

Collaboration includes comments, threads, mentions, assignments, approvals, activity history, notifications, announcements, direct messages, recent changes, optimistic conflicts, revalidation/presence, and narrow expiring/revocable external links. External views reveal only their explicit object/recipient scope and permitted fields.

## Information architecture

The grouped application shell exposes:

- Overview
- Development
- Writing
- Breakdown
- Visual Planning
- Production Planning
- Scheduling
- Operations
- Documents
- Readiness
- Settings

The shell includes branded login, collapsible navigation, workspace/project switcher, persistent phase/readiness status, global search/command palette, breadcrumbs and object actions, responsive layouts, useful mobile bottom actions, keyboard workflows, and deterministic print routes.

## Functional scope

### Workspace, projects, and files

One configurable workspace supports company data, departments, roles, element categories, templates, units, statuses, and retention. Projects support standalone and optional series/season/episode hierarchy; guided creation, templates, archive/restore, guarded delete; complete production metadata; lifecycle phases; truthful cross-module dashboard; unified search; and a hierarchical linked document/file library.

### Development

Idea inbox and promotion preserve history. A project may contain a structured brief, logline, pitches and synopses, treatment, director statement, outline/beats, story timeline, themes/motifs/tone, character/world bible, research with provenance/clearance, lookbook/pitch deck, version history, approvals, templates, and clean exports.

### Writing

The screenplay editor stores structured stable blocks, supports keyboard element changes, outline/navigation, title and page controls, Fountain/TXT and supported FDX exchange, reference-PDF review, named immutable revisions, locked numbering, comments, visible autosave/conflicts, and professional A4/Letter print.

Draft save and production sync are separate. Sync previews stable scene matches, additions, moves/revisions, ambiguities, and removals with downstream impact; unresolved mappings require user decisions; apply is transactional and audited.

AV scripts support stable segments and rows, configurable columns, timing/timecode, runtime totals, templates, versions, approvals, image links, and print. General structured documents support sanitized rich content, tables, checklists, links/files, versions, templates, sharing, presentation, and print.

### Breakdown and reports

Every canonical scene has source and override data, page-eighth totals, timing, story day, cast/location/elements, omitted/readiness status, and filters. Seeded/custom categories, source-range tags, manual elements, character proposals, audited merge, procurement, bulk actions, sides, DOOD, CSV, and print reports retain stable identity and revision pins.

### People, casting, locations, and communications

Contact/person records remain separate from login identities. Project roles, availability, confirmations, rates and sensitive fields are permissioned. Contacts support import preview, duplicate/merge review, archive/restore, reports, and conflicts.

Casting connects roles and script characters to candidates, consent/provenance, auditions, ratings, shortlist/offer/booked status, narrow submissions, sides, booking, retention, and reports without duplicating private data.

Locations distinguish physical locations from story sets and include contacts, maps, availability, scouts, versioned media, operational facilities, technical constraints, hazards/emergency data, requirements, budgets, comparisons, readiness gaps, and selectable-confidentiality exports.

Communications include announcements, internal messages, object comments/mentions, versioned attachments, templates, and an evidence-based provider outbox.

### Visual and technical planning

Mood boards/lookbooks have groups, ranked reusable media/text, layouts, captions/tags, source links, non-destructive annotation metadata, approvals, presentation, and print. Storyboards contain stable frames and rich shot metadata, can create/link shots with provenance, and offer list/board/presentation/print/CSV views.

Shot lists organize stable shots by scene/sequence/setup/day/unit/custom group, record creative and technical details, calculate prep/shoot totals, warn about coverage/readiness, and support accessible ordering and multiple exports. Setups and the versioned technical look plan connect camera, lighting, sound, power, reference files, requirements, and production packs.

### Finance, legal, safety, resources, and logistics

Versioned budgets use integer minor units and deterministic top-sheet/detailed calculations. Accounts, lines, vendors, quotes, orders, invoices, expenses, receipts, approvals, thresholds, variance, imports/exports, linked objects, and redacted views are planning tools rather than payroll, tax, or double-entry accounting.

A requirement register covers chain of title, agreements, releases, permits, insurance, rights, clearances, privacy/consent, and special-activity permissions. External signature evidence is uploaded/tracked; the app never claims legal validity. Legal holds gate deletion. Risk assessments, controls, residual scoring, emergency/method/safety plans, safeguarding, weather contingencies, approvals, reminders, and readiness links support preparation without making legal determinations.

Equipment supports owned/borrowed/rented assets, kits without duplicated children, rentals, reservations, availability and overlap detection, custodianship, readiness, and packing lists. Breakdown resources add sourcing, variants, continuity, fittings/tests, tasks, files, and departmental readiness. Logistics connects transport, travel, accommodation, catering, facilities, access, cost, sensitive dietary/accessibility data, and call-sheet/pack summaries.

### Tasks, approvals, calendar, and schedule

Multiple task boards provide ranked cards, custom columns, checklists, owners, dependencies, files, comments, approvals, links, filters, bulk actions, archive/restore, and templates.

A common immutable decision history supports requested, approved, changes-requested, rejected, expired, and superseded states pinned to exact revisions. Self-approval policy is explicit.

Calendar variants provide month/week/list and timeline/Gantt views, rows, events, milestones, working rules, dependencies with cycle detection, timezone-safe conflicts, domain links, and stable-identity ICS export.

Schedules provide named variants, immutable revisions, ranked scene/segment/break/meal/move/banner/rehearsal/transport/note items, accessible reorder, boneyard, configurable strips, confirmed auto-order previews, shoot-day metadata, totals, split scenes, resource/readiness conflicts, comparisons, and print/export reports. Shoot days pin an exact schedule revision.

### Call sheets, production packs, and readiness

Call sheets cover shoot day, scout, rehearsal, fitting/test, and custom use. Drafts populate linked production data, support recipient-specific calls/notes/attachments and configurable sections/templates, and preview desktop/phone/print. Issue creates immutable numbered content and recipient variants with pinned sources and a content integrity value. Scoped links show only one recipient variant; evidence-based view/confirmation events and manual producer confirmation are audited. A correction supersedes.

Sides pin a script revision and selected scenes/characters/day. Production packs select, order, permission-filter, preview, and issue scripts/sides, calls, schedules, visuals, locations, resources, logistics, safety, requirements, weather, and contacts as deterministic print/PDF/ZIP manifests.

The readiness engine evaluates project and shoot-day rules for creative approval, synced writing, breakdown, people, locations, budget, legal/insurance, safety, equipment/resources, logistics, schedule, visuals, sides, call-sheet confirmation, production pack, and archive health. Every result identifies its source, ownership, evidence, severity, due date, and resolution. Missing/unloaded data cannot be green. Overrides are scoped, reasoned, timestamped, expiring, audited, and policy-limited. Ready to Shoot freezes all results, approvals, overrides, version pins, and manifest integrity. Relevant later changes mark it Stale with an exact reason; reapproval issues a new version.

### Complete export and NAS archive

An authorized producer creates an immutable private-cloud export snapshot. In the current no-subscription profile, its byte objects live in private Workers KV behind the immutable storage adapter; D1 holds relational metadata, pins, quotas, checksums, and job state. A manifest records versioned project data, safe relative paths, immutable object/revision identifiers, sizes, media types, checksums, and overall integrity.

The current storage contract is 25 MiB per file/object, 1 GB (`1000000000` bytes) total planned storage, 1,000 writes per day, and single-request uploads only. Workers KV propagation is eventually consistent; recent-write misses are retriable and never silently normalized to success, deletion, or corruption. R2 remains a future optional capacity backend behind the adapter rather than a current requirement.

The outbound-only NAS agent and checksum protocol are implemented and locally tested. Production NAS credential, host, mount, and destination provisioning are a later optional operational phase. When configured, the agent leases work, stages transfers, resumes safely, checks space where available, rejects traversal and link escape, verifies size/checksum, syncs durable writes where supported, atomically promotes verified content, and acknowledges idempotently.

Requested, Running, Verifying, Verified, and Failed are evidence-based job states with attempts and actionable errors. Archive, Verify, and Delete are distinct. Verification never deletes the cloud source.

## Platform and quality requirements

The baseline stack is a compact npm TypeScript workspace using React, Vite, a Cloudflare Worker/Hono API, D1, Drizzle-style checked-in migrations, private Workers KV through a storage-neutral immutable adapter, shared boundary schemas, React Router, disciplined query/table state, Workflows, focused Durable Object collaboration, Vitest/Workers integration, Playwright, and a deliberately scoped PWA draft store. The baseline requires no payment card or subscription; larger-capacity R2 storage is a future optional migration.

The API uses versioned app/public/service/webhook route groups, typed envelopes, request IDs, complete validation, cursor pagination, optimistic conflict responses, idempotency, redacted structured logs, durable job state, and duplicate-delivery safety.

Core workflows target WCAG 2.2 AA and responsive desktop/tablet/phone behavior. Drag operations have menu/keyboard equivalents. Print is deterministic for A4 and Letter. Tests cover pure invariants, D1/migration/policy integration, provider/manual fallbacks, offline conflicts, private-recipient isolation, and the end-to-end acceptance journeys documented in `PLANS.md`.

## Security and privacy summary

The Worker enforces deny-by-default, tenant/project/object/action/field policy. Session credentials are high entropy and hashed at rest; cookies are production-secure and mutations are CSRF protected. Login and all public/service/provider surfaces are rate limited. Rich content is sanitized; uploads are scoped, validated, private, and have a quarantine/scan seam. High-impact and sensitive-data actions are audited.

Privacy controls include purpose and provenance, minimization, retention review, correction/export/deletion seams, legal holds, and narrower access for finance, legal, rates, casting-private, dietary/medical/accessibility, emergency, and recipient-private data. The product makes no legal or compliance certification claim.
