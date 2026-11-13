-- The Assistant (ADR 0023): one thread per notebook that looks things up
-- across the notebook. A thread of its own kind, so it is listed apart and
-- never retitled; at most one per notebook.
ALTER TABLE thread ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'assistant'));
CREATE UNIQUE INDEX thread_one_assistant ON thread(notebook_id) WHERE kind = 'assistant';

-- An Assistant answer's lookups (JSON: the steps it took, and where each
-- label it cites points). Written once, when the answer ends; null elsewhere.
ALTER TABLE message_revision ADD COLUMN lookups TEXT;
