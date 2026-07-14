CREATE TABLE IF NOT EXISTS article_likes (
  article_id TEXT NOT NULL
    CHECK (length(article_id) = 16 AND article_id NOT GLOB '*[^0-9a-f]*'),
  voter_hash TEXT NOT NULL
    CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, voter_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS reaction_rate_limits (
  voter_hash TEXT PRIMARY KEY
    CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
) WITHOUT ROWID;
