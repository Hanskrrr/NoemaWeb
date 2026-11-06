-- Notes: editable documents in the notebook. The first kind is an AI rewrite
-- of a thread, made on request; it never replaces the chat. Every saved
-- version is kept in note_revision, with who wrote it.

CREATE TABLE note (
  id           TEXT PRIMARY KEY,
  notebook_id  TEXT NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  thread_id    TEXT REFERENCES thread(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  -- Who named it: 'thread' (the thread's title, at first), 'model' (the
  -- note's own heading) or 'user'. A learner's title is never replaced.
  title_source TEXT NOT NULL DEFAULT 'thread' CHECK (title_source IN ('thread', 'model', 'user')),
  content      TEXT NOT NULL DEFAULT '',
  -- JSON: citation label ("E3") -> {threadId, messageId} of the exchange it cites.
  refs         TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL CHECK (status IN ('generating', 'done', 'failed')),
  error        TEXT,
  author       TEXT NOT NULL CHECK (author IN ('ai', 'user', 'ai+user')),
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX note_by_notebook ON note(notebook_id, updated_at);
CREATE INDEX note_by_thread ON note(thread_id);

CREATE TABLE note_revision (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  n           INTEGER NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  refs        TEXT NOT NULL DEFAULT '{}',
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (note_id, n)
) STRICT;
