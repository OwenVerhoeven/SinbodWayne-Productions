# ADR 0007: Outbound-only, checksummed NAS archival

- Status: Accepted
- Date: 2026-08-08

## Context

The cloud application is the active workspace; a private NAS is the durable archive target. Exposing the NAS as an inbound web origin or treating “download requested” as verified would create unnecessary attack surface and false recovery confidence. Transfers must tolerate interruption and hostile/corrupt manifest data without writing outside the intended project destination.

## Decision

An authorized producer creates an immutable export snapshot and durable archive job. Workflows prepare versioned project JSON, human/issued artifacts, selected exact file versions and an immutable manifest in private R2.

An outbound-only Node agent on a maintained host with the NAS mounted:

- authenticates using a revocable least-privilege service identity;
- polls/leasing one eligible job with heartbeat and reclaimable expiry;
- obtains only manifest-bound object access;
- validates an explicit absolute destination and every safe relative manifest path, including traversal/collision/link/reparse protections;
- checks free space where supported;
- stages per job, streams and resumes bounded partial files;
- verifies every byte size and SHA-256 plus overall manifest identity;
- flushes and atomically promotes a wholly verified tree where supported;
- acknowledges items and complete manifest idempotently;
- never opens an inbound port, exposes NAS administration or logs credentials/signed access.

The application states are Requested, Running, Verifying, Verified and Failed, based on durable evidence. Archive, verification and cloud retention removal are separate. Cloud bytes are never automatically deleted.

## Consequences

- A NAS unable to run the agent directly can be mounted by a maintained mini-PC/server without inbound forwarding.
- Safe path and filesystem behavior are security-critical domain code with hostile-platform tests.
- Failed/partial staging needs a bounded cleanup and operator-recovery policy.
- The service protocol must support credential rotation and duplicate/reordered requests.
- Owner-only cloud retention requires exact verified-version evidence, legal/retention checks and typed confirmation.

## Alternatives considered

- Browser uploads directly to the NAS: rejected because it requires network reachability and weakens verification/control.
- Inbound NAS webhook/server: rejected because the NAS must not be internet facing.
- Sync/mount R2 as a live directory: rejected because it blurs active workspace, archive identity and verification.
- Delete cloud data on archive completion: rejected because archive and retention are separate risk decisions and no automation may remove the only known good copy.
