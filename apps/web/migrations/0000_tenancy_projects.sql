-- Sinbod Wayne Productions: tenancy, authentication, common object graph,
-- projects, and development records.
-- Timestamps are UTC Unix milliseconds. Secrets are represented only by digests.

PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  logo_file_id TEXT,
  address_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(address_json)),
  contact_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(contact_json)),
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  locale TEXT NOT NULL DEFAULT 'en-GB',
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  unit_system TEXT NOT NULL DEFAULT 'metric' CHECK (unit_system IN ('metric', 'imperial')),
  temperature_unit TEXT NOT NULL DEFAULT 'celsius' CHECK (temperature_unit IN ('celsius', 'fahrenheit')),
  paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'Letter')),
  retention_settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(retention_settings_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  username TEXT COLLATE BINARY NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('workspace_owner', 'producer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK (auth_epoch > 0),
  current_password_credential_id TEXT,
  failed_login_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  backoff_until INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, username)
);

CREATE TABLE password_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  kdf TEXT NOT NULL CHECK (kdf IN ('argon2id', 'scrypt', 'pbkdf2-sha256')),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  encoded_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  superseded_at INTEGER,
  CHECK (length(encoded_hash) >= 32)
);

CREATE UNIQUE INDEX user_current_credential_unique
  ON password_credentials(user_id)
  WHERE superseded_at IS NULL;
CREATE INDEX password_credentials_workspace_user_idx
  ON password_credentials(workspace_id, user_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  device_label TEXT,
  user_agent_summary TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  revoke_reason TEXT,
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX sessions_user_active_idx
  ON sessions(workspace_id, user_id, revoked_at, absolute_expires_at);
CREATE INDEX sessions_token_hash_idx ON sessions(token_hash);

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('workspace_owner', 'producer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  project_id TEXT,
  module TEXT,
  object_type TEXT,
  object_id TEXT,
  action TEXT NOT NULL,
  field_scope TEXT,
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow', 'deny')),
  granted_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX permission_grants_subject_idx
  ON permission_grants(workspace_id, user_id, project_id, module, action, revoked_at);

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT,
  public_locator TEXT NOT NULL UNIQUE,
  secret_digest TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('viewer', 'commenter', 'approver', 'candidate', 'call_sheet_recipient')),
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL CHECK (json_valid(allowed_actions_json)),
  field_projection_json TEXT NOT NULL CHECK (json_valid(field_projection_json)),
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX share_links_scope_idx
  ON share_links(workspace_id, project_id, object_type, object_id, revoked_at, expires_at);

CREATE TABLE service_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  expires_at INTEGER,
  rotated_at INTEGER,
  revoked_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'share', 'service', 'provider', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  request_id TEXT,
  ip_prefix TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX audit_events_workspace_cursor_idx
  ON audit_events(workspace_id, created_at DESC, id DESC);
CREATE INDEX audit_events_object_idx
  ON audit_events(workspace_id, project_id, object_type, object_id, created_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT,
  recipient_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  object_type TEXT,
  object_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX notifications_inbox_idx
  ON notifications(workspace_id, recipient_user_id, read_at, created_at DESC, id DESC);

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key_digest TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, actor_fingerprint, operation, idempotency_key_digest)
);

CREATE TABLE rate_limit_buckets (
  key_digest TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  key_hash TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bootstrap_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  challenge_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('created', 'consumed', 'expired', 'failed')),
  account_manifest_hash TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

-- The service inserts an assertion using a scalar subquery for actual_version as
-- the first statement in a D1 batch, then deletes it as the final statement.
-- CHECK failure aborts the complete batch, unlike a zero-row conditional UPDATE.
CREATE TABLE optimistic_mutation_guards (
  id TEXT PRIMARY KEY,
  expected_version INTEGER NOT NULL,
  actual_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (expected_version = actual_version)
);

CREATE TABLE series (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, code)
);

CREATE TABLE seasons (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  season_number INTEGER NOT NULL CHECK (season_number > 0),
  status TEXT NOT NULL DEFAULT 'active',
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (series_id, season_number)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  series_id TEXT REFERENCES series(id) ON DELETE RESTRICT,
  season_id TEXT REFERENCES seasons(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  working_title TEXT,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idea' CHECK (phase IN ('idea', 'development', 'writing', 'planning', 'ready_to_shoot', 'shooting', 'post', 'complete', 'archived')),
  status TEXT NOT NULL DEFAULT 'active',
  company TEXT NOT NULL DEFAULT 'Sinbod Wayne',
  owner_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  logline TEXT,
  format TEXT,
  target_runtime_ms INTEGER CHECK (target_runtime_ms IS NULL OR target_runtime_ms >= 0),
  aspect_ratio TEXT,
  resolution TEXT,
  frame_rate_numerator INTEGER NOT NULL DEFAULT 24 CHECK (frame_rate_numerator > 0),
  frame_rate_denominator INTEGER NOT NULL DEFAULT 1 CHECK (frame_rate_denominator > 0),
  drop_frame INTEGER NOT NULL DEFAULT 0 CHECK (drop_frame IN (0, 1)),
  starts_on TEXT,
  ends_on TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  locale TEXT NOT NULL DEFAULT 'en-GB',
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  unit_system TEXT NOT NULL DEFAULT 'metric' CHECK (unit_system IN ('metric', 'imperial')),
  paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'Letter')),
  logo_file_id TEXT,
  key_art_file_id TEXT,
  confidentiality TEXT,
  enabled_modules_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(enabled_modules_json)),
  readiness_state TEXT NOT NULL DEFAULT 'blocked' CHECK (readiness_state IN ('blocked', 'warning', 'ready', 'stale', 'unavailable')),
  readiness_score INTEGER NOT NULL DEFAULT 0 CHECK (readiness_score BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, code)
);

CREATE INDEX projects_workspace_cursor_idx
  ON projects(workspace_id, archived_at, updated_at DESC, id DESC);
CREATE INDEX projects_hierarchy_idx ON projects(workspace_id, series_id, season_id, archived_at);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE RESTRICT,
  season_id TEXT REFERENCES seasons(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  episode_number INTEGER CHECK (episode_number IS NULL OR episode_number > 0),
  production_code TEXT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (series_id, season_id, episode_number)
);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'producer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (project_id, user_id)
);

CREATE INDEX project_memberships_user_idx
  ON project_memberships(workspace_id, user_id, status, project_id);

CREATE TABLE object_registry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  object_type TEXT NOT NULL,
  domain_table TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  title TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (domain_table, domain_id)
);

CREATE INDEX object_registry_tenant_type_idx
  ON object_registry(workspace_id, project_id, object_type, archived_at, updated_at DESC, id DESC);

CREATE TABLE object_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  source_object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  target_object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (source_object_id <> target_object_id),
  UNIQUE (source_object_id, target_object_id, relation_type)
);

CREATE INDEX object_links_source_idx ON object_links(workspace_id, project_id, source_object_id, relation_type, archived_at);
CREATE INDEX object_links_target_idx ON object_links(workspace_id, project_id, target_object_id, relation_type, archived_at);

CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  type TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  promoted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX ideas_workspace_status_idx ON ideas(workspace_id, status, archived_at, updated_at DESC, id DESC);

CREATE TABLE idea_tags (
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (idea_id, tag)
);

CREATE TABLE idea_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE project_briefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  purpose TEXT,
  creative_intent TEXT,
  target_audience TEXT,
  intended_effect TEXT,
  format_platform TEXT,
  target_duration_ms INTEGER CHECK (target_duration_ms IS NULL OR target_duration_ms >= 0),
  budget_min_minor INTEGER,
  budget_max_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX project_briefs_project_idx ON project_briefs(workspace_id, project_id, status, archived_at);

CREATE TABLE development_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL DEFAULT 'treatment',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  current_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX development_documents_project_idx
  ON development_documents(workspace_id, project_id, document_type, status, archived_at, sort_rank);

CREATE TABLE development_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  development_document_id TEXT REFERENCES development_documents(id) ON DELETE RESTRICT,
  project_brief_id TEXT REFERENCES project_briefs(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  title TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((development_document_id IS NOT NULL) <> (project_brief_id IS NOT NULL))
);

CREATE UNIQUE INDEX development_revisions_document_number_idx
  ON development_revisions(development_document_id, revision_number)
  WHERE development_document_id IS NOT NULL;
CREATE UNIQUE INDEX development_revisions_brief_number_idx
  ON development_revisions(project_brief_id, revision_number)
  WHERE project_brief_id IS NOT NULL;

CREATE TABLE outlines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outline_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  outline_id TEXT NOT NULL REFERENCES outlines(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (outline_id, revision_number)
);

CREATE TABLE beats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  outline_id TEXT NOT NULL REFERENCES outlines(id) ON DELETE RESTRICT,
  parent_beat_id TEXT REFERENCES beats(id) ON DELETE RESTRICT,
  beat_type TEXT NOT NULL CHECK (beat_type IN ('act', 'sequence', 'beat', 'card')),
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  duration_estimate_ms INTEGER CHECK (duration_estimate_ms IS NULL OR duration_estimate_ms >= 0),
  page_estimate_eighths INTEGER CHECK (page_estimate_eighths IS NULL OR page_estimate_eighths >= 0),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX beats_outline_rank_idx ON beats(project_id, outline_id, parent_beat_id, archived_at, sort_rank);

CREATE TABLE story_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT,
  chronology_rank TEXT NOT NULL,
  presentation_rank TEXT,
  story_date TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE character_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  appearance TEXT,
  wants TEXT,
  needs TEXT,
  conflict TEXT,
  backstory TEXT,
  arc TEXT,
  casting_notes TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  from_character_profile_id TEXT NOT NULL REFERENCES character_profiles(id) ON DELETE RESTRICT,
  to_character_profile_id TEXT NOT NULL REFERENCES character_profiles(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (from_character_profile_id <> to_character_profile_id)
);

CREATE TABLE world_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE research_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  source_url TEXT,
  citation TEXT,
  provenance TEXT,
  copyright_clearance_status TEXT NOT NULL DEFAULT 'review_required',
  captured_notes TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE lookbooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  kind TEXT NOT NULL DEFAULT 'lookbook' CHECK (kind IN ('lookbook', 'pitch_deck')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'changes_requested', 'rejected', 'expired', 'superseded')),
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  approver_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  pinned_version_id TEXT,
  requested_at INTEGER NOT NULL,
  due_at INTEGER,
  self_approval_allowed INTEGER NOT NULL DEFAULT 0 CHECK (self_approval_allowed IN (0, 1)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX approvals_project_status_idx ON approvals(workspace_id, project_id, status, due_at, archived_at);

CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected', 'expired', 'superseded')),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  comment TEXT,
  pinned_version_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX approval_decisions_approval_idx ON approval_decisions(approval_id, created_at, id);
