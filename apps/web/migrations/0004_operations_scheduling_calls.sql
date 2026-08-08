-- Collaboration, tasks, calendars, immutable schedule revisions, shoot days,
-- conflicts, call sheets, delivery evidence, and production packs.

PRAGMA foreign_keys = ON;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  author_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  share_link_id TEXT REFERENCES share_links(id) ON DELETE RESTRICT,
  parent_comment_id TEXT REFERENCES comments(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  resolved_at INTEGER,
  resolved_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((author_user_id IS NOT NULL) <> (share_link_id IS NOT NULL))
);

CREATE INDEX comments_object_thread_idx ON comments(workspace_id, project_id, object_id, parent_comment_id, archived_at, created_at, id);

CREATE TABLE mentions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE RESTRICT,
  mentioned_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (comment_id, mentioned_user_id)
);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  verb TEXT NOT NULL,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  secondary_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX activities_project_cursor_idx ON activities(workspace_id, project_id, created_at DESC, id DESC);

CREATE TABLE task_boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_columns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status_key TEXT NOT NULL,
  wip_limit INTEGER CHECK (wip_limit IS NULL OR wip_limit > 0),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_board_id, status_key)
);

CREATE TABLE task_cards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_board_id TEXT REFERENCES task_boards(id) ON DELETE RESTRICT,
  task_column_id TEXT REFERENCES task_columns(id) ON DELETE RESTRICT,
  linked_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  starts_at INTEGER,
  due_at INTEGER,
  timezone TEXT,
  estimate_ms INTEGER CHECK (estimate_ms IS NULL OR estimate_ms >= 0),
  is_blocking INTEGER NOT NULL DEFAULT 0 CHECK (is_blocking IN (0, 1)),
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX task_cards_board_order_idx ON task_cards(project_id, task_board_id, task_column_id, archived_at, sort_rank);
CREATE INDEX task_cards_due_idx ON task_cards(project_id, status, is_blocking DESC, due_at, archived_at);

CREATE TABLE task_assignees (
  task_card_id TEXT NOT NULL REFERENCES task_cards(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (task_card_id, user_id, person_id),
  CHECK ((user_id IS NOT NULL) <> (person_id IS NOT NULL))
);

CREATE TABLE checklists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_card_id TEXT NOT NULL REFERENCES task_cards(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_at INTEGER,
  completed_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  predecessor_task_id TEXT NOT NULL REFERENCES task_cards(id) ON DELETE RESTRICT,
  successor_task_id TEXT NOT NULL REFERENCES task_cards(id) ON DELETE RESTRICT,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start',
  lag_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (predecessor_task_id <> successor_task_id),
  UNIQUE (predecessor_task_id, successor_task_id)
);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  timezone TEXT NOT NULL,
  current_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE calendar_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  name TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (calendar_id, revision_number)
);

CREATE TABLE calendar_rows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  parent_row_id TEXT REFERENCES calendar_rows(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  color TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  calendar_id TEXT REFERENCES calendars(id) ON DELETE RESTRICT,
  calendar_row_id TEXT REFERENCES calendar_rows(id) ON DELETE RESTRICT,
  linked_object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  event_type TEXT NOT NULL DEFAULT 'event',
  starts_at INTEGER,
  ends_at INTEGER,
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  color TEXT,
  ics_uid TEXT,
  ics_sequence INTEGER NOT NULL DEFAULT 0 CHECK (ics_sequence >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  UNIQUE (project_id, ics_uid)
);

CREATE INDEX calendar_events_time_idx ON calendar_events(project_id, starts_at, ends_at, archived_at);

CREATE TABLE event_assignees (
  calendar_event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  PRIMARY KEY (calendar_event_id, user_id, person_id),
  CHECK ((user_id IS NOT NULL) <> (person_id IS NOT NULL))
);

CREATE TABLE event_dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  predecessor_event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE RESTRICT,
  successor_event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE RESTRICT,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start',
  lag_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK (predecessor_event_id <> successor_event_id),
  UNIQUE (predecessor_event_id, successor_event_id)
);

CREATE TABLE working_days (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_local TEXT,
  ends_local TEXT,
  is_working INTEGER NOT NULL DEFAULT 1 CHECK (is_working IN (0, 1)),
  UNIQUE (calendar_id, weekday)
);

CREATE TABLE holidays (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE RESTRICT,
  local_date TEXT NOT NULL,
  title TEXT NOT NULL,
  is_working INTEGER NOT NULL DEFAULT 0 CHECK (is_working IN (0, 1)),
  UNIQUE (calendar_id, local_date)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  current_revision_id TEXT,
  approved_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX schedules_one_default_idx ON schedules(project_id) WHERE is_default = 1 AND archived_at IS NULL;

CREATE TABLE schedule_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  name TEXT NOT NULL,
  source_script_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  content_hash TEXT NOT NULL,
  totals_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(totals_json)),
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (schedule_id, revision_number)
);

CREATE TABLE scene_segments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  segment_number TEXT NOT NULL,
  page_eighths INTEGER NOT NULL DEFAULT 0 CHECK (page_eighths >= 0),
  prep_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (prep_duration_ms >= 0),
  shoot_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (shoot_duration_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scene_id, segment_number)
);

CREATE TABLE schedule_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schedule_revision_id TEXT NOT NULL REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  item_type TEXT NOT NULL CHECK (item_type IN ('scene', 'scene_segment', 'day_break', 'meal', 'company_move', 'banner', 'rehearsal', 'pickup_dropoff', 'note')),
  scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  scene_segment_id TEXT REFERENCES scene_segments(id) ON DELETE RESTRICT,
  title TEXT,
  shoot_date TEXT,
  unit TEXT,
  day_count INTEGER CHECK (day_count IS NULL OR day_count > 0),
  general_call_local TEXT,
  estimated_start_local TEXT,
  estimated_wrap_local TEXT,
  timezone TEXT,
  location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  page_eighths INTEGER NOT NULL DEFAULT 0 CHECK (page_eighths >= 0),
  prep_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (prep_duration_ms >= 0),
  setup_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (setup_duration_ms >= 0),
  shoot_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (shoot_duration_ms >= 0),
  move_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (move_duration_ms >= 0),
  hard_constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hard_constraints_json)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (item_type = 'scene' AND scene_id IS NOT NULL AND scene_segment_id IS NULL)
    OR (item_type = 'scene_segment' AND scene_id IS NOT NULL AND scene_segment_id IS NOT NULL)
    OR (item_type NOT IN ('scene', 'scene_segment') AND scene_id IS NULL AND scene_segment_id IS NULL)
  )
);

CREATE INDEX schedule_items_order_idx ON schedule_items(project_id, schedule_revision_id, sort_rank);
CREATE INDEX schedule_items_scene_idx ON schedule_items(project_id, scene_id, schedule_revision_id);

CREATE TABLE shoot_days (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schedule_revision_id TEXT REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  shoot_date TEXT,
  unit TEXT NOT NULL DEFAULT 'Main',
  day_count INTEGER NOT NULL DEFAULT 1 CHECK (day_count > 0),
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  general_call_at INTEGER,
  estimated_start_at INTEGER,
  estimated_wrap_at INTEGER,
  base_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  primary_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  hard_constraints_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hard_constraints_json)),
  readiness_state TEXT NOT NULL DEFAULT 'blocked' CHECK (readiness_state IN ('blocked', 'warning', 'ready', 'stale', 'unavailable')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (schedule_revision_id, unit, day_count)
);

CREATE INDEX shoot_days_project_date_idx ON shoot_days(project_id, shoot_date, unit, archived_at);

CREATE TABLE resource_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  schedule_revision_id TEXT NOT NULL REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('cast', 'crew', 'location', 'equipment', 'travel', 'turnaround', 'availability', 'legal_safety')),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'blocker')),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'overridden', 'superseded')),
  fingerprint TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL,
  UNIQUE (schedule_revision_id, fingerprint)
);

CREATE INDEX resource_conflicts_day_idx ON resource_conflicts(project_id, shoot_day_id, resource_type, resource_id, severity, status);

CREATE TABLE conflict_resources (
  resource_conflict_id TEXT NOT NULL REFERENCES resource_conflicts(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  PRIMARY KEY (resource_conflict_id, object_id, role)
);

CREATE TABLE conflict_resolutions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  resource_conflict_id TEXT NOT NULL REFERENCES resource_conflicts(id) ON DELETE RESTRICT,
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'overridden')),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE call_sheet_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  source_schedule_revision_id TEXT REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  call_sheet_type TEXT NOT NULL DEFAULT 'shoot_day' CHECK (call_sheet_type IN ('shoot_day', 'scout', 'rehearsal', 'fitting_test', 'custom')),
  issue_number_next INTEGER NOT NULL DEFAULT 1 CHECK (issue_number_next > 0),
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'Letter')),
  layout TEXT NOT NULL DEFAULT 'standard' CHECK (layout IN ('standard', 'compact')),
  manual_weather_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(manual_weather_json)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE call_sheet_sections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_draft_id TEXT NOT NULL REFERENCES call_sheet_drafts(id) ON DELETE RESTRICT,
  section_type TEXT NOT NULL,
  title TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  columns_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(columns_json)),
  body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body_json)),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE call_sheet_recipients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_draft_id TEXT NOT NULL REFERENCES call_sheet_drafts(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  label TEXT,
  private_note TEXT,
  required_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (required_confirmation IN (0, 1)),
  recipient_projection_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(recipient_projection_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (call_sheet_draft_id, person_id)
);

CREATE TABLE call_sheet_person_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_draft_id TEXT NOT NULL REFERENCES call_sheet_drafts(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  call_type TEXT NOT NULL,
  call_at INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE call_sheet_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_draft_id TEXT NOT NULL REFERENCES call_sheet_drafts(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  source_schedule_revision_id TEXT REFERENCES schedule_revisions(id) ON DELETE RESTRICT,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  title TEXT NOT NULL,
  confidentiality_marking TEXT,
  canonical_snapshot_json TEXT NOT NULL CHECK (json_valid(canonical_snapshot_json)),
  content_hash TEXT NOT NULL,
  r2_object_key TEXT,
  supersedes_issue_id TEXT REFERENCES call_sheet_issues(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (call_sheet_draft_id, issue_number)
);

CREATE TABLE call_sheet_recipient_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_issue_id TEXT NOT NULL REFERENCES call_sheet_issues(id) ON DELETE RESTRICT,
  call_sheet_recipient_id TEXT NOT NULL REFERENCES call_sheet_recipients(id) ON DELETE RESTRICT,
  share_link_id TEXT REFERENCES share_links(id) ON DELETE RESTRICT,
  variant_snapshot_json TEXT NOT NULL CHECK (json_valid(variant_snapshot_json)),
  content_hash TEXT NOT NULL,
  r2_object_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (call_sheet_issue_id, call_sheet_recipient_id)
);

CREATE TABLE delivery_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_recipient_issue_id TEXT REFERENCES call_sheet_recipient_issues(id) ON DELETE RESTRICT,
  outbox_entry_id TEXT REFERENCES outbox_entries(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('issued', 'link_copied', 'downloaded', 'viewed', 'provider_accepted', 'provider_delivered', 'provider_failed', 'not_configured')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  idempotency_key TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((call_sheet_recipient_issue_id IS NOT NULL) OR (outbox_entry_id IS NOT NULL))
);

CREATE UNIQUE INDEX delivery_events_idempotency_idx ON delivery_events(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE confirmations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  call_sheet_recipient_issue_id TEXT NOT NULL REFERENCES call_sheet_recipient_issues(id) ON DELETE RESTRICT,
  confirmed_by_type TEXT NOT NULL CHECK (confirmed_by_type IN ('recipient', 'producer_manual')),
  confirmed_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  share_link_id TEXT REFERENCES share_links(id) ON DELETE RESTRICT,
  note TEXT,
  idempotency_key TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (
    (confirmed_by_type = 'recipient' AND share_link_id IS NOT NULL AND confirmed_by_user_id IS NULL)
    OR (confirmed_by_type = 'producer_manual' AND confirmed_by_user_id IS NOT NULL AND share_link_id IS NULL)
  ),
  UNIQUE (call_sheet_recipient_issue_id, idempotency_key)
);

CREATE TABLE production_pack_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shoot_day_id TEXT REFERENCES shoot_days(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'Letter')),
  confidentiality_marking TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE production_pack_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  production_pack_draft_id TEXT NOT NULL REFERENCES production_pack_drafts(id) ON DELETE RESTRICT,
  object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  file_version_id TEXT,
  revision_or_issue_id TEXT,
  section_type TEXT NOT NULL,
  title TEXT NOT NULL,
  include_file INTEGER NOT NULL DEFAULT 1 CHECK (include_file IN (0, 1)),
  permission_scope TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE production_pack_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  production_pack_draft_id TEXT NOT NULL REFERENCES production_pack_drafts(id) ON DELETE RESTRICT,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  title TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL,
  r2_object_key TEXT,
  supersedes_issue_id TEXT REFERENCES production_pack_issues(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (production_pack_draft_id, issue_number)
);

CREATE TABLE production_pack_manifest_items (
  id TEXT PRIMARY KEY,
  production_pack_issue_id TEXT NOT NULL REFERENCES production_pack_issues(id) ON DELETE RESTRICT,
  object_id TEXT REFERENCES object_registry(id) ON DELETE RESTRICT,
  file_version_id TEXT,
  revision_or_issue_id TEXT,
  relative_path TEXT NOT NULL,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256 TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (production_pack_issue_id, relative_path)
);
