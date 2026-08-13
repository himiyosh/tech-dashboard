PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS incremental_serving_generations (
  revision TEXT PRIMARY KEY NOT NULL,
  source_commit TEXT NOT NULL,
  publisher_fingerprint TEXT NOT NULL,
  shell_key TEXT NOT NULL,
  shard_keys_json TEXT NOT NULL,
  coverage_complete INTEGER NOT NULL CHECK (coverage_complete IN (0, 1)),
  coverage_json TEXT NOT NULL,
  measured_daily_requests INTEGER NOT NULL
    CHECK (measured_daily_requests >= 0 AND measured_daily_requests <= 100000),
  traffic_verified_at TEXT,
  budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incremental_serving_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  active_revision TEXT,
  previous_revision TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_revision)
    REFERENCES incremental_serving_generations(revision),
  FOREIGN KEY (previous_revision)
    REFERENCES incremental_serving_generations(revision)
);

INSERT INTO incremental_serving_state (
  singleton,
  active_revision,
  previous_revision,
  updated_at
) VALUES (
  1,
  NULL,
  NULL,
  '1970-01-01T00:00:00.000Z'
)
ON CONFLICT(singleton) DO NOTHING;

CREATE INDEX IF NOT EXISTS incremental_serving_generations_activated_at
  ON incremental_serving_generations(activated_at);
