-- Uniform mutable-record contract used by the allowlisted generic module API.
-- Domain-specific required links may be completed by specialized workflows
-- before a draft can become approved/issued/ready.

PRAGMA foreign_keys = ON;

ALTER TABLE ideas ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE project_briefs ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE development_documents ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE lookbooks ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE av_scripts ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE documents ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE scene_breakdowns ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE elements ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE report_definitions ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE boards ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE storyboards ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE shot_lists ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE technical_look_plans ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE people ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE casting_roles ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE locations ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE budgets ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE requirements ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE equipment_items ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE logistics_plans ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE task_cards ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE calendar_events ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE schedules ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE shoot_days ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE files ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE call_sheet_drafts ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE production_pack_drafts ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;

ALTER TABLE folders ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE folders ADD COLUMN summary TEXT;
ALTER TABLE folders ADD COLUMN owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE folders ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json));
ALTER TABLE folders ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;

ALTER TABLE export_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE export_snapshots ADD COLUMN owner_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;
ALTER TABLE export_snapshots ADD COLUMN sort_rank TEXT NOT NULL DEFAULT 'a0';
ALTER TABLE export_snapshots ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json));
ALTER TABLE export_snapshots ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE export_snapshots ADD COLUMN archived_at INTEGER;
ALTER TABLE export_snapshots ADD COLUMN updated_at INTEGER;
ALTER TABLE export_snapshots ADD COLUMN created_by TEXT REFERENCES user_identities(id) ON DELETE RESTRICT;

CREATE TRIGGER export_snapshots_version_step
BEFORE UPDATE ON export_snapshots
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'version_step:export_snapshots');
END;

CREATE TRIGGER export_snapshots_complete_requirements
BEFORE UPDATE OF state ON export_snapshots
WHEN NEW.state = 'complete'
  AND (
    NEW.requested_by_user_id IS NULL
    OR NEW.idempotency_key IS NULL
    OR NEW.manifest_object_key IS NULL
    OR NEW.manifest_hash IS NULL
    OR NEW.body_object_key IS NULL
    OR NEW.content_hash IS NULL
    OR NEW.completed_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'incomplete:export_snapshot');
END;

