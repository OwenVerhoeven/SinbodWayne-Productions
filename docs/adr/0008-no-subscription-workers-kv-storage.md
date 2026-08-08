# ADR 0008: No-subscription Workers KV private-object profile

- Status: Accepted
- Date: 2026-08-08

## Context

The initial cloud deploy/test profile must be provisionable without a payment card or paid subscription. The application still needs private immutable file versions, checksummed export objects, authorized downloads, deterministic pins, and a future path to larger object storage. D1 remains the relational source of truth and must not contain binary bodies.

Workers KV provides a private Worker binding on the no-subscription Cloudflare profile, but it is not equivalent to object storage: values are bounded, writes have daily and same-key limits, there is no multipart API, and reads are eventually consistent.

## Decision

Use the `FILE_OBJECTS` Workers KV namespace behind the storage-neutral `PrivateObjectStore` adapter for the current deploy/test profile.

- Maximum byte object/file: 25 MiB (`26214400` bytes).
- Planned total private-object budget: 1 GB (`1000000000` bytes).
- Operational write ceiling: 1,000 writes per day.
- Upload mode: one bounded request; no multipart support is claimed.
- D1 stores logical metadata, current/version pins, byte size, MIME type, SHA-256, quota state, retention state, and audit evidence.
- The Worker calculates and validates byte integrity before publishing adapter metadata. Object keys are private, unique, and immutable.
- A recent-write miss is treated as retriable propagation. Missing/corrupt state is claimed only after the bounded retry policy and integrity checks fail.
- Downloads are authorized Worker responses; KV bindings and credentials never reach the browser.
- Large logical exports are represented by deterministic manifests over multiple bounded objects rather than one value above the KV limit.

R2 is retained as a future optional capacity backend. A migration must preserve the adapter contract, immutable keys, D1 pins, checksums, authorization, retention/legal holds, backup evidence, and a reversible per-object cutover. It is not part of the current deployment prerequisites.

The NAS pull protocol remains storage-neutral. Its production host, mount, service credential, and destination are a later optional operational rollout.

## Consequences

- Initial Cloudflare deployment needs both a D1 database ID and a Workers KV namespace ID, but no R2 bucket.
- Capacity and write ceilings are product-visible operational limits, not hidden provider failures.
- Multipart upload UI/API behavior is absent from this profile.
- KV eventual consistency requires retriable recent-write handling and prevents treating an immediate miss as definitive deletion.
- Range responses are adapter projections over a bounded object rather than native KV range reads.
- Storage growth beyond this profile requires an explicitly reviewed backend migration; it is not solved by weakening limits.

## Alternatives considered

- Private R2 as the initial backend: technically better for large files, multipart transfer, and object-store consistency, but deferred to keep the initial profile card/subscription-free.
- Binary bodies in D1: rejected because relational storage is not the byte-object boundary and would harm size, backup, and query behavior.
- Public object URLs: rejected because production files and recipient variants are confidential.
- Silently splitting one uploaded file across KV keys: rejected because the current user-facing contract is one file of at most 25 MiB; manifest chunking is reserved for generated logical exports.
