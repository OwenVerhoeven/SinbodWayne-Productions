-- Database-level invariants. Optimistic writes use optimistic_mutation_guards in
-- the same D1 batch; version-step triggers reject bypasses. Immutable artifacts
-- are superseded by new rows and may not be rewritten or deleted.

PRAGMA foreign_keys = ON;

-- Tenant consistency for the common object graph, which is the attachment point
-- for comments, files, tasks, approvals, shares, activities, and readiness.
CREATE TRIGGER object_registry_project_tenant_insert
BEFORE INSERT ON object_registry
WHEN NEW.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant_mismatch:object_registry');
END;

CREATE TRIGGER object_registry_project_tenant_update
BEFORE UPDATE ON object_registry
WHEN NEW.project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant_mismatch:object_registry');
END;

CREATE TRIGGER object_links_tenant_insert
BEFORE INSERT ON object_links
WHEN NOT EXISTS (
  SELECT 1
  FROM object_registry s
  JOIN object_registry t ON t.id = NEW.target_object_id
  WHERE s.id = NEW.source_object_id
    AND s.workspace_id = NEW.workspace_id
    AND t.workspace_id = NEW.workspace_id
    AND s.project_id IS NEW.project_id
    AND t.project_id IS NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_mismatch:object_links');
END;

CREATE TRIGGER project_memberships_tenant_insert
BEFORE INSERT ON project_memberships
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  JOIN user_identities u ON u.id = NEW.user_id
  WHERE p.id = NEW.project_id
    AND p.workspace_id = NEW.workspace_id
    AND u.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_mismatch:project_memberships');
END;

-- Mutable aggregate roots and module records must advance exactly one version.
CREATE TRIGGER workspaces_version_step BEFORE UPDATE ON workspaces
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:workspaces'); END;
CREATE TRIGGER user_identities_version_step BEFORE UPDATE ON user_identities
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:user_identities'); END;
CREATE TRIGGER workspace_memberships_version_step BEFORE UPDATE ON workspace_memberships
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:workspace_memberships'); END;
CREATE TRIGGER project_memberships_version_step BEFORE UPDATE ON project_memberships
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:project_memberships'); END;
CREATE TRIGGER projects_version_step BEFORE UPDATE ON projects
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:projects'); END;
CREATE TRIGGER object_registry_version_step BEFORE UPDATE ON object_registry
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:object_registry'); END;
CREATE TRIGGER ideas_version_step BEFORE UPDATE ON ideas
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:ideas'); END;
CREATE TRIGGER project_briefs_version_step BEFORE UPDATE ON project_briefs
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:project_briefs'); END;
CREATE TRIGGER development_documents_version_step BEFORE UPDATE ON development_documents
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:development_documents'); END;
CREATE TRIGGER lookbooks_version_step BEFORE UPDATE ON lookbooks
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:lookbooks'); END;
CREATE TRIGGER approvals_version_step BEFORE UPDATE ON approvals
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:approvals'); END;
CREATE TRIGGER screenplays_version_step BEFORE UPDATE ON screenplays
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:screenplays'); END;
CREATE TRIGGER script_drafts_version_step BEFORE UPDATE ON script_drafts
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:script_drafts'); END;
CREATE TRIGGER scenes_version_step BEFORE UPDATE ON scenes
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:scenes'); END;
CREATE TRIGGER script_syncs_version_step BEFORE UPDATE ON script_syncs
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:script_syncs'); END;
CREATE TRIGGER av_scripts_version_step BEFORE UPDATE ON av_scripts
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:av_scripts'); END;
CREATE TRIGGER documents_version_step BEFORE UPDATE ON documents
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:documents'); END;
CREATE TRIGGER templates_version_step BEFORE UPDATE ON templates
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:templates'); END;
CREATE TRIGGER scene_breakdowns_version_step BEFORE UPDATE ON scene_breakdowns
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:scene_breakdowns'); END;
CREATE TRIGGER elements_version_step BEFORE UPDATE ON elements
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:elements'); END;
CREATE TRIGGER report_definitions_version_step BEFORE UPDATE ON report_definitions
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:report_definitions'); END;
CREATE TRIGGER boards_version_step BEFORE UPDATE ON boards
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:boards'); END;
CREATE TRIGGER storyboards_version_step BEFORE UPDATE ON storyboards
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:storyboards'); END;
CREATE TRIGGER shot_lists_version_step BEFORE UPDATE ON shot_lists
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:shot_lists'); END;
CREATE TRIGGER technical_look_plans_version_step BEFORE UPDATE ON technical_look_plans
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:technical_look_plans'); END;
CREATE TRIGGER people_version_step BEFORE UPDATE ON people
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:people'); END;
CREATE TRIGGER casting_roles_version_step BEFORE UPDATE ON casting_roles
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:casting_roles'); END;
CREATE TRIGGER locations_version_step BEFORE UPDATE ON locations
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:locations'); END;
CREATE TRIGGER budgets_version_step BEFORE UPDATE ON budgets
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:budgets'); END;
CREATE TRIGGER requirements_version_step BEFORE UPDATE ON requirements
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:requirements'); END;
CREATE TRIGGER risk_assessments_version_step BEFORE UPDATE ON risk_assessments
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:risk_assessments'); END;
CREATE TRIGGER equipment_items_version_step BEFORE UPDATE ON equipment_items
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:equipment_items'); END;
CREATE TRIGGER logistics_plans_version_step BEFORE UPDATE ON logistics_plans
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:logistics_plans'); END;
CREATE TRIGGER task_cards_version_step BEFORE UPDATE ON task_cards
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:task_cards'); END;
CREATE TRIGGER calendar_events_version_step BEFORE UPDATE ON calendar_events
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:calendar_events'); END;
CREATE TRIGGER schedules_version_step BEFORE UPDATE ON schedules
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:schedules'); END;
CREATE TRIGGER shoot_days_version_step BEFORE UPDATE ON shoot_days
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:shoot_days'); END;
CREATE TRIGGER messages_version_step BEFORE UPDATE ON messages
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:messages'); END;
CREATE TRIGGER files_version_step BEFORE UPDATE ON files
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:files'); END;
CREATE TRIGGER call_sheet_drafts_version_step BEFORE UPDATE ON call_sheet_drafts
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:call_sheet_drafts'); END;
CREATE TRIGGER production_pack_drafts_version_step BEFORE UPDATE ON production_pack_drafts
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:production_pack_drafts'); END;
CREATE TRIGGER readiness_profiles_version_step BEFORE UPDATE ON readiness_profiles
WHEN NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'version_step:readiness_profiles'); END;

-- Current file pointers can only select a version belonging to that logical file.
CREATE TRIGGER files_current_version_guard
BEFORE UPDATE OF current_version_id ON files
WHEN NEW.current_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM file_versions fv
    WHERE fv.id = NEW.current_version_id AND fv.file_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_current_file_version');
END;

-- Canonical scene pointers cannot cross scene identity.
CREATE TRIGGER scenes_current_revision_guard
BEFORE UPDATE OF current_scene_revision_id ON scenes
WHEN NEW.current_scene_revision_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM scene_revisions sr
    WHERE sr.id = NEW.current_scene_revision_id AND sr.scene_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_current_scene_revision');
END;

-- An applied sync cannot be reopened or have its mapping hash/source rewritten.
CREATE TRIGGER script_syncs_applied_guard
BEFORE UPDATE ON script_syncs
WHEN OLD.status = 'applied'
BEGIN
  SELECT RAISE(ABORT, 'immutable:applied_script_sync');
END;

-- Approved budget material is frozen; corrections require a new version.
CREATE TRIGGER budget_versions_approved_guard
BEFORE UPDATE ON budget_versions
WHEN OLD.status IN ('approved', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'immutable:approved_budget_version');
END;
CREATE TRIGGER budget_versions_approved_delete_guard
BEFORE DELETE ON budget_versions
WHEN OLD.status IN ('approved', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'immutable:approved_budget_version');
END;
CREATE TRIGGER budget_lines_approved_update_guard
BEFORE UPDATE ON budget_lines
WHEN EXISTS (
  SELECT 1 FROM budget_versions bv
  WHERE bv.id = OLD.budget_version_id AND bv.status IN ('approved', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'immutable:approved_budget_line');
END;
CREATE TRIGGER budget_lines_approved_delete_guard
BEFORE DELETE ON budget_lines
WHEN EXISTS (
  SELECT 1 FROM budget_versions bv
  WHERE bv.id = OLD.budget_version_id AND bv.status IN ('approved', 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'immutable:approved_budget_line');
END;

-- Export state may advance while a job builds; a terminal snapshot is frozen.
CREATE TRIGGER export_snapshots_terminal_update_guard
BEFORE UPDATE ON export_snapshots
WHEN OLD.state IN ('complete', 'failed', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'immutable:terminal_export_snapshot');
END;
CREATE TRIGGER export_snapshots_delete_guard
BEFORE DELETE ON export_snapshots
BEGIN
  SELECT RAISE(ABORT, 'immutable:export_snapshot');
END;

-- A readiness issue's evidence is immutable. Only ready -> stale/superseded and
-- stale -> superseded lifecycle transitions are permitted.
CREATE TRIGGER readiness_issues_content_guard
BEFORE UPDATE ON readiness_issues
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.shoot_day_id IS NOT OLD.shoot_day_id
  OR NEW.readiness_evaluation_id IS NOT OLD.readiness_evaluation_id
  OR NEW.issue_number IS NOT OLD.issue_number
  OR NEW.title IS NOT OLD.title
  OR NEW.manifest_json IS NOT OLD.manifest_json
  OR NEW.manifest_hash IS NOT OLD.manifest_hash
  OR NEW.issued_by_user_id IS NOT OLD.issued_by_user_id
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.supersedes_issue_id IS NOT OLD.supersedes_issue_id
  OR NOT (
    (OLD.state = 'ready' AND NEW.state IN ('stale', 'superseded'))
    OR (OLD.state = 'stale' AND NEW.state = 'superseded')
  )
BEGIN
  SELECT RAISE(ABORT, 'immutable:readiness_issue_content');
END;
CREATE TRIGGER readiness_issues_delete_guard
BEFORE DELETE ON readiness_issues
BEGIN
  SELECT RAISE(ABORT, 'immutable:readiness_issue');
END;

-- Append-only/immutable tables. Each row is corrected by supersession, never by
-- rewriting historical evidence.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'immutable:audit_events'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'immutable:audit_events'); END;
CREATE TRIGGER approval_decisions_no_update BEFORE UPDATE ON approval_decisions BEGIN SELECT RAISE(ABORT, 'immutable:approval_decisions'); END;
CREATE TRIGGER approval_decisions_no_delete BEFORE DELETE ON approval_decisions BEGIN SELECT RAISE(ABORT, 'immutable:approval_decisions'); END;
CREATE TRIGGER development_revisions_no_update BEFORE UPDATE ON development_revisions BEGIN SELECT RAISE(ABORT, 'immutable:development_revisions'); END;
CREATE TRIGGER development_revisions_no_delete BEFORE DELETE ON development_revisions BEGIN SELECT RAISE(ABORT, 'immutable:development_revisions'); END;
CREATE TRIGGER outline_revisions_no_update BEFORE UPDATE ON outline_revisions BEGIN SELECT RAISE(ABORT, 'immutable:outline_revisions'); END;
CREATE TRIGGER outline_revisions_no_delete BEFORE DELETE ON outline_revisions BEGIN SELECT RAISE(ABORT, 'immutable:outline_revisions'); END;
CREATE TRIGGER script_revisions_no_update BEFORE UPDATE ON script_revisions BEGIN SELECT RAISE(ABORT, 'immutable:script_revisions'); END;
CREATE TRIGGER script_revisions_no_delete BEFORE DELETE ON script_revisions BEGIN SELECT RAISE(ABORT, 'immutable:script_revisions'); END;
CREATE TRIGGER script_block_revisions_no_update BEFORE UPDATE ON script_block_revisions BEGIN SELECT RAISE(ABORT, 'immutable:script_block_revisions'); END;
CREATE TRIGGER script_block_revisions_no_delete BEFORE DELETE ON script_block_revisions BEGIN SELECT RAISE(ABORT, 'immutable:script_block_revisions'); END;
CREATE TRIGGER scene_revisions_no_update BEFORE UPDATE ON scene_revisions BEGIN SELECT RAISE(ABORT, 'immutable:scene_revisions'); END;
CREATE TRIGGER scene_revisions_no_delete BEFORE DELETE ON scene_revisions BEGIN SELECT RAISE(ABORT, 'immutable:scene_revisions'); END;
CREATE TRIGGER scene_mapping_decisions_no_update BEFORE UPDATE ON scene_mapping_decisions BEGIN SELECT RAISE(ABORT, 'immutable:scene_mapping_decisions'); END;
CREATE TRIGGER scene_mapping_decisions_no_delete BEFORE DELETE ON scene_mapping_decisions BEGIN SELECT RAISE(ABORT, 'immutable:scene_mapping_decisions'); END;
CREATE TRIGGER av_revisions_no_update BEFORE UPDATE ON av_revisions BEGIN SELECT RAISE(ABORT, 'immutable:av_revisions'); END;
CREATE TRIGGER av_revisions_no_delete BEFORE DELETE ON av_revisions BEGIN SELECT RAISE(ABORT, 'immutable:av_revisions'); END;
CREATE TRIGGER document_revisions_no_update BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT, 'immutable:document_revisions'); END;
CREATE TRIGGER document_revisions_no_delete BEFORE DELETE ON document_revisions BEGIN SELECT RAISE(ABORT, 'immutable:document_revisions'); END;
CREATE TRIGGER template_versions_no_update BEFORE UPDATE ON template_versions BEGIN SELECT RAISE(ABORT, 'immutable:template_versions'); END;
CREATE TRIGGER template_versions_no_delete BEFORE DELETE ON template_versions BEGIN SELECT RAISE(ABORT, 'immutable:template_versions'); END;
CREATE TRIGGER element_merges_no_update BEFORE UPDATE ON element_merges BEGIN SELECT RAISE(ABORT, 'immutable:element_merges'); END;
CREATE TRIGGER element_merges_no_delete BEFORE DELETE ON element_merges BEGIN SELECT RAISE(ABORT, 'immutable:element_merges'); END;
CREATE TRIGGER report_snapshots_no_update BEFORE UPDATE ON report_snapshots BEGIN SELECT RAISE(ABORT, 'immutable:report_snapshots'); END;
CREATE TRIGGER report_snapshots_no_delete BEFORE DELETE ON report_snapshots BEGIN SELECT RAISE(ABORT, 'immutable:report_snapshots'); END;
CREATE TRIGGER sides_issues_no_update BEFORE UPDATE ON sides_issues BEGIN SELECT RAISE(ABORT, 'immutable:sides_issues'); END;
CREATE TRIGGER sides_issues_no_delete BEFORE DELETE ON sides_issues BEGIN SELECT RAISE(ABORT, 'immutable:sides_issues'); END;
CREATE TRIGGER candidate_status_history_no_update BEFORE UPDATE ON candidate_status_history BEGIN SELECT RAISE(ABORT, 'immutable:candidate_status_history'); END;
CREATE TRIGGER candidate_status_history_no_delete BEFORE DELETE ON candidate_status_history BEGIN SELECT RAISE(ABORT, 'immutable:candidate_status_history'); END;
CREATE TRIGGER scout_decisions_no_update BEFORE UPDATE ON scout_decisions BEGIN SELECT RAISE(ABORT, 'immutable:scout_decisions'); END;
CREATE TRIGGER scout_decisions_no_delete BEFORE DELETE ON scout_decisions BEGIN SELECT RAISE(ABORT, 'immutable:scout_decisions'); END;
CREATE TRIGGER conflict_resolutions_no_update BEFORE UPDATE ON conflict_resolutions BEGIN SELECT RAISE(ABORT, 'immutable:conflict_resolutions'); END;
CREATE TRIGGER conflict_resolutions_no_delete BEFORE DELETE ON conflict_resolutions BEGIN SELECT RAISE(ABORT, 'immutable:conflict_resolutions'); END;
CREATE TRIGGER calendar_revisions_no_update BEFORE UPDATE ON calendar_revisions BEGIN SELECT RAISE(ABORT, 'immutable:calendar_revisions'); END;
CREATE TRIGGER calendar_revisions_no_delete BEFORE DELETE ON calendar_revisions BEGIN SELECT RAISE(ABORT, 'immutable:calendar_revisions'); END;
CREATE TRIGGER schedule_revisions_no_update BEFORE UPDATE ON schedule_revisions BEGIN SELECT RAISE(ABORT, 'immutable:schedule_revisions'); END;
CREATE TRIGGER schedule_revisions_no_delete BEFORE DELETE ON schedule_revisions BEGIN SELECT RAISE(ABORT, 'immutable:schedule_revisions'); END;
CREATE TRIGGER schedule_items_no_update BEFORE UPDATE ON schedule_items BEGIN SELECT RAISE(ABORT, 'immutable:schedule_items'); END;
CREATE TRIGGER schedule_items_no_delete BEFORE DELETE ON schedule_items BEGIN SELECT RAISE(ABORT, 'immutable:schedule_items'); END;
CREATE TRIGGER call_sheet_issues_no_update BEFORE UPDATE ON call_sheet_issues BEGIN SELECT RAISE(ABORT, 'immutable:call_sheet_issues'); END;
CREATE TRIGGER call_sheet_issues_no_delete BEFORE DELETE ON call_sheet_issues BEGIN SELECT RAISE(ABORT, 'immutable:call_sheet_issues'); END;
CREATE TRIGGER call_sheet_recipient_issues_no_update BEFORE UPDATE ON call_sheet_recipient_issues BEGIN SELECT RAISE(ABORT, 'immutable:call_sheet_recipient_issues'); END;
CREATE TRIGGER call_sheet_recipient_issues_no_delete BEFORE DELETE ON call_sheet_recipient_issues BEGIN SELECT RAISE(ABORT, 'immutable:call_sheet_recipient_issues'); END;
CREATE TRIGGER delivery_events_no_update BEFORE UPDATE ON delivery_events BEGIN SELECT RAISE(ABORT, 'immutable:delivery_events'); END;
CREATE TRIGGER delivery_events_no_delete BEFORE DELETE ON delivery_events BEGIN SELECT RAISE(ABORT, 'immutable:delivery_events'); END;
CREATE TRIGGER confirmations_no_update BEFORE UPDATE ON confirmations BEGIN SELECT RAISE(ABORT, 'immutable:confirmations'); END;
CREATE TRIGGER confirmations_no_delete BEFORE DELETE ON confirmations BEGIN SELECT RAISE(ABORT, 'immutable:confirmations'); END;
CREATE TRIGGER production_pack_issues_no_update BEFORE UPDATE ON production_pack_issues BEGIN SELECT RAISE(ABORT, 'immutable:production_pack_issues'); END;
CREATE TRIGGER production_pack_issues_no_delete BEFORE DELETE ON production_pack_issues BEGIN SELECT RAISE(ABORT, 'immutable:production_pack_issues'); END;
CREATE TRIGGER production_pack_manifest_items_no_update BEFORE UPDATE ON production_pack_manifest_items BEGIN SELECT RAISE(ABORT, 'immutable:production_pack_manifest_items'); END;
CREATE TRIGGER production_pack_manifest_items_no_delete BEFORE DELETE ON production_pack_manifest_items BEGIN SELECT RAISE(ABORT, 'immutable:production_pack_manifest_items'); END;
CREATE TRIGGER file_versions_no_update BEFORE UPDATE ON file_versions BEGIN SELECT RAISE(ABORT, 'immutable:file_versions'); END;
CREATE TRIGGER file_versions_no_delete BEFORE DELETE ON file_versions BEGIN SELECT RAISE(ABORT, 'immutable:file_versions'); END;
CREATE TRIGGER readiness_profile_versions_no_update BEFORE UPDATE ON readiness_profile_versions BEGIN SELECT RAISE(ABORT, 'immutable:readiness_profile_versions'); END;
CREATE TRIGGER readiness_profile_versions_no_delete BEFORE DELETE ON readiness_profile_versions BEGIN SELECT RAISE(ABORT, 'immutable:readiness_profile_versions'); END;
CREATE TRIGGER readiness_rules_no_update BEFORE UPDATE ON readiness_rules BEGIN SELECT RAISE(ABORT, 'immutable:readiness_rules'); END;
CREATE TRIGGER readiness_rules_no_delete BEFORE DELETE ON readiness_rules BEGIN SELECT RAISE(ABORT, 'immutable:readiness_rules'); END;
CREATE TRIGGER readiness_issue_results_no_update BEFORE UPDATE ON readiness_issue_results BEGIN SELECT RAISE(ABORT, 'immutable:readiness_issue_results'); END;
CREATE TRIGGER readiness_issue_results_no_delete BEFORE DELETE ON readiness_issue_results BEGIN SELECT RAISE(ABORT, 'immutable:readiness_issue_results'); END;
CREATE TRIGGER readiness_issue_sources_no_update BEFORE UPDATE ON readiness_issue_sources BEGIN SELECT RAISE(ABORT, 'immutable:readiness_issue_sources'); END;
CREATE TRIGGER readiness_issue_sources_no_delete BEFORE DELETE ON readiness_issue_sources BEGIN SELECT RAISE(ABORT, 'immutable:readiness_issue_sources'); END;
CREATE TRIGGER archive_acknowledgements_no_update BEFORE UPDATE ON archive_acknowledgements BEGIN SELECT RAISE(ABORT, 'immutable:archive_acknowledgements'); END;
CREATE TRIGGER archive_acknowledgements_no_delete BEFORE DELETE ON archive_acknowledgements BEGIN SELECT RAISE(ABORT, 'immutable:archive_acknowledgements'); END;

-- Derived, permission-safe search projection. It is deliberately contentless and
-- has no canonical-table triggers: restore/import rebuilds it from authorized
-- source rows, and backups do not depend on its contents.
CREATE VIRTUAL TABLE search_index USING fts5(
  object_id UNINDEXED,
  workspace_id UNINDEXED,
  project_id UNINDEXED,
  object_type UNINDEXED,
  title,
  summary,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE search_index_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  rebuilt_at INTEGER,
  source_watermark INTEGER,
  updated_at INTEGER NOT NULL
);

