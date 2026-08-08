-- Contacts, casting, communications, locations, scouts, boards, storyboards,
-- shots, setups, and technical look planning.

PRAGMA foreign_keys = ON;

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  color TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, project_id, code)
);

CREATE TABLE role_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  department_id TEXT REFERENCES departments(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  is_cast_role INTEGER NOT NULL DEFAULT 0 CHECK (is_cast_role IN (0, 1)),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, project_id, code)
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  given_name TEXT,
  family_name TEXT,
  pronouns TEXT,
  photo_file_id TEXT,
  representation_company TEXT,
  provenance TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  retention_review_at INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX people_workspace_name_idx ON people(workspace_id, archived_at, family_name, given_name, id);
CREATE INDEX people_project_status_idx ON people(workspace_id, project_id, status, archived_at, updated_at DESC);

CREATE TABLE contact_points (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('email', 'phone', 'website', 'social')),
  label TEXT,
  value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  consent_status TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX contact_points_person_idx ON contact_points(workspace_id, person_id, type, archived_at);

CREATE TABLE person_addresses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  label TEXT,
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE person_sensitive_details (
  person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  dietary_notes TEXT,
  accessibility_notes TEXT,
  medical_notes TEXT,
  private_notes TEXT,
  access_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(access_policy_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE emergency_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT NOT NULL,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE person_project_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  department_id TEXT REFERENCES departments(id) ON DELETE RESTRICT,
  role_definition_id TEXT REFERENCES role_definitions(id) ON DELETE RESTRICT,
  job_title TEXT NOT NULL,
  booking_status TEXT NOT NULL DEFAULT 'proposed',
  starts_on TEXT,
  ends_on TEXT,
  availability_status TEXT,
  rate_minor INTEGER CHECK (rate_minor IS NULL OR rate_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  rate_unit TEXT,
  overtime_terms TEXT,
  deal_memo_status TEXT,
  cast_id TEXT,
  confirmation_status TEXT NOT NULL DEFAULT 'unconfirmed',
  private_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX person_project_roles_project_idx ON person_project_roles(project_id, department_id, booking_status, archived_at);
CREATE INDEX person_project_roles_person_idx ON person_project_roles(workspace_id, person_id, project_id, archived_at);

CREATE TABLE availability (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL DEFAULT 'person',
  resource_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'unavailable', 'tentative', 'hold')),
  timezone TEXT NOT NULL,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX availability_resource_time_idx ON availability(project_id, resource_type, resource_id, starts_at, ends_at, archived_at);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  character_profile_id TEXT REFERENCES character_profiles(id) ON DELETE RESTRICT,
  screenplay_id TEXT REFERENCES screenplays(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  speaking INTEGER NOT NULL DEFAULT 1 CHECK (speaking IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'proposed',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, normalized_name)
);

CREATE TABLE cast_assignments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  casting_role_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  confirmed_at INTEGER,
  agreement_requirement_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, character_id, person_id)
);

CREATE TABLE contact_lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE contact_list_members (
  contact_list_id TEXT NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (contact_list_id, person_id)
);

CREATE TABLE contact_imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  source_file_version_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('preview', 'applied', 'cancelled', 'failed')),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE TABLE contact_merge_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  target_person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (source_person_id <> target_person_id)
);

CREATE TABLE casting_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  character_id TEXT REFERENCES characters(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  playing_age TEXT,
  appearance TEXT,
  required_skills TEXT,
  special_requirements TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  casting_role_id TEXT NOT NULL REFERENCES casting_roles(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'shortlist', 'callback', 'hold', 'offer', 'booked', 'released', 'rejected', 'withdrawn')),
  source TEXT,
  reel_links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reel_links_json)),
  private_notes TEXT,
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  retention_review_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (casting_role_id, person_id)
);

CREATE TABLE candidate_media (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL CHECK (media_type IN ('headshot', 'resume', 'reel', 'other')),
  file_version_id TEXT,
  external_url TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((file_version_id IS NOT NULL) <> (external_url IS NOT NULL))
);

CREATE TABLE auditions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  casting_role_id TEXT NOT NULL REFERENCES casting_roles(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  starts_at INTEGER,
  ends_at INTEGER,
  timezone TEXT NOT NULL,
  location_or_link TEXT,
  instructions TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE audition_slots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  audition_id TEXT NOT NULL REFERENCES auditions(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  attendance_state TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE candidate_ratings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  criteria_version TEXT NOT NULL,
  ratings_json TEXT NOT NULL CHECK (json_valid(ratings_json)),
  private_notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (candidate_id, actor_user_id, criteria_version)
);

CREATE TABLE candidate_status_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  message_type TEXT NOT NULL DEFAULT 'direct' CHECK (message_type IN ('direct', 'provider_outbox', 'manual_log')),
  sender_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  body TEXT NOT NULL DEFAULT '',
  provider TEXT,
  provider_evidence_json TEXT CHECK (provider_evidence_json IS NULL OR json_valid(provider_evidence_json)),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE message_participants (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  participant_role TEXT NOT NULL CHECK (participant_role IN ('to', 'cc', 'bcc')),
  read_at INTEGER,
  PRIMARY KEY (message_id, participant_role, user_id, person_id),
  CHECK ((user_id IS NOT NULL) <> (person_id IS NOT NULL))
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  template_type TEXT NOT NULL,
  title TEXT NOT NULL,
  subject_template TEXT,
  body_template TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outbox_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('email', 'sms', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'not_configured', 'sent', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_evidence_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE announcement_receipts (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  address_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(address_json)),
  latitude REAL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude REAL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  map_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
  fee_minor INTEGER CHECK (fee_minor IS NULL OR fee_minor >= 0),
  deposit_minor INTEGER CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EUR' CHECK (length(currency) = 3),
  availability_state TEXT NOT NULL DEFAULT 'unknown',
  legal_state TEXT NOT NULL DEFAULT 'unknown',
  safety_state TEXT NOT NULL DEFAULT 'unknown',
  approval_state TEXT NOT NULL DEFAULT 'requested',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX locations_project_status_idx ON locations(project_id, status, approval_state, archived_at, sort_rank);

CREATE TABLE sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE location_set_links (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE RESTRICT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (location_id, set_id)
);

CREATE TABLE location_contacts (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  PRIMARY KEY (location_id, person_id, role)
);

CREATE TABLE location_availability (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available', 'unavailable', 'hold', 'confirmed')),
  timezone TEXT NOT NULL,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX location_availability_time_idx ON location_availability(project_id, location_id, starts_at, ends_at, archived_at);

CREATE TABLE location_holds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'held', 'confirmed', 'released')),
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE location_scene_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  set_id TEXT REFERENCES sets(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (location_id, scene_id, set_id)
);

CREATE INDEX location_scene_links_scene_idx ON location_scene_links(project_id, scene_id, archived_at, location_id);

CREATE TABLE scout_visits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  visited_at INTEGER,
  timezone TEXT NOT NULL,
  notes TEXT,
  decision TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE scout_attendees (
  scout_visit_id TEXT NOT NULL REFERENCES scout_visits(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  PRIMARY KEY (scout_visit_id, person_id)
);

CREATE TABLE scout_media_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scout_visit_id TEXT NOT NULL REFERENCES scout_visits(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1 CHECK (version_number > 0),
  sort_rank TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (scout_visit_id, version_number, title)
);

CREATE TABLE scout_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  scout_visit_id TEXT NOT NULL REFERENCES scout_visits(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
  actor_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE location_facilities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  facility_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE location_technical_details (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  power_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(power_json)),
  sound_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sound_json)),
  light_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(light_json)),
  rigging_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rigging_json)),
  restrictions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(restrictions_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE location_hazards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL,
  control_summary TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE location_emergency_details (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  nearest_hospital TEXT,
  emergency_services TEXT,
  emergency_contacts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(emergency_contacts_json)),
  evacuation_route TEXT,
  assembly_point TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  board_type TEXT NOT NULL DEFAULT 'mood_board' CHECK (board_type IN ('mood_board', 'look_board', 'reference_board')),
  layout TEXT NOT NULL DEFAULT 'masonry',
  background TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE board_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  layout TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE board_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  board_group_id TEXT REFERENCES board_groups(id) ON DELETE RESTRICT,
  item_type TEXT NOT NULL CHECK (item_type IN ('image', 'text', 'file', 'link')),
  title TEXT,
  caption TEXT,
  file_version_id TEXT,
  external_url TEXT,
  crop_adjustment_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(crop_adjustment_json)),
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX board_items_order_idx ON board_items(project_id, board_id, board_group_id, archived_at, sort_rank);

CREATE TABLE board_item_links (
  board_item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  PRIMARY KEY (board_item_id, object_id, relation_type)
);

CREATE TABLE annotation_layers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  file_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  annotation_layer_id TEXT NOT NULL REFERENCES annotation_layers(id) ON DELETE RESTRICT,
  annotation_type TEXT NOT NULL CHECK (annotation_type IN ('text', 'shape', 'arrow', 'freehand')),
  geometry_json TEXT NOT NULL CHECK (json_valid(geometry_json)),
  style_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json)),
  content TEXT,
  sort_rank TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE storyboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  grouping_mode TEXT NOT NULL DEFAULT 'scene' CHECK (grouping_mode IN ('scene', 'sequence', 'custom')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE storyboard_frames (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE RESTRICT,
  scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  file_version_id TEXT,
  display_number TEXT,
  shot_number TEXT,
  aspect_ratio TEXT,
  framing TEXT,
  lens TEXT,
  movement TEXT,
  camera TEXT,
  frame_rate_numerator INTEGER CHECK (frame_rate_numerator IS NULL OR frame_rate_numerator > 0),
  frame_rate_denominator INTEGER CHECK (frame_rate_denominator IS NULL OR frame_rate_denominator > 0),
  duration_frames INTEGER CHECK (duration_frames IS NULL OR duration_frames >= 0),
  location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  time_of_day TEXT,
  visual_description TEXT,
  audio_dialogue TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX storyboard_frames_order_idx ON storyboard_frames(project_id, storyboard_id, scene_id, archived_at, sort_rank);

CREATE TABLE storyboard_frame_links (
  storyboard_frame_id TEXT NOT NULL REFERENCES storyboard_frames(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  PRIMARY KEY (storyboard_frame_id, object_id, relation_type)
);

CREATE TABLE shot_lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  grouping_mode TEXT NOT NULL DEFAULT 'scene',
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE shot_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shot_list_id TEXT NOT NULL REFERENCES shot_lists(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  group_type TEXT NOT NULL,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE camera_setups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  camera_body TEXT,
  lens_plan TEXT,
  support TEXT,
  lighting_plan TEXT,
  grip_power TEXT,
  sound_playback TEXT,
  setup_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (setup_duration_ms >= 0),
  move_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (move_duration_ms >= 0),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shot_list_id TEXT NOT NULL REFERENCES shot_lists(id) ON DELETE RESTRICT,
  shot_group_id TEXT REFERENCES shot_groups(id) ON DELETE RESTRICT,
  scene_id TEXT REFERENCES scenes(id) ON DELETE RESTRICT,
  camera_setup_id TEXT REFERENCES camera_setups(id) ON DELETE RESTRICT,
  location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  display_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  shot_size TEXT,
  angle_type TEXT,
  subject TEXT,
  movement TEXT,
  lens_focal_length TEXT,
  aperture_filters TEXT,
  frame_rate_numerator INTEGER CHECK (frame_rate_numerator IS NULL OR frame_rate_numerator > 0),
  frame_rate_denominator INTEGER CHECK (frame_rate_denominator IS NULL OR frame_rate_denominator > 0),
  camera TEXT,
  aspect_ratio TEXT,
  sound_notes TEXT,
  vfx_sfx_notes TEXT,
  prep_estimate_ms INTEGER NOT NULL DEFAULT 0 CHECK (prep_estimate_ms >= 0),
  shoot_estimate_ms INTEGER NOT NULL DEFAULT 0 CHECK (shoot_estimate_ms >= 0),
  priority TEXT NOT NULL DEFAULT 'normal',
  coverage_purpose TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  color TEXT,
  notes TEXT,
  risk_requirements TEXT,
  image_file_version_id TEXT,
  sort_rank TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (shot_list_id, display_number)
);

CREATE INDEX shots_scene_order_idx ON shots(project_id, scene_id, archived_at, sort_rank);
CREATE INDEX shots_setup_order_idx ON shots(project_id, camera_setup_id, archived_at, sort_rank);

CREATE TABLE shot_source_ranges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  script_revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE RESTRICT,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE RESTRICT,
  start_block_id TEXT NOT NULL,
  end_block_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  created_at INTEGER NOT NULL
);

CREATE TABLE shot_object_links (
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES object_registry(id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL,
  PRIMARY KEY (shot_id, object_id, relation_type)
);

CREATE TABLE frame_shot_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  storyboard_frame_id TEXT NOT NULL REFERENCES storyboard_frames(id) ON DELETE RESTRICT,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE RESTRICT,
  provenance TEXT NOT NULL CHECK (provenance IN ('created_from_frame', 'linked_existing')),
  created_by_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (storyboard_frame_id, shot_id)
);

CREATE TABLE setup_equipment (
  camera_setup_id TEXT NOT NULL REFERENCES camera_setups(id) ON DELETE RESTRICT,
  equipment_item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (camera_setup_id, equipment_item_id)
);

CREATE TABLE setup_people (
  camera_setup_id TEXT NOT NULL REFERENCES camera_setups(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  responsibility TEXT,
  PRIMARY KEY (camera_setup_id, person_id)
);

CREATE TABLE setup_files (
  camera_setup_id TEXT NOT NULL REFERENCES camera_setups(id) ON DELETE RESTRICT,
  file_version_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  PRIMARY KEY (camera_setup_id, file_version_id, purpose)
);

CREATE TABLE technical_look_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT,
  owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  sort_rank TEXT NOT NULL DEFAULT 'a0',
  camera_format TEXT,
  resolution TEXT,
  codec_notes TEXT,
  frame_rate_numerator INTEGER NOT NULL DEFAULT 24 CHECK (frame_rate_numerator > 0),
  frame_rate_denominator INTEGER NOT NULL DEFAULT 1 CHECK (frame_rate_denominator > 0),
  shutter_convention TEXT,
  aspect_ratio TEXT,
  lens_strategy TEXT,
  filtration TEXT,
  movement_language TEXT,
  color_pipeline TEXT,
  lighting_philosophy TEXT,
  sound_approach TEXT,
  vfx_methodology TEXT,
  delivery_framing_notes TEXT,
  current_revision_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE technical_look_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  technical_look_plan_id TEXT NOT NULL REFERENCES technical_look_plans(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  content_hash TEXT NOT NULL,
  author_user_id TEXT NOT NULL REFERENCES user_identities(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  UNIQUE (technical_look_plan_id, revision_number)
);
