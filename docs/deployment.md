# Deployment and Operations

## Deployment status

Production deployment is **not verified or claimed**. The application is implemented for local/test operation, but Cloudflare account authorization and production resource identifiers have not been supplied. `IMPLEMENTATION_STATUS.md` is the authoritative record of executed validation and remaining external actions.

The current deploy/test profile is deliberately card- and subscription-free: D1 stores relational metadata and a private Workers KV namespace stores immutable byte objects behind the storage-neutral `PrivateObjectStore` adapter. The enforced profile is 25 MiB per file, 1 GB (`1000000000` bytes) total planned storage, and 1,000 writes per day. Uploads are single-request only; multipart is not implemented. KV propagation is eventually consistent, so an immediate post-write miss is an explicit retriable state.

R2 is not required for this deployment. It remains an optional future capacity migration behind the adapter. Production NAS provisioning is also a later optional operational rollout, not an initial cloud-deployment prerequisite.

## Fixed production identity

- Application/Worker: `sinbod-wayne-productions`
- D1: `sinbod-wayne-productions-db` or a documented collision-free equivalent
- Private Workers KV namespace: `sinbod-wayne-productions-files` or a documented collision-free equivalent
- KV binding: `FILE_OBJECTS`
- Archive Workflow: `sinbod-wayne-productions-archive`
- Collaboration Durable Object binding: `PROJECT_COLLABORATION`
- Production hostname: `productions.sinbodwayne.nl`

Do not reuse, rename, redeploy, bind, migrate, route, or delete Filmcraft Studio resources. Never attach `filmcraft.sinbodwayne.nl` or a wildcard route.

## Environments and bindings

Use explicit local/test and production environments. Production configuration contains only resource identifiers and non-secret settings. Secret values belong in Cloudflare secret bindings or an ignored local secret mechanism. The browser receives no D1, KV, provider, or archive credentials.

The checked-in `apps/web/wrangler.jsonc` expects:

- D1 database binding `DB`;
- private Workers KV namespace binding `FILE_OBJECTS`;
- archive/export Workflow binding `ARCHIVE_WORKFLOW`;
- project collaboration Durable Object binding `PROJECT_COLLABORATION`;
- rate-limit bindings for login and public routes;
- optional provider secrets/configuration.

Queues and R2 are not part of the current baseline. Add either only after an owner-approved design change with idempotency, migration, rollback, and updated security/backup evidence.

## Local development

From the repository root:

```text
npm install
npm run db:migrate:local
npm run bootstrap:local
npm run seed:test
npm run dev
```

The bootstrap command reads both approved users' credentials through hidden interactive prompts and displays only non-sensitive account/invariant results. The deterministic seed creates fictional test/development data in an isolated database; it never belongs in production bootstrap.

Before trusting a release candidate:

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

Use the command definitions in the current root `package.json`; update this document if script names change.

## One-time Cloudflare preparation

These commands require an explicitly authorized operator. Do not run them merely because Wrangler happens to be authenticated.

From the repository root, first inspect the target without mutating it:

```text
cd apps/web
npx wrangler whoami
npx wrangler d1 list
npx wrangler kv namespace list
```

Confirm the account, inventory Workers, D1, KV, Workflows, Durable Objects, and custom domains, and prove that the proposed names do not collide with Filmcraft resources.

If the dedicated resources do not already exist, create them from `apps/web`:

```text
npx wrangler d1 create sinbod-wayne-productions-db
npx wrangler kv namespace create sinbod-wayne-productions-files --binding FILE_OBJECTS
```

Do not add `--update-config`: the checked-in binding blocks and placeholder fields already exist, and automatic config mutation could create duplicate or unreviewed entries. Capture the returned IDs without putting credentials or unrelated account details in documentation or logs.

Edit only these fields in `apps/web/wrangler.jsonc`:

- replace `d1_databases[0].database_id` value `00000000-0000-0000-0000-000000000000` with the reviewed ID for `sinbod-wayne-productions-db`;
- replace `kv_namespaces[0].id` value `00000000000000000000000000000000` with the reviewed namespace ID for `sinbod-wayne-productions-files`;
- preserve binding names `DB` and `FILE_OBJECTS`, the D1 database name, and every unrelated setting.

Verify that neither placeholder remains:

```text
rg -n '00000000-0000-0000-0000-000000000000|00000000000000000000000000000000' apps/web/wrangler.jsonc
```

No output is expected. Re-run `npx wrangler d1 list` and `npx wrangler kv namespace list`, then compare the account and IDs character for character before any remote migration or deploy.

Next, review the configured Workflow, Durable Object, rate-limit bindings, observability, and the exact custom-domain route. Configure only required secrets through protected/interactive Cloudflare input; never pass secret values as command arguments or commit them. Attach only `productions.sinbodwayne.nl`, and only after the Worker candidate is healthy.

Required initial operator inputs, never invented:

- authorized Cloudflare account and `sinbodwayne.nl` zone;
- dedicated D1 database ID;
- dedicated Workers KV namespace ID;
- Workflow and Durable Object binding confirmation;
- approved provider configuration, if any;
- one-time protected bootstrap authority and hidden credential input;
- DNS/custom-domain authorization;
- D1/KV backup location and rollback owner.

No R2 bucket, NAS host, NAS mount, or NAS service credential is required for the initial deployment.

## Pre-deploy gate

All conditions are mandatory:

- reviewed change set with no unrelated user changes overwritten;
- `npm ci` or lockfile-equivalent reproducible install succeeds;
- a fresh `npm run verify` succeeds with exact evidence recorded;
- migration smoke tests pass from empty and supported previous schema;
- bundle/config secret scan is clean;
- security, authorization, accessibility, and print reviews have no unresolved critical/high issue;
- production account, Worker, D1 ID, KV ID, bindings, and domain are displayed and manually confirmed;
- current D1 export plus a checksum-addressed inventory/copy of required KV objects and rollback owner are recorded;
- the 25 MiB/object, 1 GB planned total, and 1,000-writes/day operating thresholds are accepted and monitored;
- optional providers are either tested or explicitly `Not configured` with a manual fallback;
- no fictional demo/test identity or project is part of production provisioning.

## Remote migration procedure

Use the checked-in root script so the environment and database name remain explicit:

```text
npm run db:migrate:remote
```

Before executing:

1. inspect the generated migration list and current remote applied list;
2. confirm the D1 database name and immutable ID match this application;
3. export/back up current production D1 and record the artifact location without credentials;
4. record an inventory and verified recovery copy of any current immutable KV objects;
5. run the migration dry checklist and representative restore/forward test locally;
6. announce/record the maintenance window if a migration can block writes;
7. apply once, then inspect applied migrations, foreign keys, indexes, immutable guards, and schema health;
8. stop on any mismatch—do not “repair” by deleting or resetting production data.

The exact underlying Wrangler invocation is defined in the root script/config after resource IDs exist. Do not improvise a direct remote command against an unverified database.

## Production account bootstrap

Bootstrap is a separate one-time operation after migrations and before general access:

```text
npm run bootstrap:remote
```

The command must:

- display and require confirmation of the non-secret target account/database identity;
- read both approved credentials through hidden interactive input, never arguments or ordinary environment variables;
- qualify the pinned KDF on the production Worker/runtime before provisioning;
- create only missing approved identities and never reset an existing credential;
- store only encoded verifier material;
- avoid printing input, derived material, session/share/service credentials, or sensitive response bodies;
- verify the exact two-active-account invariant and fail if an unexpected account exists;
- emit a redacted audit/operator receipt.

The owner accepted that the initial credentials remain usable until changed. First-login rotation is not forced. Password change and session revocation are verified during the smoke test.

## Deploy

The intended reviewed root command is:

```text
npm run deploy
```

Before approval, capture the Worker name, account, routes/custom domains, D1/KV/Workflow/DO bindings, compatibility date, migration state, and build digest. After upload, first test the generated Worker hostname or another explicitly safe candidate route. Attach the production subdomain only when the candidate is healthy.

Do not configure a wildcard route and do not change unrelated DNS records. This document does not assert that any remote command has been run.

### Cloudflare Git build settings

For a Cloudflare Git-connected Worker build, enter these exact dashboard values:

| Field                | Value                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Root directory       | `/`                                                                                                                            |
| Build command        | `npx --yes npm@11 ci && npx --yes npm@11 run build --workspace @swp/domain && npx --yes npm@11 run build --workspace @swp/web` |
| Deploy command       | `npx --yes npm@11 run deploy`                                                                                                  |
| Environment variable | `NODE_VERSION` = `24`                                                                                                          |

Do not add application secrets or bootstrap credentials to the Git build environment. This deployment profile needs no app secret variables; Cloudflare's Git integration supplies its own platform deployment authority. Optional provider and later NAS credentials remain `Not configured` until separately approved and provisioned through their protected runtime mechanisms.

Before connecting the production branch, commit reviewed non-secret D1 and KV IDs in `apps/web/wrangler.jsonc`. The deploy command invokes the `@swp/web` `predeploy` lifecycle, which runs `apps/web/scripts/deploy-preflight.ts` and fails if either all-zero D1/KV placeholder remains. The Git build must not bypass that preflight, synthesize IDs, or use a Filmcraft resource.

## Initial production smoke test

Record timestamps, request IDs, and redacted evidence for:

1. HTTPS/security headers and branded login.
2. Invalid login remains generic; each approved identity can authenticate.
3. Authenticated shell and project permission boundary.
4. D1 read/write plus optimistic conflict.
5. Private KV upload, completion/integrity verification, authorized download, and immutable version pin.
6. A just-written object either reads successfully or exposes only the documented retriable propagation state.
7. A narrow recipient link shows only its recipient variant and confirms idempotently.
8. A4 and Letter print routes.
9. Readiness evaluation and immutable issue on controlled data.
10. Export/archive request reaches its durable cloud state without claiming NAS transfer or verification.
11. Owner session listing/revocation and producer denial for an owner-only action.

Never use real sensitive project data to test a provider or public link unnecessarily. Without a provisioned NAS agent, the UI must remain honest (`Not configured`, `Requested`, or another evidence-backed non-verified state) and must never show NAS `Verified`.

## Later optional NAS rollout

The NAS agent and protocol are implemented and locally tested, but production NAS provisioning is separate from initial cloud deployment. When the owner elects to enable it:

1. select a maintained host with the private NAS mounted;
2. validate an explicit destination below the approved archive root;
3. provision a least-privilege service credential outside the repository;
4. configure outbound HTTPS only, with no inbound port forwarding or NAS admin exposure;
5. run controlled lease, interruption/resume, checksum-failure, and successful verification exercises;
6. record host ownership, destination, credential rotation, monitoring, and recovery evidence without secret values.

Only then may production archive jobs truthfully reach NAS `Verified`. Archive, Verify, and Remove cloud copy remain three separate actions.

## Rollback

Rollback has separate code and data decisions:

- **Worker code/config:** identify the last known-good deployment, validate its binding/schema compatibility, restore/promote it through the supported Cloudflare mechanism, then smoke test.
- **Database:** prefer a forward corrective migration. Restore from backup only with owner approval, a documented recovery point, impact review, and preservation of newer immutable/file/archive evidence for reconciliation.
- **Workers KV:** never bulk-delete as rollback. Current file pointers may move to a prior immutable version; issued pins stay unchanged. D1 authorization and retention tombstones block application access immediately, while a KV physical deletion or replacement may propagate eventually and cannot be treated as an instantaneous global state change.
- **Domain:** detach only the production hostname from the failing deployment or return it to the known-good application. Never redirect it to Filmcraft.
- **Workflow/DO:** leave retry, lease, and idempotency records intact for reconciliation; do not clear state blindly.

After rollback, record the incident, affected revisions/jobs, recovered evidence, any stale readiness/issued artifacts, and a new deployment gate. Do not conceal partial archive or provider state.

## Future optional R2 migration

If capacity or transfer requirements outgrow the current KV profile, an owner may approve R2 as a storage-adapter backend. The migration is not a prerequisite or automatic upgrade. It must preserve immutable keys or a verified mapping, D1 version pins, SHA-256 evidence, authorization, legal holds, retention tombstones, export manifests, rollback evidence, and NAS protocol compatibility. Re-run security, backup/restore, browser, and archive tests before switching bindings.

## Secret and credential rotation

- User credential change increments authentication authority and revokes other sessions.
- Session/share/service credentials are independently revocable.
- Provider and later NAS service credentials rotate through overlapping least-privilege credentials where supported; revoke the old one only after the replacement proves access.
- Cloudflare secrets are replaced through protected input and never echoed into documentation or CI output.
- Suspected link leakage triggers link revocation and a new issued link/variant where policy allows; prior immutable issue history stays intact.

## Initial-deployment handoff checklist

- [ ] Production account and resources verified as unique
- [ ] D1 and KV placeholder IDs replaced and independently rechecked
- [ ] Fresh aggregate verification evidence recorded
- [ ] Remote migration evidence recorded
- [ ] Exact approved-account invariant verified
- [ ] Deploy URL and build digest recorded
- [ ] Only the production subdomain attached
- [ ] Initial smoke journey evidence recorded
- [ ] D1/KV backup and rollback owner/location recorded
- [ ] KV capacity/write monitoring and user-facing limits recorded
- [ ] Provider configuration/manual fallbacks recorded
- [ ] Known limitations and unexecuted commands updated in `IMPLEMENTATION_STATUS.md`

NAS host, mount, destination, service credential owner, and rotation evidence belong to the separate later NAS-rollout checklist; they do not block the initial cloud deployment.
