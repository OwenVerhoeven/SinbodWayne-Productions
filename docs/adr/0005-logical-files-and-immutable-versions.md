# ADR 0005: Logical files with immutable versions

- Status: Accepted
- Date: 2026-08-08

## Context

A release, location photo, storyboard frame, headshot, quote or generated report may be replaced during planning while older issues must retain the exact bytes they used. Public object storage and mutable keys would make historical artifacts irreproducible and can expose sensitive production data.

## Decision

Represent a file as:

- a mutable logical `file` record with display metadata, folder/tags/archive/current-version pointer; and
- one or more immutable `file_version` records containing a unique private R2 key, safe original/display name, observed byte size/media type, SHA-256, uploader/time, provenance, retention and scan/quarantine state.

Making a prior version current moves only the logical pointer. Issued artifacts and archive manifests pin `file_version_id`, never the logical current pointer.

R2 has no public listing. Upload authority is narrowly scoped; completion verifies object/storage and integrity evidence before the version is usable. Downloads are short-lived and scoped or streamed through the authorized Worker with safe headers. Rich previews use an allowlist. Incomplete multipart uploads are cleaned only through bounded verified records.

Permanent byte deletion is retention/legal-hold/pin aware and cannot remove the only known good copy. Archive verification alone never triggers it.

## Consequences

- Replacement and rollback are safe and audit-friendly.
- Storage and retention views must account for every immutable version and pin.
- Generated reports/exports use the same version model, making packs and NAS manifests consistent.
- Duplicate-byte optimization, if added, must preserve authorization, retention and logical provenance rather than exposing shared keys.

## Alternatives considered

- Overwrite one R2 object per logical file: rejected because issued artifacts would change retroactively.
- Public bucket URLs: rejected because files contain confidential and recipient-private data.
- Binary files in D1: rejected for storage/performance and streaming reasons.
