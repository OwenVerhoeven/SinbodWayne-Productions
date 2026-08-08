-- External approval decisions need an honest actor. A decision is made by
-- exactly one authenticated user or one narrow, revocable share link.

PRAGMA foreign_keys = ON;

ALTER TABLE approval_decisions RENAME TO approval_decisions_legacy;

CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected', 'expired', 'superseded')),
  actor_user_id TEXT REFERENCES user_identities(id) ON DELETE RESTRICT,
  share_link_id TEXT REFERENCES share_links(id) ON DELETE RESTRICT,
  actor_label TEXT,
  comment TEXT,
  pinned_version_id TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((actor_user_id IS NOT NULL) <> (share_link_id IS NOT NULL)),
  CHECK (share_link_id IS NULL OR (actor_label IS NOT NULL AND length(trim(actor_label)) BETWEEN 2 AND 160))
);

INSERT INTO approval_decisions
  (id, workspace_id, project_id, approval_id, decision, actor_user_id,
   share_link_id, actor_label, comment, pinned_version_id, created_at)
SELECT id, workspace_id, project_id, approval_id, decision, actor_user_id,
       NULL, NULL, comment, pinned_version_id, created_at
  FROM approval_decisions_legacy;

DROP TABLE approval_decisions_legacy;

CREATE INDEX approval_decisions_approval_idx ON approval_decisions(approval_id, created_at, id);

CREATE TRIGGER approval_decisions_no_update
BEFORE UPDATE ON approval_decisions
BEGIN
  SELECT RAISE(ABORT, 'immutable:approval_decisions');
END;

CREATE TRIGGER approval_decisions_no_delete
BEFORE DELETE ON approval_decisions
BEGIN
  SELECT RAISE(ABORT, 'immutable:approval_decisions');
END;
