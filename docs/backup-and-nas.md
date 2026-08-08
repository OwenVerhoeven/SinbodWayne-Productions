# Backup, Restore, and NAS Archive

## Distinct purposes

- **Cloud workspace:** active D1 metadata and private R2 versions/snapshots.
- **Backup:** operator-controlled recovery copies of current cloud state and configuration inventory.
- **Project archive:** an immutable, human-readable/versioned pre-production package requested from the application and verified by the outbound NAS agent.
- **Cloud retention removal:** a separate owner-only action after verified archive and all retention/legal-hold checks.

Archive verification is not a backup-policy substitute. Archive, Verify, and Delete are different actions, permissions and audit events. No successful archive job automatically removes a cloud object.

## Backup scope

A recoverable backup set includes:

- D1 export with schema/migration version and integrity metadata;
- inventory of every logical file/version and immutable issue/export R2 object, including expected size/media type/integrity;
- copies or replication/export of required private R2 objects according to the owner-approved retention policy;
- deployed build/configuration identifiers, binding names and compatibility settings without secret values;
- a secret/credential ownership and rotation inventory without the credentials themselves;
- FTS schema/rebuild version, because search indexes are derived rather than canonical;
- restore/runbook version and the operator who verified it.

Never log or store signed access, raw credentials, password-derived material or private keys in backup manifests.

## Backup cadence and evidence

The workspace owner defines frequency and retention in workspace settings and the operational platform. At minimum, take a verified recovery point before:

- remote migration;
- authentication/bootstrap/recovery mechanism change;
- file/storage key migration;
- destructive retention action;
- schema/serialization change affecting exports or archive manifests;
- major deployment with non-backward-compatible state.

A backup is healthy only when its creation completed, expected inventories/counts are present, sampled or complete integrity verification passed as policy requires, and a restore rehearsal within the configured review interval succeeded. The dashboard must not label unknown or merely requested state as healthy.

## Restore procedure

Restore is an explicit owner/operator incident action:

1. identify the intended recovery point and affected projects/users/jobs;
2. preserve the current failed/partial state for investigation and reconcile newer immutable records rather than overwriting blindly;
3. create isolated replacement D1/R2 resources where practical;
4. import canonical D1 data and verify migrations, foreign keys, immutable/current-pointer invariants, approved account manifest and row counts;
5. restore required R2 versions and verify object sizes/integrity against D1 and backup manifests;
6. rebuild derived FTS indexes from canonical rows and verify permitted-search counts/samples;
7. reconcile current pointers, in-flight idempotency/workflow leases, provider events, archive acknowledgements and stale readiness artifacts;
8. deploy a schema-compatible build against the isolated restore and run authentication, project, file, recipient, print, readiness and archive-request smoke tests;
9. switch production bindings/domain only after owner approval;
10. record exact evidence, data gap, stale/reissued artifacts and follow-up work.

Never restore fictional test seed into production and never replace both active and backup copies before validating the restore.

## Archive request flow

```mermaid
sequenceDiagram
  participant U as Authorized producer
  participant W as Worker
  participant F as Workflow
  participant R as Private R2
  participant A as NAS agent
  participant N as NAS mount

  U->>W: Request archive (idempotency key)
  W->>F: Create durable export/archive job
  F->>R: Write immutable project export + manifests
  F->>W: State = Requested
  A->>W: Lease next job (service credential)
  W-->>A: Scoped manifest/object access
  A->>N: Validate root, space, paths; stage/resume
  A->>A: Verify every size and checksum
  A->>N: Flush and atomically promote verified tree
  A->>W: Idempotent item + manifest acknowledgements
  W-->>U: State = Verified with evidence
```

## Manifest contract

The immutable export manifest records:

- manifest and project-export schema versions;
- workspace/project and export snapshot IDs;
- logical file and exact file-version IDs;
- issued report/revision/issue IDs and source pins;
- safe relative destination path;
- expected byte size and media type;
- SHA-256 integrity for each byte object;
- deterministic overall manifest integrity over canonical manifest content;
- creation actor/time and selection/permission policy;
- R2 object references that can be exchanged for short-lived scoped access.

The overall integrity excludes mutable job/lease/attempt state. Acknowledgement refers to the immutable manifest identity and cannot substitute a different object/version.

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
- `Running`: agent owns a bounded lease and heartbeats while transferring/staging.
- `Verifying`: all items appear present; complete size/integrity and final-layout checks are running.
- `Verified`: the agent atomically promoted the complete package and the application accepted idempotent item/manifest evidence.
- `Failed`: an attempt ended with a categorized safe error; immutable snapshot remains available for retry/investigation.

Expired leases are recoverable. Attempt history is append-only. `Verified` cannot result from only a browser callback or from acknowledging an incomplete/different manifest.

## NAS agent safety contract

The operator provides an explicit validated absolute destination. The agent must:

- refuse filesystem roots, home aliases, unresolved environment values and unexpected destination changes;
- derive all content paths from validated relative manifest paths, never cloud object keys or original file names;
- reject absolute paths, `..`, empty/dot components, platform-reserved names, alternate separators/streams, path collisions and case/normalization collisions as applicable;
- inspect existing parent components and reject symlink, junction or reparse escape;
- stage under a job-specific directory within the configured archive root;
- check available space before transfer where the host exposes reliable information and fail actionably when insufficient;
- resume a partial only when its manifest/object/version identity and current length are valid;
- stream data without logging scoped access and verify final size and SHA-256;
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

The service identity can lease/read/ack archive data only. It cannot authenticate as a human, list unrelated project content, mutate project data, issue readiness, alter retention, or remove cloud copies. Rotate by provisioning a new credential, validating one lease/heartbeat under controlled conditions, then revoking the old credential. Logs record credential ID/rotation metadata only where safe, never its secret or signed object access.

## Failure and retry behavior

- **Interruption:** preserve verified partial bytes and resume with range semantics after reclaiming/renewing a valid lease.
- **Duplicate acknowledgement:** return the prior accepted result for the same manifest/item/idempotency identity.
- **Missing object:** fail the attempt; do not create an empty placeholder or verify the manifest.
- **Size/checksum mismatch:** quarantine/retain staging for bounded diagnosis, mark failed and never promote/ack complete.
- **Invalid/escaping/colliding path:** reject the manifest before writing content.
- **Insufficient space:** fail before transfer where detectable and report required/available context without sensitive paths beyond the configured safe display.
- **Lease expiry:** stop using expired scoped access; another attempt may safely resume based on manifest identity and staged evidence.
- **Final destination exists:** compare explicit manifest identity and policy; never overwrite silently. A duplicate verified job returns idempotent evidence or uses a distinct versioned location.
- **Acknowledgement network failure after promotion:** retry idempotently; local receipt retains manifest identity so the agent does not redownload or fork the final tree.

## Cloud-copy retention action

`Remove cloud copy` is not an archive-job transition. It requires:

- owner role and a current privileged session;
- typed project/action confirmation;
- a verified archive for the exact eligible export/file versions;
- satisfied configured retention interval and backup policy;
- no active legal hold or issued-artifact dependency requiring the cloud version;
- a preview listing exact logical files/versions and recovery consequences;
- idempotency and immutable audit/retention receipt.

The safest implementation initially removes only explicitly eligible R2 byte objects while preserving metadata/tombstones, manifests, audit and issued pins as policy requires. It must never compute a broad recursive target from a project prefix without resolving and validating every intended object.

## Verification tests

Automated agent/protocol tests cover:

- interrupted transfer and valid range resume;
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

A periodic restore/archive rehearsal selects an immutable export, transfers it to an isolated destination, verifies all checksums, reads the JSON schema, opens representative human documents, and records evidence without sensitive content.
