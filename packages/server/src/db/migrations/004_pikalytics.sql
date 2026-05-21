-- Server-shared Pikalytics cache. Unlike teams/matches, entries aren't
-- user-scoped — they describe the metagame, so one fetch benefits everyone.
-- Composite PK (format, species); fetched_at supports TTL refreshes later.
-- entry_json holds the full PikalyticsEntry blob (see @pokechamps/core).

CREATE TABLE pikalytics_entries (
  format        TEXT NOT NULL,
  species       TEXT NOT NULL,
  entry_json    TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (format, species)
);

CREATE INDEX pikalytics_entries_format_idx ON pikalytics_entries(format);

INSERT INTO app_meta(key, value) VALUES ('schema_version', '004_pikalytics')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
