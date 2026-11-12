-- Pictures of PDF pages (ADR 0022), made by the browser when the learner
-- asks about a passage of a PDF: the model is sent the page with the question.
-- One per page of a version, and like the version it never changes. Stored as
-- base64 (exports hold text), at most a few hundred kilobytes each.
CREATE TABLE source_page_image (
  version_id TEXT NOT NULL REFERENCES source_version(id) ON DELETE CASCADE,
  page       INTEGER NOT NULL CHECK (page >= 1),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data       TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, page)
) STRICT;
