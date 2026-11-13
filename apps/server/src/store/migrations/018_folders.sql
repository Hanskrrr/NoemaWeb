-- Folders on the learner's computer (ADR 0025): linked, browsed and read in
-- place. A file opened becomes a source linked to it; reading it again after
-- it changed on disk adds a version, as fetching a page again does.
CREATE TABLE folder (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (notebook_id, path)
) STRICT;

ALTER TABLE source ADD COLUMN folder_id TEXT REFERENCES folder(id) ON DELETE SET NULL;
-- The file's path inside the folder, with / between parts.
ALTER TABLE source ADD COLUMN file_path TEXT;
CREATE UNIQUE INDEX source_by_file ON source(folder_id, file_path) WHERE folder_id IS NOT NULL;
-- What the file's bytes were when this version was read (sha256), to know when it changed.
ALTER TABLE source_version ADD COLUMN file_hash TEXT;

-- A file as it was before Noema wrote to it (null: it did not exist), so the
-- write can be undone; and what Noema wrote, so undo can tell if it changed since.
CREATE TABLE file_backup (
  id          TEXT PRIMARY KEY,
  folder_id   TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  before      TEXT,
  after_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL
) STRICT;
