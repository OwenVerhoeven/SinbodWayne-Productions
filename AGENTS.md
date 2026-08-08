# Engineering Guide

This repository contains **Sinbod Wayne Productions**, an internal pre-production workspace that ends at an immutable Ready to Shoot issue. These instructions apply to the whole repository. A more specific `AGENTS.md` may narrow conventions for a subtree, but it may not weaken the security invariants here.

## Product boundary

- Implement the complete path from idea capture through verified Ready to Shoot, including development, writing, breakdown, visual planning, production planning, scheduling, call sheets, production packs, exports, and NAS archival.
- Do not add production-day execution or post-production workflow. Lifecycle labels may include later phases, but they are not license to build placeholder modules.
- Required features must persist real data and enforce policy at the server. No decorative actions, fake delivery/signature/scan/archive claims, hard-coded dashboard counts, or “coming soon” routes.
- When a provider is absent, show `Not configured` and keep the documented manual fallback useful.

## Repository layout

```text
apps/web/        React application, Worker API, Cloudflare bindings, migrations, tests
apps/nas-agent/  Outbound-only archive pull agent
packages/domain/ Schemas, identifiers, calculations, invariants, pure services
packages/ui/     Shared accessible UI primitives
docs/            Architecture, operations, threat model, and ADRs
```

## Required commands

Use the root npm scripts. On Windows environments that block PowerShell npm shims, invoke `npm.cmd` and `npx.cmd`.

- `npm run dev` — local Worker and web development
- `npm run db:migrate:local` — apply local D1 migrations
- `npm run bootstrap:local` — hidden-input local account bootstrap
- `npm run seed:test` — deterministic fictional test data only
- `npm run format` / `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:migrations`
- `npm run test:e2e`
- `npm run build`
- `npm run verify` — aggregate local verification
- Remote migration, bootstrap, and deploy commands are documented in `docs/deployment.md`; never infer a production environment.

If a script is not yet available during initial construction, add it before claiming the associated milestone complete.

## Engineering conventions

- TypeScript is strict. Validate every HTTP, storage, import, and provider boundary with shared schemas.
- Prefer Web Platform APIs and Worker-compatible dependencies. Confirm compatibility before adding Node-only code to the Worker.
- Use opaque, time-sortable identifiers. Human numbers, labels, names, and ranks are mutable display fields.
- `scene_id` is the canonical identity across writing, breakdown, shots, schedules, sides, call sheets, packs, and readiness.
- Store UTC instants; render in the project or location timezone. Store page counts in eighths, money in integer minor units, and timecode as integer frames plus a rational frame rate.
- Mutable records carry an optimistic-concurrency version. A stale write returns a recoverable conflict and never silently overwrites.
- Revisions, issued artifacts, decisions, audit events, and file versions are immutable. Corrections supersede.
- Use association tables where ownership and referential integrity matter. Bounded JSON is for deliberate snapshots or editor fragments, not a live-project dumping ground.
- Keep binary content in private R2. D1 stores metadata, relations, integrity values, and version pins.
- Use parameterized queries. List endpoints use cursor pagination and avoid N+1 access.
- Retry-sensitive operations require an idempotency key and an idempotent implementation.

## Security rules

- Never put production credentials, password-derived material, session credentials, share secrets, service credentials, signed URLs, or provider secrets in the repository, command arguments, logs, screenshots, fixtures, or client bundles.
- The production account bootstrap is interactive, idempotent, and fail closed. It creates only the two owner-approved identities and never resets an existing credential on deploy.
- Production must never fall back to a development identity. Test identities live only in isolated test databases.
- Enforce authentication, workspace/project membership, object ownership, action permission, and sensitive-field access in the Worker. A hidden UI control is not authorization.
- Cookie-authenticated mutations require same-origin and CSRF defenses. Public-share, recipient, service-agent, and provider-webhook routes use separate authentication contexts.
- Store only hashes of session, share, service, and one-time bootstrap credentials. Compare secrets in a timing-safe manner where supported.
- R2 is private. Downloads are short-lived and scoped, or streamed through an authorized Worker route with safe headers.
- Sanitize rich text and annotation inputs. Validate upload type, size, signature, destination, and completion evidence.
- Audit permission changes, sensitive exports, links, approvals, issues, archive actions, retention actions, and destructive operations.
- Do not weaken tests to accommodate a structural failure. Consult `SECURITY.md` and `docs/threat-model.md` for review criteria.

## UX, accessibility, and print

- The primary experience is a dark, dense production workspace in the Filmcraft family, implemented from documented tokens without copying proprietary trade dress.
- Target WCAG 2.2 AA for core journeys. Use semantic controls, complete labels and errors, predictable focus, keyboard access, and non-drag alternatives.
- Color is never the sole status signal. Touch targets remain usable and core phone views have no horizontal traps.
- Prefer dense lists and tables with selectable columns over card grids. Keep project phase and readiness visible.
- Every issued document uses a deterministic print route. Test A4 and Letter, long content, images, page breaks, and recipient privacy.
- Respect `prefers-reduced-motion`; animation is functional and restrained.

## Tests and done behavior

- Add pure tests for calculations and invariants; Worker/D1 integration tests for persistence, authorization, and idempotency; Playwright for critical journeys and print/mobile behavior.
- Test success and failure states: loading, empty, populated, error, conflict, archived, denied, offline, not configured, and print.
- After each milestone run formatting, lint, typecheck, relevant unit/integration/browser tests, and production build. Record exact evidence in `IMPLEMENTATION_STATUS.md`.
- Update `PLANS.md`, `TRACEABILITY_MATRIX.md`, ADRs, and operational docs when implementation changes their assumptions.
- A checkbox means verified, not merely scaffolded. A traceability row is `Implemented` only after schema/API/UI/tests and any required export are present.
- Review changed code for tenant isolation, authorization, data loss, revision identity, snapshot integrity, finance arithmetic, privacy, accessibility, print, deployment safety, and recovery before handoff.
- Preserve unrelated user changes. Do not push, alter DNS, delete cloud resources, run remote migrations, or bootstrap production without explicit authority and an environment check.

## Sensitive bootstrap decision

The owner explicitly accepted that the initial bootstrap credentials remain usable until changed; first-login rotation is not forced. Do not record the credential values or metadata that could help infer them. Compensating controls are interactive provisioning, encrypted transport, server-side hashing, rate limiting, audit, password change, and session revocation.
