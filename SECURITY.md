# Security Policy

## System and scope

Sinbod Wayne Productions is a private pre-production workspace deployed as a Cloudflare Worker application with relational metadata in D1, private immutable objects in Workers KV, durable export/archive orchestration, a limited collaboration channel, and an outbound-only NAS archive agent whose production connection is a later optional operational step.

Repository-wide security review covers:

- `apps/web`: browser application, authenticated API, narrow public recipient/share routes, provider webhooks, storage/workflow bindings, bootstrap/recovery entry points, and print/export surfaces;
- `apps/nas-agent`: outbound lease, download, verification, staging, and archive acknowledgement;
- `packages/domain`: identity, authorization, calculations, synchronization, conflict, readiness, integrity, and path invariants;
- `packages/ui`: rendering, input, rich content, file interaction, accessibility, and privacy-preserving states;
- migrations, tests, build/deploy configuration, scripts, and operational documentation where they can change a production control.

Production has one Sinbod Wayne workspace and exactly three approved active identities: one owner, one editing producer, and one view-only guest. The application contains sensitive finance, legal, casting, rates, health/accessibility/dietary, emergency, private-recipient, contact, and production-security data. It also creates issued artifacts and archive evidence whose integrity matters operationally.

## Threat model and trust boundaries

Trusted actors are the approved owner, producer, and viewer within their server-enforced roles, an authorized deployment/bootstrap operator, configured provider services authenticated by their documented mechanism, and a least-privilege NAS service identity. The viewer is not trusted with any mutation capability. Every browser, URL parameter, request body/header, uploaded file, import, rich-text fragment, public link, recipient confirmation, provider callback, service-agent request, and retry is attacker controlled until validated.

Important boundaries are:

- anonymous internet to login, narrow public links, and provider endpoints;
- authenticated browser to Worker API across cookie/CSRF and object authorization;
- Worker to D1/Workers KV/Durable Objects/Workflows and provider adapters;
- public/share/recipient contexts to the authenticated project context;
- one workspace/project/object/field scope to another;
- mutable drafts to immutable revisions, issues, approvals, file versions, exports, and archive receipts;
- cloud export storage to the outbound NAS agent and the mounted archive destination;
- developer/test tooling and fixtures to production configuration and data.

Assumptions and compensating boundaries are detailed in `docs/threat-model.md`.

## Security invariants

These properties must hold regardless of UI state:

1. Production exposes exactly the approved active identities and never falls back to a test/development principal.
2. Authentication, membership, module/object/action permission, and sensitive-field policy are enforced before every protected read or mutation.
3. Public, recipient, candidate, service, and provider contexts cannot inherit authenticated-app scope or enumerate adjacent objects/recipients.
4. Password-derived material and session/share/service/bootstrap credentials are never stored or logged in plaintext. Production secrets do not enter source, migrations, fixtures, documentation, client bundles, command arguments, or analytics.
5. Cookie-authenticated mutation requires a valid session plus same-origin and CSRF controls. Session rotation/revocation and credential changes invalidate access as documented.
6. Tenant/project ownership is validated centrally for direct identifiers and common typed object references. A caller cannot supply ownership columns that bypass the resolved parent.
7. Parameterized SQL and boundary schemas constrain every request/import/provider payload. Rich text and annotations are sanitized before rendering.
8. Workers KV is private behind the Worker. Upload/download authority is operation-, workspace-, project-, key-, type-, size-, and expiry-scoped. The immutable adapter calculates and validates size, MIME evidence, and SHA-256 before a version becomes available; namespace credentials never reach the browser.
9. Mutable records use optimistic concurrency. A stale write never silently overwrites either user's work.
10. Script revisions, scene sync records, approval decisions, issued artifacts, file versions, readiness issues, export snapshots, archive manifests, and audit events are append-only. Corrections supersede.
11. `scene_id`, not scene number or slugline, anchors downstream production work. Ambiguous mappings and removed scenes with linked work require explicit decisions and transactional apply.
12. Finance uses integer minor units; page counts use integer eighths; duration/timecode use integers plus rational rates. Security- or readiness-relevant calculations are deterministic.
13. Retry-sensitive operations are idempotent. Duplicate workflow, webhook, provider, issue, confirmation, export, archive, and acknowledgement delivery cannot create contradictory truth.
14. No UI or API claims delivery, view, signature, scan, weather fetch, export, archive verification, or deletion without corresponding evidence.
15. Readiness cannot be green from missing/unloaded data. Overrides are actor-, scope-, reason-, expiry-, and policy-bound, and Ready to Shoot issues pin all evaluated sources.
16. Legal hold, retention, verified-archive, authority, and typed-confirmation checks guard destructive actions. No automated process removes the only known good copy.
17. The NAS agent validates a configured destination, rejects traversal and link/reparse escape, stages per job, verifies size and checksum, promotes atomically where supported, and never requires inbound NAS exposure.
18. Logs and error responses are structured and redacted; they do not expose SQL, stacks, credentials, signed URLs, cross-tenant data, or sensitive private fields.

## Reportable findings and severity context

A finding is reportable when a realistic untrusted or lower-privilege actor can violate an invariant, disclose protected data, alter issued production truth, forge evidence, cross a workspace/project/recipient boundary, execute unauthorized owner action, corrupt/delete the only known good copy, or create persistent service compromise.

- **Critical:** broad unauthenticated access to the private workspace or production secrets; arbitrary code execution in the Worker/archive agent; reliable cross-tenant control; silent destruction/corruption of primary and archived data; or owner-level account takeover without meaningful preconditions.
- **High:** cross-project or recipient-private disclosure; producer escalation to account/retention/owner-only authority; forged Ready to Shoot/archive verification; bypass of legal hold; stored XSS reaching privileged users; upload/download authorization bypass; or archive path escape with meaningful filesystem impact.
- **Medium:** CSRF on a meaningful but recoverable mutation, bounded sensitive-data exposure, persistent denial of a project workflow, unreliable idempotency/optimistic conflict that can corrupt recoverable work, or misleading provider evidence with operational impact.
- **Low:** limited metadata leakage, non-sensitive same-role authorization inconsistency, defense-in-depth header weakness without a demonstrated exploit chain, bounded rate-limit bypass, or security-relevant audit/usability gaps with low direct impact.

Severity depends on real reachability, role, data sensitivity, scope, durability, evidence integrity, recoverability, and required user interaction. Tests show intent but are not proof that a control is effective.

## Out of scope, exclusions, and accepted risk

- Production-day execution and post-production workflows are outside this release. A vulnerability in a real shared primitive used by the current product remains in scope even if discovered through a future-facing schema value.
- Third-party provider infrastructure is outside repository control, but credential handling, webhook verification, adapter behavior, least privilege, response validation, and truthful state in this repository remain in scope.
- The security of the NAS operating system, mount, network, and administrator account is an operator responsibility; the agent's path handling, credential use, transfer verification, logging, and acknowledgement are in scope.
- Social engineering, physical access to an already unlocked approved device, and malicious browser extensions are not product-controlled. Session/device controls and minimization remain relevant mitigations.
- The product tracks requirements and evidence but does not make legal determinations or claim compliance certification. A misleading implementation claim is still reportable.

Accepted risk, explicitly confirmed by the owner: bootstrap credentials are usable until changed and the application does not force rotation on first login. This is not an exclusion for credential exposure, weak storage, logging, login brute-force weaknesses, unsafe recovery, or session failures. Revisit the acceptance if exposure, team membership, or perimeter assumptions change.

## Known limitations and compensating controls

- During initial implementation, features and tests are incomplete. `IMPLEMENTATION_STATUS.md` is authoritative; planned controls must not be treated as present.
- Cloudflare account bindings, remote migrations, production bootstrap, provider credentials, DNS, deployment, and smoke tests are unverified until explicitly recorded.
- Optional email, SMS, weather, server-PDF, malware-scan, and signature providers may be absent. Manual fallbacks and a visible `Not configured` state are mandatory compensating behavior.
- Character-level CRDT collaboration is not claimed. D1 optimistic concurrency, draft preservation, invalidation/polling, and explicit conflict review are the required controls.
- Browser print/Save as PDF is the mandatory deterministic document path when server PDF rendering is absent.
- FTS is a derived index; backup/restore procedures must rebuild and verify it rather than treating it as canonical data.
- The current no-subscription Workers KV profile is intentionally bounded to 25 MiB per object, 1 GB (`1000000000` bytes) total planned storage, and 1,000 writes per day, with no multipart uploads. Capacity rejection must be explicit and must occur before bytes or metadata are committed.
- Workers KV propagation is eventually consistent. Recent writes may produce a bounded retriable state; authorization, retention tombstones, immutable D1 pins, and checksum verification remain authoritative while propagation settles.
- R2 is an optional future storage-adapter migration, not a current binding or security dependency. A future migration requires a new review of consistency, credentials, capacity, backups, and cutover evidence.
- The NAS agent is implemented and tested locally, but no production NAS credential, host, mount, or destination is claimed until a later operator provisions and verifies them.

Report security concerns privately to the Sinbod Wayne workspace owner. Do not include production data, credentials, signed links, or unnecessary personal information in a report or proof of concept.
