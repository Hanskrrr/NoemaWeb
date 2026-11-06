-- The Trash: deleting a thread or a note hides it; restoring brings it back
-- as it was. A thread takes its side questions along: they carry
-- `deleted_with` = the thread whose deletion took them, so they come back
-- together. Nothing is removed from the database.
ALTER TABLE thread ADD COLUMN deleted_at TEXT;
ALTER TABLE thread ADD COLUMN deleted_with TEXT;
ALTER TABLE note ADD COLUMN deleted_at TEXT;
CREATE INDEX thread_deleted_with ON thread(deleted_with);
