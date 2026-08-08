# Backup, Restore, and NAS Archive

## Current operating status

The current no-card/no-subscription cloud profile uses D1 for relational metadata and a private Workers KV namespace for immutable byte objects. The storage adapter enforces 25 MiB per file, a 1 GB (`1000000000` bytes) planned total, 1,000 writes per day, and single-request uploads with no multipart support. KV is eventually consistent; a recent-write miss is retriable and cannot by itself prove deletion or corruption.

The NAS agent and protocol are implemented and locally tested. A production NAS host, mount, destination, and service credential have not been provisioned or verified; that is a later optional operational rollout. Initial cloud deployment must not claim NAS durability or a `Verified` archive.

R2 is not required by the current profile. It remains a future optional capacity migration behind the same private-object adapter.

## Distinct purposes

- **Cloud workspace:** active D1 metadata plus private Workers KV file versions and bounded snapshots.
- **Backup:** operator-controlled recovery copies of current cloud state and configuration inventory.
- **Project archive:** an immutable, human-readable/versioned package that a later configured outbound NAS agent transfers and verifies.
- **Cloud retention removal:** a separate owner-only action after a verified archive and all retention/legal-hold checks.

Archive verification is not a backup-policy substitute. Archive, Verify, and Remove cloud copy are different actions, permissions, and audit events. No successful archive job automatically removes a cloud object.

## Backup scope

A recoverable backup set includes:

- D1 export with schema/migration version and integrity metadata;
- an inventory of every logical file/version and immutable issue/export object, including object key, expected size, media type, SHA-256, and current/pinned relationships;
- verified copies of required private KV values, addressed by their immutable keys and reconciled to the D1 inventory;
- deployed build/configuration identifiers, binding names, D1 ID, KV namespace ID, and compatibility settings without secret values;
- a secret/credential ownership and rotation inventory without credentials themselves;
- FTS schema/rebuild version, because search indexes are derived rather than canonical;
- restore/runbook version and the operator who verified it.

KV propagation means backup tooling must retry a recent-write miss for a bounded period and distinguish `propagating` from an evidenced missing object. A backup is incomplete until every required object is read, its byte count and SHA-256 match D1, and the backup manifest itself is integrity protected.

Never log or store raw credentials, password-derived material, private keys, or bearer/scoped access in backup manifests.

## Backup cadence and evidence

The workspace owner defines frequency and retention in workspace settings and the operational platform. At minimum, take a verified recovery point before:

- remote migration;
- authentication/bootstrap/recovery mechanism change;
- file-storage binding or key migration;
- destructive retention action;
- schema/serialization change affecting exports or archive manifests;
- major deployment with non-backward-compatible state.

A backup is healthy only when creation completed, expected inventories/counts are present, required KV bytes passed size/checksum verification, and a restore rehearsal within the configured review interval succeeded. The dashboard must not label unknown, merely requested, or still-propagating state as healthy.

## Restore procedure

Restore is an explicit owner/operator incident action:

1. identify the intended recovery point and affected projects, users, files, and jobs;
2. preserve the current failed/partial state for investigation and reconcile newer immutable records rather than overwriting blindly;
3. create isolated replacement D1 and private KV resources where practical;
4. import canonical D1 data and verify migrations, foreign keys, immutable/current-pointer invariants, approved-account manifest, quotas, and row counts;
5. restore required immutable KV values under their recorded keys and verify byte sizes/SHA-256 against D1 and backup manifests;
6. retry bounded recent-write reads until they are visible or fail explicitly; never normalize a propagation miss to a completed restore;
7. rebuild derived FTS indexes from canonical rows and verify permitted-search counts/samples;
8. reconcile current pointers, retention tombstones, in-flight idempotency/workflow leases, provider events, archive acknowledgements, and stale readiness artifacts;
9. deploy a schema-compatible build against the isolated restore and run authentication, project, file, recipient, print, readiness, and archive-request smoke tests;
10. switch production bindings/domain only after owner approval;
11. record exact evidence, data gaps, stale/reissued artifacts, and follow-up work.

Never restore fictional test seed into production and never replace both active and backup copies before validating the restore.

## Archive request flow after NAS rollout

```mermaid
sequenceDiagram
  participant U as Authorized producer
  participant W as Worker
  participant F as Workflow
  participant K as Private Workers KV
  participant A as NAS agent
  participant N as NAS mount

  U->>W: Request archive (idempotency key)
  W->>F: Create durable export/archive job
  F->>K: Write immutable bounded exports + manifest objects
  F->>W: State = Requested
  A->>W: Lease next job (service credential)
  W-->>A: Scoped manifest/object response
  A->>N: Validate root, space, paths; stage/resume
  A->>A: Verify every size and checksum
  A->>N: Flush and atomically promote verified tree
  A->>W: Idempotent item + manifest acknowledgements
  W-->>U: State = Verified with evidence
```

Before NAS provisioning, the cloud side may create immutable exports and archive requests, but there is no agent evidence for `Running`, `Verifying`, or `Verified`. The UI must remain explicit about the unavailable destination.

## Manifest contract

The immutable export manifest records:

- manifest and project-export schema versions;
- workspace/project and export snapshot IDs;
- logical file and exact file-version IDs;
- issued report/revision/issue IDs and source pins;
- safe relative destination path;
- expected byte size and media type;
- SHA-256 for each byte object;
- deterministic overall manifest integrity over canonical manifest content;
- creation actor/time and selection/permission policy;
- storage-neutral immutable object references fetched only through the authenticated service route.

Each physical object must remain at or below 25 MiB. A larger logical export is a deterministic manifest over multiple bounded objects; it is not a multipart upload and no single KV value may exceed the ceiling.

The overall integrity excludes mutable job/lease/attempt state. An acknowledgement refers to the immutable manifest identity and cannot substitute a different object/version.

## Required archive layout

```text
Sinbod-Wayne-Productions/
  <project-code>-<safe-project-title>/
    manifest/
      project-manifest.json
      checksums.sha256
      schema-version.txt
    00-project-development/
    01-story-writing/
    02-breakdown/
    03-visual-planning/
    04-cast-crew/
    05-locations/
    06-budget/
    07-legal-safety/
    08-equipment-logistics/
    09-schedule/
    10-call-sheets-production-packs/
    11-data-exports/
```

Safe project directory names are deterministic display projections. Stable project/export identities live in the manifest so a title/code change does not redefine the archive identity.

## Job state machine

```text
Requested -> Running -> Verifying -> Verified
    |           |           |
    +-----------+-----------+-> Failed (actionable, retryable when safe)
```

- `Requested`: immutable export/manifest exists and is eligible to lease.
- `Running`: a configured agent owns a bounded lease and heartbeats while transferring/staging.
- `Verifying`: all items appear present; complete size/integrity and final-layout checks are running.
- `Verified`: the agent atomically promoted the complete package and the application accepted idempotent item/manifest evidence.
- `Failed`: an attempt ended with a categorized safe error; the immutable cloud snapshot remains available for retry/investigation.

Expired leases are recoverable. Attempt history is append-only. `Verified` cannot result from only a browser callback, a cloud export, or acknowledgement of an incomplete/different manifest.

## NAS agent safety contract

The later operator provides an explicit validated absolute destination. The agent must:

- refuse filesystem roots, home aliases, unresolved environment values, and unexpected destination changes;
- derive all content paths from validated relative manifest paths, never cloud object keys or original file names;
- reject absolute paths, `..`, empty/dot components, platform-reserved names, alternate separators/streams, path collisions, and case/normalization collisions as applicable;
- inspect existing parent components and reject symlink, junction, or reparse escape;
- stage under a job-specific directory within the configured archive root;
- check available space before transfer where the host exposes reliable information and fail actionably when insufficient;
- resume a partial only when its manifest/object/version identity and current length are valid;
- retrieve bytes through the service route without logging credentials or scoped access;
- tolerate a retriable recent-write propagation response without treating it as a missing file;
- verify final size and SHA-256;
- flush file and directory metadata where supported before promotion;
- promote only a wholly verified staging tree, using an atomic rename on the same filesystem where possible;
- acknowledge each item and the complete manifest idempotently;
- keep failed staging recoverable according to a bounded cleanup policy and never overwrite a known-good final tree silently;
- open outbound connections only and never expose a listener, NAS admin UI, or inbound port forwarding.

## Agent configuration and credentials

Agent configuration contains:

- application base URL;
- validated destination root;
- polling/lease/concurrency limits;
- least-privilege service identity through a protected local secret mechanism;
- safe TLS/proxy settings if the operator requires them;
- bounded staging retention and log destination.

The service identity can lease/read/ack archive data only. It cannot authenticate as a human, list unrelated project content, mutate project data, issue readiness, alter retention, or remove cloud copies. Rotate by provisioning a replacement credential, validating one lease/heartbeat under controlled conditions, then revoking the old credential. Logs record credential ID/rotation metadata only where safe, never its secret or object-access authority.

## Failure and retry behavior

- **Interruption:** preserve verified partial bytes and resume through service-route range semantics after reclaiming/renewing a valid lease. The KV adapter projects a bounded range from the complete stored value; it does not claim native multipart/range storage.
- **Recent-write propagation:** retry with bounded backoff while the service reports the explicit propagating condition; fail actionably after the policy deadline.
- **Duplicate acknowledgement:** return the prior accepted result for the same manifest/item/idempotency identity.
- **Missing object:** fail the attempt; do not create an empty placeholder or verify the manifest.
- **Size/checksum mismatch:** quarantine/retain staging for bounded diagnosis, mark failed, and never promote/ack complete.
- **Invalid/escaping/colliding path:** reject the manifest before writing content.
- **Insufficient space:** fail before transfer where detectable and report required/available context without sensitive paths beyond the configured safe display.
- **Lease expiry:** stop using expired authority; another attempt may safely resume from manifest identity and staged evidence.
- **Final destination exists:** compare explicit manifest identity and policy; never overwrite silently. A duplicate verified job returns idempotent evidence or uses a distinct versioned location.
- **Acknowledgement network failure after promotion:** retry idempotently; the local receipt retains manifest identity so the agent does not redownload or fork the final tree.

## Cloud-copy retention action

`Remove cloud copy` is not an archive-job transition. It requires:

- owner role and a current privileged session;
- typed project/action confirmation;
- a verified NAS archive for the exact eligible export/file versions;
- satisfied configured retention interval and backup policy;
- no active legal hold or issued-artifact dependency requiring the cloud version;
- a preview listing exact logical files/versions and recovery consequences;
- idempotency and an immutable audit/retention receipt.

The safe KV profile resolves every intended immutable key first, records D1 retention tombstones/authorization state, and deletes only explicitly eligible values. It never derives a broad recursive target from a project prefix. Because KV is eventually consistent, an immediate post-delete read cannot be the sole proof that every edge has observed deletion; the operation records intent and reconciliation evidence separately. Metadata, manifests, audit, and issued pins remain according to policy.

## Verification tests

Automated agent/protocol tests cover:

- interrupted transfer and valid range resume;
- recent-write propagation and bounded retry;
- stale/expired lease and safe re-lease;
- duplicate item/manifest acknowledgement;
- missing object and remote truncation;
- size and checksum mismatch;
- absolute/traversal/reserved/colliding path;
- symlink/junction/reparse escape;
- insufficient-space behavior;
- same-filesystem atomic promotion and unsupported-atomicity fallback failure;
- existing known-good destination;
- acknowledgement failure after local promotion;
- credential revocation/rotation;
- proof that archive completion never invokes cloud deletion.

After production NAS provisioning, a periodic restore/archive rehearsal selects an immutable export, transfers it to an isolated destination, verifies all checksums, reads the JSON schema, opens representative human documents, and records evidence without sensitive content.

## Future optional R2 migration

R2 may later replace KV behind the same storage-neutral adapter if approved capacity, multipart, or transfer needs justify it. Migration must preserve immutable identities or a verified mapping, D1 pins, checksums, retention/legal holds, backup evidence, authorization, export manifests, and NAS protocol compatibility. It requires a separate cutover/rollback plan and fresh security and restore testing; this document does not claim that migration exists today.
