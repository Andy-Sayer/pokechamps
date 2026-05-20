-- Bootstrap migration. Creates the app_meta table for cross-cutting key/value
-- bookkeeping (e.g., schema_version, last_pikalytics_refresh). Real domain
-- tables (users, teams, matches) arrive in later migrations.
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', '001_init');
