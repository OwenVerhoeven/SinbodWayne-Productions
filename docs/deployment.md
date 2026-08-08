# Deployment and Operations

## Deployment status

Production deployment is **not yet verified or claimed**. The local release is complete and verified independently of Cloudflare credentials. `IMPLEMENTATION_STATUS.md` records the authoritative execution evidence and external blocker.

## Fixed production identity

- Application/Worker: `sinbod-wayne-productions`
- D1: `sinbod-wayne-productions-db` or a documented collision-free equivalent
- Private R2: `sinbod-wayne-productions-files` or a documented collision-free equivalent
- Archive Workflow: unique to this application
- Collaboration Durable Object: unique class/binding for this application
- Production hostname: `productions.sinbodwayne.nl`

Do not reuse, rename, redeploy, bind, migrate, route, or delete Filmcraft Studio resources. Never attach `filmcraft.sinbodwayne.nl` or a wildcard route.

## Environments

Use explicit local/test and production environments. Production configuration contains only resource identifiers and non-secret settings. Secret values belong in Cloudflare secret bindings or an ignored local secret mechanism. The browser receives no D1/R2/provider/archive credentials.

Expected bindings:

- D1 relational database
- private R2 file/export bucket
- archive/export Workflow
- project collaboration Durable Object
- optional rate-limit binding(s)
- optional provider secret/config bindings

Queues are not part of the baseline. Add one only if an implemented fan-out workload justifies it and has an idempotent consumer.

The checked-in Wrangler configuration must include a current tested compatibility date, Static Assets SPA routing, observability with redaction-aware logging, environment-separated bindings, and no secret values. Generated resource IDs are reviewed before commit and must point only to Sinbod Wayne Productions.

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

Before trusting local state:

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

Use the command definitions in the current root `package.json`; documentation must be updated if script names change.

## One-time Cloudflare preparation

These steps require an explicitly authorized operator. Do not run them merely because Wrangler is authenticated.

1. Confirm the active Cloudflare identity/account and zone.
2. Inventory existing Workers, D1 databases, R2 buckets, Workflows, Durable Objects and custom domains.
3. Prove the proposed names and bindings are unique and do not reference any Filmcraft resource.
4. Create or identify the dedicated D1 database and record its ID in the production environment config.
5. Create or identify the dedicated private R2 bucket. Confirm there is no public access/listing.
6. Configure the archive Workflow and collaboration Durable Object bindings used by the deployed build.
7. Configure only required secrets through hidden/interactive Cloudflare secret input. Never pass values as command arguments or commit them.
8. Configure observability and retention appropriate to redacted logs.
9. Review the exact custom-domain change; attach only `productions.sinbodwayne.nl` after the application is healthy.

Required operator inputs, never invented:

- authorized Cloudflare account/zone;
- dedicated D1 resource identifier;
- dedicated R2 bucket confirmation;
- Workflow/Durable Object binding confirmation;
- approved provider configuration, if any;
- one-time protected bootstrap authority and hidden credential input;
- DNS/custom-domain authorization;
- backup location and rollback owner;
- NAS service credential provisioning and validated destination operator.

## Pre-deploy gate

All conditions are mandatory:

- clean, reviewed change set with no unrelated user changes overwritten;
- `npm ci` or lockfile-equivalent reproducible install succeeds;
- `npm run verify` succeeds with exact evidence recorded;
- migration smoke tests pass from empty and supported previous schema;
- bundle/config secret scan is clean;
- security, authorization, accessibility and print reviews have no unresolved critical/high issue;
- production resource names/IDs and account are displayed and manually confirmed;
- current D1/R2 backup/export and rollback owner are recorded;
- optional providers are either tested or explicitly `Not configured` with manual fallback;
- no fictional demo/test identity or project is part of production provisioning.

## Remote migration procedure

Use the checked-in root script so the environment and database name are explicit. The intended command interface is:

```text
npm run db:migrate:remote
```

Before executing:

1. inspect the generated migration list and current remote applied list;
2. confirm the D1 database name and immutable resource ID match this application;
3. export/backup the current production database and record the artifact location without credentials;
4. run the migration dry checklist and representative restore/forward test locally;
5. announce/record the maintenance window if a migration can block writes;
6. apply once, then inspect the applied list, foreign keys, required indexes, immutable guards and schema health;
7. stop on any mismatch—do not “repair” by deleting or resetting production data.

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
- avoid printing input, derived material, session/share/service credentials or sensitive response bodies;
- verify the exact two-active-account invariant and fail if an unexpected account exists;
- emit a redacted audit/operator receipt.

The owner accepted that these credentials remain usable until changed. First-login rotation is not forced. Password change and session revocation are verified during the smoke test.

## Deploy

The intended reviewed root command is:

```text
npm run deploy
```

Before approval, capture the Worker name, account, routes/custom domains, D1/R2/Workflow/DO bindings, compatibility date, migration state and build digest. After upload, first test the generated Worker hostname or safe preview route. Attach the production subdomain only when the candidate is healthy.

Do not configure a wildcard route and do not change unrelated DNS records.

## Production smoke test

Record timestamps, request IDs and redacted evidence for:

1. HTTPS/security headers and branded login.
2. Invalid login remains generic; each approved identity can authenticate.
3. Authenticated shell and project permission boundary.
4. D1 read/write plus optimistic conflict.
5. Private R2 upload, verified completion, authorized download and version pin.
6. Narrow recipient link shows only its recipient variant and can confirm idempotently.
7. A4 and Letter print route.
8. Readiness evaluation and immutable issue on controlled data.
9. Export/archive request reaches the durable Requested state without claiming NAS verification.
10. Owner session listing/revocation and producer denial for an owner-only action.

Never use real sensitive project data to test a provider or public link unnecessarily.

## Rollback

Rollback has separate code and data decisions:

- **Worker code/config:** identify the last known-good deployment, validate its binding/schema compatibility, restore/promote it through the supported Cloudflare mechanism, then smoke test.
- **Database:** prefer a forward corrective migration. Restore from backup only with owner approval, a documented recovery point, impact review and preservation of newer immutable/file/archive evidence for reconciliation.
- **R2:** never bulk-delete as rollback. Current file pointers can move to a prior immutable version; issued pins stay unchanged.
- **Domain:** detach only the production hostname from the failing deployment or return it to the known-good application. Never redirect it to Filmcraft.
- **Workflow/DO:** leave retry/lease/idempotency records intact for reconciliation; do not clear state blindly.

After rollback, record the incident, affected revisions/jobs, recovered evidence, any stale readiness/issued artifacts, and a new deployment gate. Do not conceal partial archive or provider state.

## Secret and credential rotation

- User credential change increments authentication authority and revokes other sessions.
- Session/share/service credentials are independently revocable.
- Provider and NAS service credentials rotate through overlapping least-privilege credentials where supported; revoke the old one after the new agent/provider proves access.
- Cloudflare secrets are replaced through protected input and never echoed into documentation or CI output.
- Suspected link leakage triggers link revocation and a new issued link/variant where policy allows; prior immutable issue history stays intact.

## Handoff checklist

- [ ] Production resources and IDs verified as unique
- [ ] Remote migration evidence recorded
- [ ] Exact approved-account invariant verified
- [ ] Deploy URL and build digest recorded
- [ ] Only production subdomain attached
- [ ] Smoke journey evidence recorded
- [ ] Backup and rollback owner/location recorded
- [ ] Provider configuration/manual fallbacks recorded
- [ ] NAS agent host, destination, service credential owner and rotation date recorded without values
- [ ] Known limitations and unexecuted commands updated in `IMPLEMENTATION_STATUS.md`
