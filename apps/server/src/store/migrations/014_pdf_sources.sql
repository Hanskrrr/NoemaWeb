-- PDF sources (ADR 0021). A version read from a PDF keeps the file itself in
-- `raw` (base64), says what it is in `media_type`, and keeps the file's name
-- when it had one (given as a file, or the last part of its address).
--
-- A file the learner gave is stored with origin 'paste' (given, not fetched):
-- changing the CHECK on origin means rebuilding source_version, and with
-- foreign keys on, dropping it would delete every passage asked about.
-- The API calls such a version's origin 'file'.
ALTER TABLE source_version ADD COLUMN media_type TEXT;
ALTER TABLE source_version ADD COLUMN file_name TEXT;
