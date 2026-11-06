-- Merging one thread into another, like a merge commit: nothing is
-- rewritten. The source's summary (or its exchanges) is drafted, edited and
-- accepted by the learner, and from then on goes in front of the target's
-- next question.
CREATE TABLE thread_merge (
  id               TEXT PRIMARY KEY,
  source_thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  target_thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  -- 'summary': drafted by the AI; 'full': the exchanges as they are.
  mode             TEXT NOT NULL CHECK (mode IN ('summary', 'full')),
  summary          TEXT NOT NULL DEFAULT '',
  -- JSON: citation label ("E3") -> {threadId, messageId} in the source.
  refs             TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL CHECK (status IN ('drafting', 'draft', 'failed', 'merged', 'undone', 'discarded')),
  error            TEXT,
  -- Set when accepted: the target's last message seq then. The merged text
  -- goes in front of the first question after it, so what came before
  -- stays the same prompt prefix.
  after_seq        INTEGER,
  -- Where the card is shown when reading the target: after this message.
  after_message_id TEXT,
  created_at       TEXT NOT NULL,
  merged_at        TEXT,
  undone_at        TEXT
) STRICT;
CREATE INDEX thread_merge_target ON thread_merge(target_thread_id, status);
CREATE INDEX thread_merge_source ON thread_merge(source_thread_id, status);
