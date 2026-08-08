-- Structured writing, canonical scene graph, breakdown, elements, and reports.

PRAGMA foreign_keys = ON;

CREATE TABLE screenplays (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  current_draft_id TEXT,
  current_revision_id TEXT,
  approved_revision_id TEXT,
  numbering_locked INTEGER NOT NULL DEFAULT 0 CHECK (numbering_locked IN (0, 1)),
  frame_rate_numerator INTEGER NOT NULL DEFAULT 24 CHECK (frame_rate_numerator > 0),
  frame_rate_denominator INTEGER NOT NULL DEFAULT 1 CHECK (frame_rate_denominator > 0),
  paper_size TEXT NOT NULL DEFAULT 'A4' CHECK (paper_size IN ('A4', 'Letter')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX screenplays_project_idx ON screenplays(workspace_id, project_id, archived_at, updated_at DESC);

CREATE TABLE script_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  autosave_state TEXT NOT NULL DEFAULT 'saved' CHECK (autosave_state IN ('saved', 'saving', 'conflict', 'offline')),
  base_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE script_draft_blocks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES script_drafts(id) ON DELETE CASCADE,
  block_type TEXT NOT NULL CHECK (block_type IN ('scene_heading', 'action', 'character', 'parenthetical', 'dialogue', 'dual_dialogue', 'transition', 'shot', 'lyrics', 'page_break', 'section', 'synopsis', 'note')),
  text_content TEXT NOT NULL DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX script_draft_blocks_order_idx ON script_draft_blocks(project_id, draft_id, archived_at, sort_rank);

CREATE TABLE script_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  name TEXT NOT NULL,
  revision_color TEXT,
  notes TEXT,
  content_hash TEXT NOT NULL,
  source_format TEXT NOT NULL DEFAULT 'native' CHECK (source_format IN ('native', 'fountain', 'fdx', 'txt', 'pdf_reference')),
  import_warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(import_warnings_json)),
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  restored_from_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (screenplay_id, revision_number)
);

CREATE INDEX script_revisions_project_idx ON script_revisions(project_id, screenplay_id, revision_number DESC);

CREATE TABLE script_block_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  stable_block_id TEXT NOT NULL,
  block_type TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (script_revision_id, stable_block_id)
);

CREATE INDEX script_block_revisions_order_idx ON script_block_revisions(project_id, script_revision_id, sort_rank);

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  display_number TEXT NOT NULL,
  locked_number_key TEXT,
  current_scene_revision_id TEXT,
  slugline TEXT NOT NULL,
  synopsis TEXT,
  int_ext TEXT CHECK (int_ext IS NULL OR int_ext IN ('INT', 'EXT', 'INT_EXT', 'OTHER')),
  time_of_day TEXT,
  story_day TEXT,
  page_eighths INTEGER NOT NULL DEFAULT 0 CHECK (page_eighths >= 0),
  sort_rank TEXT NOT NULL,
  omitted INTEGER NOT NULL DEFAULT 0 CHECK (omitted IN (0, 1)),
  omission_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (screenplay_id, display_number)
);

CREATE INDEX scenes_project_order_idx ON scenes(workspace_id, project_id, screenplay_id, omitted, archived_at, sort_rank);
CREATE INDEX scenes_project_slugline_idx ON scenes(project_id, slugline, archived_at);

CREATE TABLE scene_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  source_start_block_id TEXT NOT NULL,
  source_end_block_id TEXT NOT NULL,
  display_number TEXT NOT NULL,
  slugline TEXT NOT NULL,
  synopsis TEXT,
  int_ext TEXT,
  time_of_day TEXT,
  page_eighths INTEGER NOT NULL DEFAULT 0 CHECK (page_eighths >= 0),
  sort_rank TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (scene_id, script_revision_id)
);

CREATE INDEX scene_revisions_revision_order_idx ON scene_revisions(project_id, script_revision_id, sort_rank);

CREATE TABLE script_syncs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  from_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
  to_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'needs_resolution', 'ready', 'applied', 'cancelled')),
  impact_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(impact_summary_json)),
  mapping_hash TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  applied_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  applied_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (screenplay_id, to_revision_id)
);

CREATE INDEX script_syncs_project_status_idx ON script_syncs(project_id, status, created_at DESC);

CREATE TABLE scene_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  script_sync_id TEXT NOT NULL REFERENCES script_syncs(id) ON DELETE RESTRICT,
  prior_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  candidate_scene_revision_id TEXT REFERENCES scene_revisions(id) ON DELETE RESTRICT,
  mapping_kind TEXT NOT NULL CHECK (mapping_kind IN ('added', 'matched', 'revised', 'moved', 'ambiguous', 'removed', 'split', 'merged')),
  confidence_basis_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(confidence_basis_json)),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('accept', 'remap', 'omit', 'archive', 'split', 'merge')),
  resolved_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  resolved_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  resolved_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX scene_mappings_sync_kind_idx ON scene_mappings(project_id, script_sync_id, mapping_kind, resolution);

CREATE TABLE scene_mapping_impacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_mapping_id TEXT NOT NULL REFERENCES scene_mappings(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  impact_type TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (scene_mapping_id, object_id, impact_type)
);

CREATE TABLE scene_mapping_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_mapping_id TEXT NOT NULL REFERENCES scene_mappings(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL,
  prior_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  resulting_scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE script_comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  script_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
  stable_block_id TEXT,
  range_start INTEGER,
  range_end INTEGER,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  parent_comment_id TEXT REFERENCES script_comments(id) ON DELETE RESTRICT,
  resolved_at INTEGER,
  resolved_by_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (range_start IS NULL OR range_start >= 0),
  CHECK (range_end IS NULL OR range_end >= range_start)
);

CREATE TABLE av_scripts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  template_kind TEXT NOT NULL DEFAULT 'custom' CHECK (template_kind IN ('music_video', 'commercial', 'corporate_explainer', 'documentary_interview', 'custom')),
  frame_rate_numerator INTEGER NOT NULL DEFAULT 24 CHECK (frame_rate_numerator > 0),
  frame_rate_denominator INTEGER NOT NULL DEFAULT 1 CHECK (frame_rate_denominator > 0),
  drop_frame INTEGER NOT NULL DEFAULT 0 CHECK (drop_frame IN (0, 1)),
  current_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE av_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  av_script_id TEXT NOT NULL REFERENCES av_scripts(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  content_hash TEXT NOT NULL,
  total_frames INTEGER NOT NULL DEFAULT 0 CHECK (total_frames >= 0),
  word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  restored_from_revision_id TEXT REFERENCES av_revisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (av_script_id, revision_number)
);

CREATE TABLE av_segments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  av_script_id TEXT NOT NULL REFERENCES av_scripts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE av_rows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  av_script_id TEXT NOT NULL REFERENCES av_scripts(id) ON DELETE RESTRICT,
  av_segment_id TEXT REFERENCES av_segments(id) ON DELETE RESTRICT,
  row_type TEXT NOT NULL DEFAULT 'content' CHECK (row_type IN ('content', 'banner')),
  audio TEXT,
  visual TEXT,
  dialogue_vo TEXT,
  actions TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  duration_frames INTEGER CHECK (duration_frames IS NULL OR duration_frames >= 0),
  start_frame INTEGER CHECK (start_frame IS NULL OR start_frame >= 0),
  end_frame INTEGER CHECK (end_frame IS NULL OR end_frame >= start_frame),
  sort_rank TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX av_rows_order_idx ON av_rows(project_id, av_script_id, av_segment_id, archived_at, sort_rank);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  folder_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  document_type TEXT NOT NULL DEFAULT 'general',
  current_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE document_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  restored_from_revision_id TEXT REFERENCES document_revisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (document_id, revision_number)
);

CREATE TABLE document_blocks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  document_revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE RESTRICT,
  stable_block_id TEXT NOT NULL,
  block_type TEXT NOT NULL CHECK (block_type IN ('heading', 'text', 'table', 'checklist', 'link', 'image', 'file')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (document_revision_id, stable_block_id)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  template_type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  current_version_id TEXT,
  provenance TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE template_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  schema_version TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (template_id, version_number)
);

CREATE TABLE scene_breakdowns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  source_scene_revision_id TEXT REFERENCES scene_revisions(id) ON DELETE RESTRICT,
  page_eighths INTEGER NOT NULL DEFAULT 0 CHECK (page_eighths >= 0),
  chronology_rank TEXT,
  prep_estimate_ms INTEGER NOT NULL DEFAULT 0 CHECK (prep_estimate_ms >= 0),
  shoot_estimate_ms INTEGER NOT NULL DEFAULT 0 CHECK (shoot_estimate_ms >= 0),
  readiness_state TEXT NOT NULL DEFAULT 'blocked' CHECK (readiness_state IN ('blocked', 'warning', 'ready', 'unavailable')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, scene_id)
);

CREATE INDEX scene_breakdowns_readiness_idx ON scene_breakdowns(project_id, status, readiness_state, archived_at);

CREATE TABLE breakdown_overrides (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_breakdown_id TEXT NOT NULL REFERENCES scene_breakdowns(id) ON DELETE RESTRICT,
  field_name TEXT NOT NULL,
  source_value_json TEXT CHECK (source_value_json IS NULL OR json_valid(source_value_json)),
  override_value_json TEXT NOT NULL CHECK (json_valid(override_value_json)),
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scene_breakdown_id, field_name, archived_at)
);

CREATE TABLE element_categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  color TEXT,
  icon TEXT,
  department_id TEXT,
  is_seeded INTEGER NOT NULL DEFAULT 0 CHECK (is_seeded IN (0, 1)),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, project_id, code)
);

CREATE TABLE elements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES element_categories(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'identified',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  department_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  procurement_status TEXT,
  cost_minor INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  continuity_notes TEXT,
  prep_notes TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX elements_project_category_idx ON elements(project_id, category_id, status, archived_at, sort_rank);

CREATE TABLE element_aliases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  alias TEXT COLLATE NOCASE NOT NULL,
  provenance TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, alias)
);

CREATE TABLE scene_element_tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('script_range', 'manual', 'implied')),
  source_revision_id TEXT REFERENCES script_revisions(id) ON DELETE RESTRICT,
  source_start_block_id TEXT,
  source_end_block_id TEXT,
  range_start INTEGER,
  range_end INTEGER,
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX scene_element_tags_scene_idx ON scene_element_tags(project_id, scene_id, archived_at, element_id);
CREATE INDEX scene_element_tags_element_idx ON scene_element_tags(project_id, element_id, archived_at, scene_id);

CREATE TABLE tag_source_ranges (
  id TEXT PRIMARY KEY,
  scene_element_tag_id TEXT NOT NULL REFERENCES scene_element_tags(id) ON DELETE RESTRICT,
  script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  start_block_id TEXT NOT NULL,
  end_block_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  created_at INTEGER NOT NULL
);

CREATE TABLE element_merges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  target_element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (source_element_id <> target_element_id),
  UNIQUE (project_id, idempotency_key)
);

CREATE TABLE reference_redirects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  object_type TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  merge_id TEXT REFERENCES element_merges(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (source_object_id <> target_object_id),
  UNIQUE (object_type, source_object_id)
);

CREATE TABLE procurement_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  element_id TEXT NOT NULL REFERENCES elements(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needed',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  source_type TEXT NOT NULL CHECK (source_type IN ('owned', 'borrowed', 'rented', 'made', 'buy')),
  vendor_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  size_measurements_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(size_measurements_json)),
  fitting_test_at INTEGER,
  cost_minor INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE report_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  report_type TEXT NOT NULL DEFAULT 'custom',
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE report_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  report_definition_id TEXT REFERENCES report_definitions(id) ON DELETE RESTRICT,
  report_type TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  title TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  content_hash TEXT NOT NULL,
  r2_object_key TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, report_type, issue_number)
);

CREATE TABLE report_snapshot_items (
  id TEXT PRIMARY KEY,
  report_snapshot_id TEXT NOT NULL REFERENCES report_snapshots(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  pinned_revision_or_version_id TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (report_snapshot_id, object_id, pinned_revision_or_version_id)
);

CREATE TABLE sides_issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  screenplay_id TEXT NOT NULL REFERENCES screenplays(id) ON DELETE RESTRICT,
  script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  title TEXT NOT NULL,
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  presentation_json TEXT NOT NULL CHECK (json_valid(presentation_json)),
  content_hash TEXT NOT NULL,
  r2_object_key TEXT,
  supersedes_issue_id TEXT REFERENCES sides_issues(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, issue_number)
);

CREATE TABLE sides_issue_scenes (
  sides_issue_id TEXT NOT NULL REFERENCES sides_issues(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  scene_revision_id TEXT NOT NULL REFERENCES scene_revisions(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL,
  PRIMARY KEY (sides_issue_id, scene_id)
);

CREATE TABLE sides_issue_characters (
  sides_issue_id TEXT NOT NULL REFERENCES sides_issues(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL,
  highlight INTEGER NOT NULL DEFAULT 0 CHECK (highlight IN (0, 1)),
  PRIMARY KEY (sides_issue_id, character_id)
);
