-- Teams (PokemonSet[] stored as JSON blob — no queryable shape inside) and
-- matches (Match stored as JSON blob — same reason). Index by user_id for
-- list queries; index by (user_id, name) UNIQUE on teams for upsert.

CREATE TABLE teams (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  team_json     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE INDEX teams_user_id_idx ON teams(user_id);

CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  outcome       TEXT,             -- 'victory' | 'defeat' | 'tie' | NULL
  match_json    TEXT NOT NULL
);

CREATE INDEX matches_user_id_idx ON matches(user_id);
CREATE INDEX matches_user_started_idx ON matches(user_id, started_at DESC);

INSERT INTO app_meta(key, value) VALUES ('schema_version', '003_teams_matches')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
