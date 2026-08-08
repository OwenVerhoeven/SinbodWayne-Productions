# Sinbod Wayne Productions

Sinbod Wayne Productions is an internal, collaborative pre-production studio for Sinbod Wayne. It connects idea development, writing, scene breakdown, people and locations, visual and technical planning, finance, legal and safety, resources, schedules, call sheets, production packs, readiness, and private NAS archival. The product boundary ends when principal photography starts.

The complete local pre-production release is implemented and verified. Production Cloudflare provisioning and deployment remain externally blocked until an authorized account and real resource identifiers are supplied. See `IMPLEMENTATION_STATUS.md` for exact evidence and unexecuted remote steps.

## Architecture at a glance

- React and TypeScript web application served by a Cloudflare Worker
- Hono resource API with first-party authentication and server-side authorization
- Cloudflare D1 for relational state and private Workers KV for immutable file versions and bounded snapshots
- Cloudflare Workflows for durable export and archive jobs
- A narrowly scoped Durable Object channel for collaboration invalidation and presence
- Shared domain package for identifiers, calculations, sync, conflicts, readiness, and authorization
- Outbound-only NAS agent that leases archive work and verifies every transferred object

Read `docs/architecture.md`, `docs/data-model.md`, and the ADRs under `docs/adr/` before changing an invariant.

## Local setup

Prerequisites:

- A supported current Node.js release and npm
- Cloudflare Wrangler authenticated only if testing remote resources or deployment
- A browser supported by Playwright for end-to-end verification

For the fictional local development project:

```text
npm install
npm run seed:local
npm run dev
```

The development login is the isolated fictional `TestOwner` identity defined by the deterministic seed; it is never eligible for production provisioning. Use `npm run seed:test` to rebuild and verify a separate isolated fixture database.

To exercise the production-shaped bootstrap locally without demo data, use `npm run db:migrate:local` followed by `npm run bootstrap:local`. Bootstrap requests both credentials through hidden interactive input. Never pass production credentials through command arguments, committed environment files, fixtures, copied prompts, or shell history.

## Verification

Run the focused command while developing and the aggregate gate before milestone completion:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:migrations
npm run build
npm run test:e2e
npm run verify
```

The exact results are recorded in `IMPLEMENTATION_STATUS.md`. Browser verification includes desktop, tablet, phone, offline/conflict, and A4/Letter print states.

## Authentication and production accounts

The launch workspace has exactly two owner-approved active human identities: `SinbodWayne` (Workspace Owner and Producer) and `KyanWayne` (Producer). Usernames are case-sensitive. There is no public registration, invitation, guest, hidden administrator, or email-reset flow. The one-time bootstrap is idempotent: it creates missing approved identities, never resets an existing credential, and verifies the exact production account invariant.

The owner has workspace/security/retention authority. The producer can create and fully edit projects, including sensitive pre-production work, but cannot provision accounts, transfer ownership, permanently delete the workspace, perform owner-only retention actions, or override owner-only readiness categories.

The owner explicitly chose not to force first-login credential rotation. Password change and session revocation remain available, and changing a password invalidates other sessions.

The no-subscription Cloudflare profile keeps a random `AUTH_PEPPER` as a Worker secret (never a Git build variable) and records only salted, pepper-bound PBKDF2 verifier parameters in D1. Owner recovery uses `npm run recover-owner:remote`: it accepts the replacement through hidden input, creates a five-minute one-time challenge whose digest is stored in D1, derives the verifier inside the Worker, consumes the challenge atomically, revokes prior sessions, and audits the operation.

## Providers and manual fallbacks

Optional adapters may support email, SMS, weather, server-side PDF rendering, malware scanning, or external signatures. An absent adapter is displayed as `Not configured`, never as success.

Core workflows remain usable through secure links, downloads, browser printing/Save as PDF, manual weather, signed-file upload, message logs, manual confirmation, and validated external map links. Provider evidence is required before the UI claims delivery, view, signature, scan, or fetch success.

## Files, exports, and archive

Files use a logical record with immutable versions and a current-version pointer. Issued artifacts pin exact revisions and file versions. The complete-project export has a versioned JSON schema and checksum manifest.

The current deploy/test profile deliberately requires no payment card or subscription: private byte objects use Workers KV through a storage-neutral immutable adapter. It enforces a 25 MiB maximum per file, a 1 GB (`1000000000` bytes) total workspace storage budget, and the free-profile ceiling of 1,000 writes per day. Uploads are single-request only; multipart is not claimed. KV propagation is eventually consistent, so a just-written object may report a visible retriable state before it is treated as missing or corrupt.

R2 is not required for the current release. It remains an optional future capacity migration behind the same adapter if the owner later approves a paid or separately provisioned object-storage profile.

Archiving is three separate actions:

1. create an immutable cloud export and, when the later NAS integration is configured, request an archive job;
2. verify an outbound NAS-agent transfer by size and checksum;
3. optionally remove an eligible cloud copy through a separate owner-only retention action.

The NAS agent and protocol are implemented and locally verified, but production NAS credentials, host, mount, and destination are intentionally later operational prerequisites. Archive completion never deletes cloud data. See `docs/backup-and-nas.md`.

## Deployment

Production targets the unique `sinbod-wayne-productions` Worker and `productions.sinbodwayne.nl`. It must not modify Filmcraft Studio resources or its domain. Remote migration, bootstrap, custom-domain, smoke-test, and rollback procedures are in `docs/deployment.md`.

No deployment step should run until the operator has verified the Cloudflare account, environment, D1 and KV resource identifiers, backups, migration target, and authorization. The checked-in configuration contains separate all-zero placeholders for both D1 and KV. Missing cloud authorization does not block a complete local implementation, and production NAS setup is not part of the initial cloud deployment.

With explicit Cloudflare authorization, create or identify the two state resources from the repository root:

```text
cd apps/web
npx wrangler whoami
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler d1 create sinbod-wayne-productions-db
npx wrangler kv namespace create sinbod-wayne-productions-files --binding FILE_OBJECTS
cd ../..
```

Do not add `--update-config`. In `apps/web/wrangler.jsonc`, replace only `d1_databases[0].database_id` (`00000000-0000-0000-0000-000000000000`) and `kv_namespaces[0].id` (`00000000000000000000000000000000`) with the reviewed IDs, while preserving bindings `DB` and `FILE_OBJECTS`. Confirm no placeholder remains:

```text
rg -n '00000000-0000-0000-0000-000000000000|00000000000000000000000000000000' apps/web/wrangler.jsonc
```

No output is expected. Continue with the reviewed migration/bootstrap/deploy sequence in `docs/deployment.md`; this README does not claim that those remote actions have run.

For Cloudflare Git builds, use repository root `/`, build command `npx --yes npm@11 ci && npx --yes npm@11 run build --workspace @swp/domain && npx --yes npm@11 run build --workspace @swp/web`, deploy command `npx --yes npm@11 run deploy`, and environment variable `NODE_VERSION=24`. Add no application secret variables. The deploy lifecycle runs the checked-in preflight and rejects either remaining D1/KV placeholder; see `docs/deployment.md` for the full review gate.

## Security and privacy

Read `SECURITY.md` and `docs/threat-model.md`. The system is deny by default, uses private object storage, separates authentication contexts, audits high-impact actions, and treats finance, legal, casting-private, rates, dietary/medical/accessibility, emergency, and private-recipient data as sensitive. The application tracks legal and compliance requirements; it does not provide legal advice or claim certification.

## Operational ownership

The Sinbod Wayne workspace owner controls identities, recovery, retention, legal holds, destructive actions, owner-only readiness overrides, provider configuration, Cloudflare resources, and archive credentials. Producers own day-to-day project data and pre-production approvals within their policy scope. Operational runbooks and unresolved prerequisites must be updated during handoff.
