-- Add an explicit capability mode without rebuilding the identity tables that are
-- referenced throughout the production graph. Existing accounts remain editors.

ALTER TABLE user_identities
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'editor'
  CHECK (access_mode IN ('editor', 'viewer'));

