-- Noema store, version 1.
-- Text ids are ULIDs. Times are ISO-8601 UTC strings.
-- Message text lives in revisions, which are never edited once terminal:
-- anchors point into revisions, so a revision's text must not change under them.

CREATE TABLE notebook (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  about_me    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE thread (
  id           TEXT PRIMARY KEY,
  notebook_id  TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX thread_by_notebook ON thread(notebook_id, updated_at);

CREATE TABLE message (
  id                   TEXT PRIMARY KEY,
  thread_id            TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  seq                  INTEGER NOT NULL,
  reply_to             TEXT REFERENCES message(id),
  current_revision_id  TEXT,  -- points at message_revision.id; kept in step by the repo
  created_at           TEXT NOT NULL,
  UNIQUE (thread_id, seq)
) STRICT;

CREATE TABLE message_revision (
  id             TEXT PRIMARY KEY,
  message_id     TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  n              INTEGER NOT NULL,
  content        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'done', 'failed', 'interrupted', 'stopped')),
  error_kind     TEXT,
  error_message  TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (message_id, n)
) STRICT;
CREATE INDEX revision_live ON message_revision(status) WHERE status IN ('pending', 'streaming');

-- One row per model call: what it saw (manifest), what it cost, how it ended.
CREATE TABLE model_call (
  id                 TEXT PRIMARY KEY,
  revision_id        TEXT NOT NULL REFERENCES message_revision(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  first_token_at     TEXT,
  finished_at        TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cache_hit_tokens   INTEGER,
  cache_miss_tokens  INTEGER,
  finish_reason      TEXT,
  error_kind         TEXT,
  manifest           TEXT NOT NULL
) STRICT;
CREATE INDEX model_call_by_revision ON model_call(revision_id);

-- Append-only log of what the learner did. Insights are computed from this.
CREATE TABLE event (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  subject_id  TEXT,
  data        TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX event_by_subject ON event(subject_id);
CREATE INDEX event_by_type ON event(type, at);

-- Full-text search. `body` holds searchText() output (CJK unigrams + bigrams),
-- not the original text; snippets are cut from the original.
CREATE VIRTUAL TABLE search USING fts5(
  body,
  kind UNINDEXED,
  target_id UNINDEXED,
  thread_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
