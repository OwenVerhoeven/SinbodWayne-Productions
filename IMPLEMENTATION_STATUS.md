# Implementation Status

Last updated: 2026-08-08

## Current milestone

**Milestones 0-10 and the local portion of Milestone 11 are complete. Production deployment is externally blocked.**

The local release implements the complete pre-production boundary through immutable Ready to Shoot, complete-project export and outbound-only NAS verification. Production-day execution and post-production remain the only intentional future scopes.

Cloudflare production work was not attempted: `wrangler whoami` reports that no account is authenticated, and `apps/web/wrangler.jsonc` intentionally retains the all-zero D1 placeholder until an authorized operator creates or identifies the dedicated database. No production account, remote migration, resource, DNS record or deployment is claimed.

## Completed release

- Cloudflare-native TypeScript workspace with React/Vite, Hono Worker API, normalized D1 migrations, private R2 file versions, Workflow archive orchestration, Durable Object invalidation/presence and an installable PWA shell.
- First-party login, interactive idempotent two-account bootstrap, hashed/revocable sessions and share/service tokens, role and sensitive-field policies, CSRF/origin controls, audit, collaboration, conflicts and scoped offline drafts.
- Persisted project graph for development, documents/templates, screenplay and AV writing, canonical scene sync, breakdown, people/casting, locations, visual plans, finance, legal/safety, equipment/logistics, tasks/approvals/calendar, schedules/shoot days, call sheets, production packs and exports.
- Configurable project/shoot-day readiness with 19 source-backed categories, explicit audited overrides, immutable issue evidence, manifest hashes and precise stale detection.
- Outbound-only NAS agent with lease/resume, path and link escape rejection, space checks, SHA-256 verification, atomic promotion, idempotent acknowledgement and no cloud deletion.
- Fictional six-scene fixture using real migrations, relational records and R2 objects. The fixture contains two isolated test identities and never runs during production bootstrap.
- Filmcraft-family graphite/cyan/amber design system, grouped navigation, keyboard and non-drag controls, responsive desktop/tablet/phone layouts and deterministic A4/Letter print routes. Approved references and the final comparison are recorded in `docs/design-fidelity.md`.

## Validation evidence

| Check                       | Command                                                  | Result                                                            | Evidence                                                                                                                                                |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate release gate      | `npm run verify`                                         | **Pass** in 421.8 s                                               | 2026-08-08 local run                                                                                                                                    |
| Formatting                  | `npm run format:check`                                   | Pass                                                              | Included in aggregate                                                                                                                                   |
| Lint                        | `npm run lint`                                           | Pass                                                              | Included in aggregate                                                                                                                                   |
| TypeScript                  | `npm run typecheck`                                      | Pass for NAS, web, domain and UI workspaces                       | Included in aggregate                                                                                                                                   |
| Unit/domain/NAS             | `npm run test:unit`                                      | 102 passed: NAS 13, web 47, domain 42; UI has no standalone tests | Included in aggregate                                                                                                                                   |
| Worker/D1 integration       | `npm run test:integration`                               | 5 passed across 4 Worker suites                                   | Included in aggregate                                                                                                                                   |
| Migration/schema smoke      | `npm run test:migrations`                                | 4 passed across clean-schema and external-approval suites         | Included in aggregate                                                                                                                                   |
| Production builds           | `npm run build`                                          | Pass for all workspaces                                           | Worker 900.74 kB; client JS 804.24 kB (232.53 kB gzip)                                                                                                  |
| Browser/accessibility/print | `npm run test:e2e`                                       | 3 passed: desktop, tablet and phone                               | 12 authenticated pages per viewport, 19/19 readiness, immutable issue, archive evidence, serious/critical Axe scan, print-shell and overflow assertions |
| Fresh deterministic seed    | `npm run seed:test`                                      | Pass                                                              | 1 project, 6 scenes, 38 readiness result/source pins, 2 Ready issues and verified archive evidence                                                      |
| Dependency audit            | `npm audit`                                              | 0 critical, high or moderate; 1 low development-only advisory     | Nested `tsx`/`esbuild` Windows dev-server advisory; production bundle unaffected                                                                        |
| Supplied-secret scan        | targeted repository scan excluding generated/local state | Pass                                                              | No supplied password fragments present in tracked source/docs/config/tests                                                                              |
| Cloudflare identity         | `npx wrangler whoami`                                    | External blocker                                                  | Wrangler reports unauthenticated                                                                                                                        |

The build emits a non-failing large-client-chunk warning. It is a known performance optimization opportunity, not a correctness, security or deployment-integrity failure.

## External deployment prerequisites and exact next action

An authorized operator must:

1. run `wrangler login` and verify the intended Cloudflare account and `sinbodwayne.nl` zone;
2. inventory resources and create/identify only `sinbod-wayne-productions`, `sinbod-wayne-productions-db`, `sinbod-wayne-productions-files`, the archive Workflow and collaboration Durable Object;
3. replace only the all-zero D1 ID with the reviewed dedicated ID and confirm the R2 bucket is private;
4. run `npm run verify`, back up/record the target state, then run `npm run db:migrate:remote`;
5. run `npm run bootstrap:remote` and type the two owner-supplied passwords only into its hidden prompts;
6. run `npm run deploy`, smoke-test the Worker/resources, and attach only `productions.sinbodwayne.nl` after the candidate is healthy;
7. provision the least-privilege NAS service credential and validated destination outside the repository.

The complete checklist, smoke journey and rollback procedure are in `docs/deployment.md`. Optional email, SMS, weather, scanning, external-signature and server-PDF providers remain `Not configured`; secure links, manual evidence, uploads and browser print/Save as PDF are the verified fallbacks.

## Known limitations

- Production is not deployed or bootstrapped because Cloudflare authentication and resource identifiers are unavailable.
- The remaining npm advisory is low severity and limited to the local TypeScript runner's nested development server dependency.
- The client entry chunk is larger than the preferred 500 kB warning threshold; route-level lazy splitting is a future performance refinement.
- No production-day execution or post-production module is included by design.
