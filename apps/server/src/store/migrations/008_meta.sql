-- Small facts about the store itself, such as which version of the search
-- index it holds (the index is rebuilt in code when that changes).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
