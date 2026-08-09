# ADR 0001: First-party authentication and controlled-account bootstrap

- Status: Accepted
- Date: 2026-08-08

## Context

Sinbod Wayne Productions is a private internal tool with an explicit account manifest. The current requirement is exactly three approved active identities: an owner, an editing producer, and a view-only guest. There is no registration, invitation, additional demo account, hidden administrator or email-reset path. Cloudflare Access may later add a perimeter but cannot replace application identity or authorization.

Production credentials must never appear in source, migrations, fixtures, documentation, client code, shell arguments/history or logs. The Worker runtime constrains available password KDF implementations. Sessions, CSRF, recovery and role boundaries must remain application-owned and testable.

The owner explicitly accepted that bootstrap credentials remain usable until changed; first-login rotation is not forced.

## Decision

Implement case-sensitive first-party username/password authentication with:

- an approved identity manifest containing only non-secret identity/role data;
- a one-time, idempotent bootstrap CLI that gathers credentials through hidden interactive input, qualifies a pinned Worker-compatible KDF profile, provisions only missing approved identities, never resets an existing credential, and verifies the exact active-account invariant;
- fail-closed production behavior if KDF qualification or the account invariant fails;
- a random production pepper stored only as the `AUTH_PEPPER` Worker secret, combined with per-credential random salts and recorded PBKDF2 parameters; the secret is provisioned outside Git and is required for production verification/recovery;
- generic login behavior with equivalent verification work for unknown usernames, bounded backoff and edge/application rate controls;
- random session credentials stored only as digests, secure host-only HTTP-only strict-same-site production cookie, idle and absolute expiry, authentication epoch, rotation, listing and revocation;
- per-session CSRF proof kept in browser memory plus exact-origin, Fetch Metadata and content-type validation for cookie mutations;
- password/privilege change revoking other sessions;
- owner-controlled recovery limited to the known approved owner identity, using a one-time protected operation and the same hidden-input/KDF path;
- separate authentication contexts for app users, public/share recipients, service agents and providers;
- server-side owner/producer/viewer policy for every request and sensitive field; viewer access is GET/HEAD-only and excludes live collaboration upgrades.

The KDF selection order is tested against the exact pinned Worker runtime. A native memory-hard option is preferred; a Worker-compatible memory-hard alternative is next. The no-subscription Worker profile uses a pepper-bound PBKDF2-SHA-256 fallback with bounded runtime cost because Free-plan HTTP requests have a materially smaller CPU budget than local/test execution. Its parameters are encoded per credential, and rate limiting/backoff remain mandatory. Raising the work factor or migrating to a memory-hard profile requires runtime qualification and credential rotation.

No forced first-login change flag is set. The UI still provides credential change, device/session review and revocation.

## Consequences

- Authentication does not depend on a paid hosted service and remains enforceable in local/Cloudflare tests.
- Bootstrap and recovery are privileged operational workflows requiring explicit runbooks and production target confirmation.
- An accepted initial credential can remain valid longer than a forced-rotation design; rate control, secure hashing, audit, voluntary change and session revocation are compensating controls. The acceptance must be reviewed if perimeter or team assumptions change.
- Cloudflare Access can later be layered outside the Worker, but application sessions and policy remain authoritative.
- Production tests verify account count through non-secret identity metadata; automated tests use only isolated fictional identities.

## Alternatives considered

- Cloudflare Access as primary authentication: rejected because the application needs first-party identities, sessions, comments, approvals and server authorization.
- Public invitation/registration: rejected by the fixed launch identity requirement.
- Mandatory email reset: rejected because no mandatory email provider is allowed and launch recovery is owner/operator controlled.
- Forced first-login rotation: not selected by explicit owner decision.
