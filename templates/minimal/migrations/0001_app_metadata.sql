CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_metadata (key, value, updated_at)
VALUES ('schema', '1', unixepoch() * 1000);
