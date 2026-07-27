CREATE TABLE IF NOT EXISTS reaction_voters (
  voter_hash TEXT PRIMARY KEY
    CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO reaction_voters (voter_hash, created_at)
SELECT voter_hash, MIN(created_at)
FROM article_likes
GROUP BY voter_hash;

INSERT OR IGNORE INTO reaction_voters (voter_hash, created_at)
SELECT voter_hash, window_started_at
FROM reaction_rate_limits;

CREATE INDEX IF NOT EXISTS article_likes_by_voter
  ON article_likes (voter_hash);
