-- Sources: what the learner reads (a paper, a page, pasted text). The text
-- shown and anchored into is an immutable Markdown version; fetching again
-- adds a version only when the text changed, and old anchors keep pointing
-- at the version that was shown. The original HTML is kept beside it, so the
-- text can be extracted again later.
CREATE TABLE source (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  url         TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;
CREATE INDEX source_by_notebook ON source(notebook_id, updated_at);

CREATE TABLE source_version (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('paste', 'url')),
  fetched_url  TEXT,
  raw          TEXT,
  extractor    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source_id, seq)
) STRICT;

-- A passage of one source version, with W3C quote and position selectors.
CREATE TABLE source_anchor (
  id           TEXT PRIMARY KEY,
  version_id   TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  exact        TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  suffix       TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (start_offset >= 0 AND end_offset > start_offset)
) STRICT;
CREATE INDEX source_anchor_by_version ON source_anchor(version_id);

-- A thread asked about a passage of a source.
ALTER TABLE thread ADD COLUMN source_anchor_id TEXT REFERENCES source_anchor(id);
CREATE INDEX thread_by_source_anchor ON thread(source_anchor_id);
