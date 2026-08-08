-- Private file/version metadata, readiness evaluation/snapshots, exports, and
-- outbound-only NAS archive job state. Binary bodies remain in private object storage.

PRAGMA foreign_keys = ON;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  parent_folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  logical_code TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, parent_folder_id, title)
);

CREATE INDEX folders_project_tree_idx ON folders(project_id, parent_folder_id, archived_at, sort_rank);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  safe_display_name TEXT NOT NULL DEFAULT '',
  current_version_id TEXT,
  provenance TEXT,
  retention_class TEXT,
  retention_review_at INTEGER,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX files_project_folder_idx ON files(project_id, folder_id, archived_at, sort_rank);
CREATE INDEX files_project_recent_idx ON files(workspace_id, project_id, archived_at, updated_at DESC, id DESC);

CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  original_name TEXT NOT NULL,
  safe_display_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  uploader_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  provenance TEXT,
  scan_state TEXT NOT NULL DEFAULT 'not_configured' CHECK (scan_state IN ('pending', 'clean', 'quarantined', 'failed', 'not_configured')),
  scan_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scan_evidence_json)),
  retention_class TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (file_id, version_number)
);

CREATE INDEX file_versions_file_cursor_idx ON file_versions(file_id, created_at DESC, id DESC);
CREATE INDEX file_versions_project_sha_idx ON file_versions(project_id, sha256, byte_size);

CREATE TABLE file_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL,
  pinned_file_version_id TEXT REFERENCES file_versions(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (file_id, object_id, purpose, pinned_file_version_id)
);

CREATE INDEX file_links_object_idx ON file_links(project_id, object_id, archived_at, purpose);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  intended_name TEXT NOT NULL,
  intended_mime_type TEXT NOT NULL,
  intended_byte_size INTEGER NOT NULL CHECK (intended_byte_size >= 0),
  intended_sha256 TEXT CHECK (intended_sha256 IS NULL OR (length(intended_sha256) = 64 AND intended_sha256 NOT GLOB '*[^0-9a-f]*')),
  allowed_types_json TEXT NOT NULL CHECK (json_valid(allowed_types_json)),
  upload_mode TEXT NOT NULL CHECK (upload_mode IN ('single', 'multipart')),
  multipart_upload_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'uploading', 'verifying', 'complete', 'failed', 'expired', 'aborted')),
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER NOT NULL,
  completed_file_version_id TEXT REFERENCES file_versions(id) ON DELETE RESTRICT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX upload_sessions_cleanup_idx ON upload_sessions(state, expires_at, project_id);

CREATE TABLE upload_parts (
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE RESTRICT,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  etag TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (upload_session_id, part_number)
);

CREATE TABLE readiness_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  project_type TEXT,
  current_version_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE readiness_profile_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  readiness_profile_id TEXT NOT NULL REFERENCES readiness_profiles(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  name TEXT NOT NULL,
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (readiness_profile_id, version_number)
);

CREATE TABLE readiness_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  readiness_profile_version_id TEXT NOT NULL REFERENCES readiness_profile_versions(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'shoot_day')),
  evaluation_type TEXT NOT NULL CHECK (evaluation_type IN ('automatic', 'manual')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'blocker')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  owner_only_override INTEGER NOT NULL DEFAULT 0 CHECK (owner_only_override IN (0, 1)),
  rule_definition_json TEXT NOT NULL CHECK (json_valid(rule_definition_json)),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (readiness_profile_version_id, code)
);

CREATE TABLE readiness_evaluations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  readiness_profile_version_id TEXT NOT NULL REFERENCES readiness_profile_versions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  source_watermark INTEGER NOT NULL,
  started_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_code TEXT,
  CHECK ((shoot_day_id IS NULL) OR (project_id IS NOT NULL))
);

CREATE INDEX readiness_evaluations_scope_idx ON readiness_evaluations(project_id, shoot_day_id, started_at DESC);

CREATE TABLE readiness_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  readiness_evaluation_id TEXT NOT NULL REFERENCES readiness_evaluations(id) ON DELETE RESTRICT,
  readiness_rule_id TEXT NOT NULL REFERENCES readiness_rules(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK (result IN ('pass', 'warning', 'blocker', 'unavailable')),
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  due_at INTEGER,
  explanation TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  resolution_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  evaluated_at INTEGER NOT NULL,
  UNIQUE (readiness_evaluation_id, readiness_rule_id)
);

CREATE INDEX readiness_results_gap_idx ON readiness_results(project_id, result, due_at, readiness_rule_id);

CREATE TABLE readiness_sources (
  id TEXT PRIMARY KEY,
  readiness_result_id TEXT NOT NULL REFERENCES readiness_results(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  revision_or_version_id TEXT,
  source_hash TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (readiness_result_id, object_id, revision_or_version_id)
);

CREATE TABLE readiness_overrides (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  readiness_rule_id TEXT NOT NULL REFERENCES readiness_rules(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  evidence_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  revoke_reason TEXT
);

CREATE INDEX readiness_overrides_active_idx ON readiness_overrides(project_id, shoot_day_id, readiness_rule_id, revoked_at, expires_at);

CREATE TABLE readiness_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  readiness_evaluation_id TEXT NOT NULL REFERENCES readiness_evaluations(id) ON DELETE RESTRICT,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'stale', 'superseded')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
  issued_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  issued_at INTEGER NOT NULL,
  supersedes_issue_id TEXT REFERENCES readiness_issues(id) ON DELETE RESTRICT,
  UNIQUE (project_id, shoot_day_id, issue_number)
);

CREATE TABLE readiness_issue_results (
  id TEXT PRIMARY KEY,
  readiness_issue_id TEXT NOT NULL REFERENCES readiness_issues(id) ON DELETE RESTRICT,
  readiness_rule_id TEXT NOT NULL REFERENCES readiness_rules(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK (result IN ('pass', 'warning', 'blocker', 'unavailable', 'overridden')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (readiness_issue_id, readiness_rule_id)
);

CREATE TABLE readiness_issue_sources (
  id TEXT PRIMARY KEY,
  readiness_issue_id TEXT NOT NULL REFERENCES readiness_issues(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  revision_or_version_id TEXT,
  source_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (readiness_issue_id, object_id, revision_or_version_id)
);

CREATE TABLE readiness_stale_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  readiness_issue_id TEXT NOT NULL REFERENCES readiness_issues(id) ON DELETE RESTRICT,
  changed_object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  prior_revision_or_version_id TEXT,
  current_revision_or_version_id TEXT,
  reason TEXT NOT NULL,
  detected_at INTEGER NOT NULL
);

CREATE INDEX readiness_stale_events_issue_idx ON readiness_stale_events(readiness_issue_id, detected_at, id);

CREATE TABLE export_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  snapshot_type TEXT NOT NULL DEFAULT 'manual',
  schema_version TEXT NOT NULL DEFAULT '1',
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'building', 'complete', 'failed', 'superseded')),
  title TEXT NOT NULL,
  summary TEXT,
  manifest_object_key TEXT,
  manifest_hash TEXT CHECK (manifest_hash IS NULL OR (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')),
  body_object_key TEXT,
  content_hash TEXT CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
  requested_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX export_snapshots_project_idx ON export_snapshots(project_id, state, created_at DESC, id DESC);

CREATE TABLE export_snapshot_objects (
  id TEXT PRIMARY KEY,
  export_snapshot_id TEXT NOT NULL REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  revision_or_version_id TEXT,
  source_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (export_snapshot_id, object_id, revision_or_version_id)
);

CREATE TABLE export_manifest_items (
  id TEXT PRIMARY KEY,
  export_snapshot_id TEXT NOT NULL REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  logical_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
  file_version_id TEXT REFERENCES file_versions(id) ON DELETE RESTRICT,
  source_revision_id TEXT,
  relative_path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (export_snapshot_id, relative_path)
);

CREATE TABLE archive_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  export_snapshot_id TEXT NOT NULL REFERENCES export_snapshots(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'verifying', 'verified', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_retryable INTEGER CHECK (last_error_retryable IS NULL OR last_error_retryable IN (0, 1)),
  requested_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX archive_jobs_service_queue_idx ON archive_jobs(status, updated_at, created_at, id);
CREATE INDEX archive_jobs_project_idx ON archive_jobs(project_id, status, created_at DESC);

CREATE TABLE archive_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  archive_job_id TEXT NOT NULL REFERENCES archive_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  service_credential_id TEXT NOT NULL REFERENCES service_credentials(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('running', 'verifying', 'verified', 'failed', 'expired')),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (archive_job_id, attempt_number)
);

CREATE TABLE archive_leases (
  archive_job_id TEXT PRIMARY KEY REFERENCES archive_jobs(id) ON DELETE CASCADE,
  service_credential_id TEXT NOT NULL REFERENCES service_credentials(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  lease_token_hash TEXT NOT NULL UNIQUE,
  leased_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > leased_at)
);

CREATE INDEX archive_leases_expiry_idx ON archive_leases(expires_at, archive_job_id);

CREATE TABLE archive_manifest_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  archive_job_id TEXT NOT NULL REFERENCES archive_jobs(id) ON DELETE RESTRICT,
  logical_file_id TEXT REFERENCES files(id) ON DELETE RESTRICT,
  file_version_id TEXT REFERENCES file_versions(id) ON DELETE RESTRICT,
  source_revision_id TEXT,
  relative_path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  sort_rank TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'downloaded', 'verified', 'failed')),
  created_at INTEGER NOT NULL,
  UNIQUE (archive_job_id, relative_path)
);

CREATE INDEX archive_manifest_items_job_state_idx ON archive_manifest_items(archive_job_id, state, sort_rank);

CREATE TABLE archive_acknowledgements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  archive_job_id TEXT NOT NULL REFERENCES archive_jobs(id) ON DELETE RESTRICT,
  manifest_item_id TEXT REFERENCES archive_manifest_items(id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES archive_attempts(id) ON DELETE RESTRICT,
  ack_kind TEXT NOT NULL CHECK (ack_kind IN ('item', 'manifest', 'failure')),
  verified_byte_size INTEGER CHECK (verified_byte_size IS NULL OR verified_byte_size >= 0),
  verified_item_count INTEGER CHECK (verified_item_count IS NULL OR verified_item_count >= 0),
  verified_sha256 TEXT CHECK (verified_sha256 IS NULL OR (length(verified_sha256) = 64 AND verified_sha256 NOT GLOB '*[^0-9a-f]*')),
  destination_path TEXT,
  error_code TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  service_credential_id TEXT NOT NULL REFERENCES service_credentials(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  UNIQUE (archive_job_id, idempotency_key)
);

CREATE INDEX archive_acknowledgements_job_idx ON archive_acknowledgements(archive_job_id, ack_kind, created_at, id);

CREATE TABLE retention_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  archive_job_id TEXT NOT NULL REFERENCES archive_jobs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action = 'remove_cloud_copy'),
  typed_confirmation_hash TEXT NOT NULL,
  legal_hold_check_json TEXT NOT NULL CHECK (json_valid(legal_hold_check_json)),
  retention_check_json TEXT NOT NULL CHECK (json_valid(retention_check_json)),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'completed', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
