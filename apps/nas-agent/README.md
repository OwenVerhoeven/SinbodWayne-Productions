# Sinbod Wayne Productions NAS agent

This package is the outbound-only half of the archive workflow. It polls the authenticated service API, leases one immutable export job, downloads its private objects into a job-specific staging directory, verifies every byte count and SHA-256 digest, and only then installs files into the configured archive root and acknowledges the manifest. It does not listen on a port and its API surface has no cloud-delete operation.

## Safety contract

- The destination root is an explicit, existing absolute directory and may not be a filesystem root, symlink, or junction.
- Manifest paths are normalized POSIX-relative paths. Absolute paths, traversal, alternate separators, Windows device names, trailing dots/spaces, reserved characters, and the internal `.swp-staging` tree are rejected before transfer.
- Every existing directory and file component is checked for symlink/junction escape. The canonical result must remain under the destination root.
- Run the process as a dedicated least-privilege account with exclusive write access to the archive tree; this also prevents a local user from racing path checks.
- Partial downloads remain under `.swp-staging/job-<digest>/` and resume with an HTTP `Range` request. A server that ignores a range causes a safe full restart of that staging file.
- Available space is checked with the host filesystem API when exposed. The agent reserves 64 MiB by default in addition to remaining object bytes.
- Size and SHA-256 must match before installation. Existing final files are never replaced: a mismatch fails the job.
- Installation prefers an atomic, exclusive hard-link into the final name. Filesystems without hard links use a same-filesystem atomic rename while the server lease prevents concurrent agents; a cross-filesystem staging/final layout fails closed.
- File and parent-directory `fsync` are attempted; unsupported directory syncing is reported without claiming stronger durability.
- Item and manifest acknowledgements use deterministic idempotency keys, so a crash after installation or acknowledgement is safe to resume.
- Archive verification never removes an R2 object. Cloud retention is a separate owner-only application action.

## Configuration

Use a service-manager `EnvironmentFile` or equivalent for non-secret values. Keep the token out of that file: supply the service credential through an agent-account-readable credential file (recommended and re-read for every request, so atomic file replacement rotates it without exposing it in arguments) or pipe it through stdin. Direct token command-line arguments are deliberately unsupported.

| Variable                               | Meaning                                                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SWP_ARCHIVE_API_URL`                  | HTTPS application origin. Plain HTTP is accepted only for localhost with `SWP_ARCHIVE_ALLOW_INSECURE_LOCALHOST=true`. |
| `SWP_ARCHIVE_DESTINATION_ROOT`         | Existing absolute archive root, for example the mounted `Sinbod-Wayne-Productions` directory.                         |
| `SWP_ARCHIVE_AGENT_ID`                 | Stable 3–64 character agent identity.                                                                                 |
| `SWP_ARCHIVE_TOKEN_FILE`               | Absolute path to a regular credential file. Mutually exclusive with stdin.                                            |
| `SWP_ARCHIVE_TOKEN_STDIN=true`         | Read one credential from non-interactive stdin. Mutually exclusive with the file.                                     |
| `SWP_ARCHIVE_POLL_MS`                  | Idle poll interval; default 15 seconds.                                                                               |
| `SWP_ARCHIVE_LEASE_MS`                 | Lease duration; default 120 seconds.                                                                                  |
| `SWP_ARCHIVE_HEARTBEAT_MS`             | Heartbeat interval; default 30 seconds and less than half the lease.                                                  |
| `SWP_ARCHIVE_DOWNLOAD_ATTEMPTS`        | Per-item attempts; default 4.                                                                                         |
| `SWP_ARCHIVE_RETRY_BASE_MS`            | Initial exponential backoff; default 500 ms.                                                                          |
| `SWP_ARCHIVE_FREE_SPACE_RESERVE_BYTES` | Free-space reserve after remaining bytes; default 67108864.                                                           |

The credential file provider reads the file immediately before every request, never emits its value, rejects symlinks, and on POSIX requires no group/other permission bits. Stdin is intentionally rejected when attached to an interactive terminal because hidden-input handling belongs in an external secret manager or service launcher.

## Commands

From the repository root:

```text
npm run typecheck --workspace @swp/nas-agent
npm run test --workspace @swp/nas-agent
npm run build --workspace @swp/nas-agent
```

Run the compiled agent with `npm run start --workspace @swp/nas-agent`. Use a maintained mini-PC or server with the NAS mounted when the NAS cannot run Node 24. No inbound firewall rule or NAS admin exposure is needed.

## Manifest digest protocol

The service and agent compute SHA-256 over UTF-8 JSON containing `schemaVersion`, `projectId`, `exportSnapshotId`, and items sorted by item ID then relative path. Each item has a fixed property order, lower-case SHA-256, nullable logical/file-version IDs, and sorted source-revision IDs. `canonicalManifestJson` is exported as the protocol implementation. Any digest mismatch blocks all downloads.
