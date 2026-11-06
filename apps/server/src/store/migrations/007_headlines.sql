-- A short line the model writes for each finished answer, saying what the
-- exchange established ("Gradients point uphill, so descent goes the other
-- way"), for the map and the catalog. Derived from the answer; the answer's
-- text itself is never changed.
ALTER TABLE message_revision ADD COLUMN headline TEXT;
