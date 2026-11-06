-- "New thread from here": a thread split off from another at one of its
-- questions. The question and everything after it moved into the new thread
-- (same message ids, revisions and anchors; new place in a new thread).
-- `continued_at_seq` is where the moved part began in the original thread,
-- so it can join back in the same order.
ALTER TABLE thread ADD COLUMN continued_from TEXT REFERENCES thread(id) ON DELETE SET NULL;
ALTER TABLE thread ADD COLUMN continued_at_seq INTEGER;
CREATE INDEX thread_continued_from ON thread(continued_from);
