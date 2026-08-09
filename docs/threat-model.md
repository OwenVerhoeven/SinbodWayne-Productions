# Repository Threat Model

## Overview

Sinbod Wayne Productions is an internet-reachable but private pre-production workspace for two editing producers and one view-only guest identity. The Worker serves a React application and resource-oriented API; D1 stores normalized project, authorization, quota, and integrity data; private Workers KV stores bounded immutable file versions and issued/export objects behind a storage adapter; Workflows coordinate durable export/archive jobs; and a focused Durable Object distributes project invalidation/presence signals. The Node-based outbound NAS agent is implemented and locally tested, while production NAS provisioning is a later optional operational step.

The highest-value assets are:

- authentication verifiers, active sessions, share/service credentials, provider secrets, and recovery/bootstrap authority;
- private identities, contacts, candidate records, rates, finance, legal, health/accessibility/dietary, emergency, recipient-private, and location-security data;
- canonical production relationships, especially stable scene identity and downstream links;
- immutable revisions, approvals, call sheets, sides, packs, readiness issues, file versions, exports, checksums, and archive acknowledgements;
- authority to provision identities, transfer ownership, override restricted readiness checks, bypass retention/legal holds, remove cloud copies, deploy, or rotate archive credentials;
- availability of the planning workspace and recoverability of its D1/KV data plus any later verified NAS archive.

Primary runtime surfaces are expected under `apps/web`, `apps/nas-agent`, `packages/domain`, and `packages/ui`. Migrations and configuration define security boundaries even though they are not direct request handlers. Test fixtures and local seed tools are developer-controlled, but become critical if production can execute or import them.

The repository is at initial construction. Controls described here are requirements until `IMPLEMENTATION_STATUS.md` records executable evidence.

## Threat Model, Trust Boundaries, and Assumptions

### Actors and capabilities

- **Unauthenticated internet actor:** can reach login, public/share/recipient/candidate routes that possess a valid or guessed locator, provider webhooks, static assets, and any mistakenly exposed endpoint. Can automate requests and submit malformed content.
- **External link holder:** has a legitimate narrow link or recipient exchange secret. May be the intended person, a forwarded-link recipient, or an attacker who acquired it. Must remain constrained to one purpose/object/recipient and permitted fields.
- **Authenticated producer:** legitimately edits projects and sensitive pre-production data, but lacks account provisioning, ownership transfer, permanent workspace deletion, owner-only retention, and restricted override authority. May attempt privilege escalation or direct-object access.
- **Authenticated owner:** has the highest application authority but is still constrained by immutable history, explicit destructive confirmations, legal holds, archive evidence, CSRF protection, and audit.
- **Provider caller:** controls webhook payloads, timing, duplicates, ordering, and potentially compromised provider credentials. Provider evidence is untrusted until authenticated and reconciled.
- **NAS service identity:** can lease only archive jobs and acknowledge verified items/manifests within its scope. A stolen credential must not become application-user or cloud-deletion authority.
- **Deployment/bootstrap operator:** controls local inputs, Cloudflare bindings, migrations, release commands, and account provisioning. This is privileged operator input, not a trusted excuse to log secrets or bypass invariants.
- **Developer/test actor:** controls source, dependencies, fixtures, and local databases. Production configuration must exclude test identities, demo seed, debug bypasses, and unsafe source maps/logging.

### Trust boundaries

1. **Internet → edge application:** anonymous traffic crosses Cloudflare controls into login, public-link, webhook, and static routes. Route grouping, content validation, rate limits, security headers, and response redaction are required.
2. **Browser → authenticated API:** a cookie proves a session, not authorization to the requested workspace/project/object/field. Same-origin and CSRF controls protect mutation; every ID is attacker controlled.
3. **External-link context → project data:** a public identifier and exchanged secret may grant a narrow session. It must not share the authenticated app cookie, reveal other recipients or identities, or expand through common object references.
4. **Worker → Cloudflare state:** bindings are privileged. D1 queries must preserve tenant/object ownership; KV keys, metadata, quotas, and bodies must be scoped and private; Workflow and Durable Object messages must be authenticated/validated and idempotent.
5. **Mutable graph → issued truth:** screenplay drafts, schedule variants, calls, packs, and readiness sources change. Immutable revision pins, integrity values, explicit sync, and supersession prevent current pointers from rewriting historical truth.
6. **Upload/import/rich content → stored/rendered data:** files, Fountain/FDX/TXT/CSV, URLs, annotations, and structured rich text are untrusted. Bounded parsing, media validation, sanitization, quarantine/scan seams, and safe rendering prevent code/content confusion.
7. **Cloud archive → NAS agent:** the agent receives leased manifests and scoped download authority, writes into a mounted filesystem, and returns evidence. Every path, size, checksum, retry, free-space observation, staging location, link/reparse point, and acknowledgement is hostile or failure-prone.
8. **Local/CI tooling → production:** configuration names, migrations, bootstrap/recovery, seed commands, and deployment account selection can damage real data if environment checks fail. Production actions require explicit operator intent and target verification.

### Core assumptions

- Cloudflare correctly isolates bindings and protects configured secrets; repository code still validates authorization and does not rely on obscurity.
- HTTPS terminates correctly in production and the production cookie is secure, host-only, HTTP-only, strict same-site, and narrowly scoped.
- The two approved users protect their endpoints and voluntarily change credentials when appropriate. The accepted no-forced-first-login-rotation decision does not relax storage, rate-limit, recovery, or session requirements.
- D1 and Workers KV are the current active workspace stores; backups and exports are required because platform durability is not a substitute for tested recovery.
- The NAS destination is administered securely and mounted with suitable permissions. The agent must nevertheless contain malformed manifests and compromised job input within an explicitly configured destination.
- Optional providers may be absent or fail. Manual operation and truthful status are security and reliability requirements.
- No character-level real-time merge is promised. Optimistic concurrency and visible draft conflict are the source of truth.

## Attack Surface, Mitigations, and Attacker Stories

### Authentication, sessions, and recovery

An internet attacker may enumerate usernames, automate guesses, exploit a weak KDF profile, fix/steal sessions, abuse recovery, or invoke a development identity. Required mitigations are generic login behavior, bounded edge/application backoff, dummy KDF work for unknown names, a qualified pinned Worker-compatible KDF, random session credentials stored only as digests, rotation/expiry/auth-epoch revocation, secure cookie flags, audit, and a production account-count invariant. Bootstrap and owner recovery accept hidden interactive input and fail closed; they never pass credential values through repository/config/arguments/logging.

An authenticated producer may attempt owner-only account, retention, or override actions by calling hidden routes directly. Central policy resolution and integration tests must deny these independently of UI visibility.

### CSRF, XSS, injection, and unsafe rendering

A hostile site may attempt cookie-authenticated mutation. Same-origin validation, Fetch Metadata, approved content types, an unpredictable per-session CSRF value, strict same-site cookies, and no state-changing GET routes mitigate it.

An external candidate, commenter, import file, contact record, or approved user may persist markup, formula-like content, URLs, SVG/script payloads, or annotation data that executes when an owner opens a board/document/report. Structured content schemas, allowlist sanitization, safe URL schemes, CSP, safe download disposition, MIME sniffing protection, escaped exports, and adversarial rendering tests are required. Parameterized SQL and bounded parsers protect D1/import surfaces.

### Tenant, object, and sensitive-field authorization

Any client may replace an object identifier, nested parent, workspace/project value, cursor, or typed object reference. The Worker must resolve the canonical object, tenant/project ownership, membership, module action, and field policy before fetching or mutating. Association writes validate both ends in the same workspace/project. Errors and cursors do not reveal cross-scope existence.

Particularly harmful stories include reading private rates or candidate notes through a generic object endpoint, exporting legal/medical data through a broad pack, or seeing another call-sheet recipient's note/attachment. The mitigation is policy-filtered selection and serialization, not post-fetch UI redaction. Generated HTML/PDF/ZIP manifests receive the same field policy and are tested for hidden-data crossover.

### Public links, confirmations, and provider callbacks

A forwarded or leaked link may be replayed, brute-forced, expanded to adjacent IDs, or used after revocation. Link credentials are high entropy, stored only as digests, expiring and revocable; exchange produces a purpose-bound context separate from app sessions. Rate limiting, constant-time comparison, narrow object/field/verb scopes, and audit constrain use.

Provider callbacks and NAS acknowledgements may be forged, reordered, or duplicated. Authenticated signatures/credentials, timestamp/replay policy where applicable, schema validation, idempotency, monotonic state machines, and reconciliation to known jobs/recipients prevent fabricated delivery/view/verification. No status derives solely from the client saying it succeeded.

### Concurrency, revisions, scene mapping, and evidence integrity

Two users or offline retries may overwrite current data. Mutable rows carry base versions and a transactional version assertion. A mismatch returns safe current/base/incoming comparison data and preserves the draft. Durable Object events are hints only; D1 remains authoritative.

Changing screenplay numbering, sluglines, order, splitting/merging, or removal can detach downstream work if a human label is treated as identity. Stable `scene_id`, immutable revisions, separate sync preview, confidence categories, explicit ambiguous/removed decisions, downstream impact display, transactional apply, and immutable sync audit prevent silent reassociation.

An owner or compromised account may attempt to rewrite an issued call sheet, pack, approval, readiness certificate, file version, or archive manifest. Database guards, append-only APIs, pinned revision/version identifiers, content integrity, supersession relationships, idempotency, and audit make historical truth reproducible. Integrity values do not replace authorization; a caller must not choose the protected digest or pin set.

### Files, imports, exports, and storage

Attackers may upload oversized or deceptive content, smuggle active files, overwrite another key, claim a missing upload completed, exhaust the 1 GB/1,000-write profile, exploit eventual-consistency timing, enumerate private keys, or make a preview/download execute inline. Upload authorization binds operation, tenant, project, unique key, expected media/size, and expiry. The adapter rejects objects over 25 MiB, calculates and verifies SHA-256 and metadata before completion, enforces the planned total budget, and exposes no multipart path. Authorized Worker downloads, safe names/headers, restricted previews, D1 tombstones, and bounded retriable propagation handling mitigate exposure.

Export/print/ZIP generation may omit permission filters, use current rather than pinned versions, be nondeterministic, exceed the KV value ceiling, consume excessive memory, or include formula/path injection. Permission-aware manifests, deterministic ordering and serialization, immutable job input by reference, 25 MiB object bounds, manifest-backed multi-object exports, safe relative names, CSV escaping, and print privacy fixtures are required.

### Readiness and operational truth

A lower-privilege producer may try to override a restricted legal-hold/archive-integrity/security blocker, or missing data may be interpreted as passing. Evaluators distinguish pass/warning/blocker/unavailable, load all named sources, require evidence for manual checks, and preserve rule/profile versions. Overrides contain actor, permitted scope, reason, time, expiry and audit. Ready to Shoot issuance pins every result/source/decision and computes an integrity manifest; relevant later mutations record precise stale dependencies and require reissue.

The application tracks evidence rather than declaring legal validity, signature authenticity beyond available evidence, or provider delivery without proof.

### NAS and filesystem boundary

This boundary becomes active only after the later production NAS rollout provisions a host, mount, destination, and service credential. Cloud deployment alone must not claim NAS durability or verification.

A malicious or corrupt manifest may contain absolute paths, traversal, reserved names, collisions, case-equivalent paths, symlink/reparse escapes, inconsistent sizes/checksums, or a path outside the configured archive root. The agent canonicalizes safe relative paths, checks every parent without following unsafe links, rejects collisions and unsafe names, uses job-specific staging inside the validated destination, and never constructs a destructive target from an unresolved environment value.

Interrupted or duplicate downloads may create partial files or false completion. Range resume binds existing partial length and expected object/version, verification streams every size/checksum, durable flush is attempted when supported, and final promotion is atomic only after the whole manifest passes. Item and manifest acknowledgements are idempotent. No archive completion triggers cloud deletion. The agent polls outbound and exposes no NAS port or administration surface.

### Deployment, dependencies, logging, and denial of service

An operator can target the wrong Cloudflare account/database/domain or run a seed/bootstrap against production. Commands separate local/remote actions, require environment/resource checks, migrate before code only through the documented rollout decision, and attach only the approved subdomain. Production seeding excludes fictional demo data. Rollback and backup/restore are explicit.

Dependencies and build tools may introduce Worker incompatibility, supply-chain compromise, or leaked source/config. Lockfiles, minimal dependencies, official compatibility/types, reproducible CI, dependency review, and bundle/secret scanning reduce risk.

Internet actors can exhaust login KDF work, complex search/report/import, file transfer, public links, or durable jobs. Cloudflare and application rate limits, bounded schemas, pagination, size limits, job leases, stored-by-reference workflow payloads, streaming, cancellation/expiry, and per-scope quotas are required. Resource exhaustion that only affects an authorized user's own bounded local operation is lower severity than unauthenticated workspace-wide denial.

Structured logs may leak private fields, signed URLs, credentials, or object contents. Allowlisted logging with request/job/object identifiers, redacted errors, and tests keeps operational evidence without sensitive payloads.

### Out-of-scope attacker stories

- Compromise of Cloudflare itself, the NAS operating system, or an approved user's already-unlocked device is outside repository control, unless repository behavior materially expands the compromise or exposes stored credentials/data unnecessarily.
- A malicious owner can legitimately view most workspace data, but cannot legitimately rewrite immutable history, forge provider/archive evidence, bypass legal holds silently, or delete without the required controls.
- The legal sufficiency of agreements, permits, insurance, risk controls, and signatures is not determined by this product. Falsely claiming execution/evidence or leaking the records remains in scope.
- On-set and post-production features are not implemented. Shared authentication, storage, policy, and data-graph weaknesses remain in scope wherever reachable now.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

- Unauthenticated or cross-tenant compromise of the entire private workspace, production secrets, or both approved accounts.
- Arbitrary code execution in the Worker, build/deploy path, or NAS agent with production reach.
- A remotely reachable archive path escape or destructive flow capable of corrupting/deleting broad data outside the project and its recoverable copies.
- A reliable mechanism to replace production bootstrap/account identity or bypass all authorization without meaningful preconditions.

### High

- Producer-to-owner escalation enabling account provisioning, restricted overrides, retention deletion, or ownership control.
- Cross-project/public-recipient disclosure of finance, legal, casting-private, rates, emergency/health/accessibility/dietary, or private-recipient content.
- Stored script execution reaching an authenticated owner; arbitrary private KV read/write; legal-hold bypass; forged Ready to Shoot or archive verification; silent mutation of immutable issued artifacts.
- NAS write outside the configured project archive, even if broader system compromise requires environmental permissions.

### Medium

- CSRF for a meaningful recoverable project mutation; bounded exposure of non-public personal/production data; loss of recoverable work through stale-write or idempotency failure.
- Incorrect readiness/conflict/provider state that can mislead a production decision but is auditable and recoverable before photography.
- Persistent denial of a project through unbounded report/import/search or durable-job abuse available to a constrained caller.
- Sensitive action missing audit evidence when authorization and data integrity otherwise hold.

### Low

- Limited non-sensitive metadata exposure, minor same-role overreach with no sensitive fields, or bounded rate-limit weakness with negligible operational effect.
- Missing defense-in-depth header with no practical exploit under the actual rendering/CSP context.
- Audit, session-device labeling, or security-state UX defect that complicates investigation but does not enable unauthorized access or mutation.
- Availability/performance issue limited to an authorized user's own small operation and recoverable without data loss.

Severity rises with unauthenticated reach, cross-scope access, sensitive fields, owner authority, durable evidence corruption, low interaction, and poor recoverability. It falls when attacker control is absent in real deployment, the operation is explicitly local/operator-only, policy constrains impact, evidence makes the result immediately detectable, and recovery is deterministic. Those factors must be proven from code/configuration, not inferred from intended UI.

Repository: SinbodWayne-Productions
Version: working-tree-snapshot:milestone-0-in-progress
