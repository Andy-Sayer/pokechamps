-- Users + API tokens. JWTs are stateless (no server-side table) — only the
-- long-lived API tokens issued for TUI clients live in DB so they can be
-- revoked.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                    -- uuid v4
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,                       -- bcrypt
  created_at    TEXT NOT NULL                        -- ISO 8601 UTC
);

CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,                    -- uuid v4, returned to client as the token prefix
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,                       -- bcrypt of the raw secret half (NOT the id)
  name          TEXT,                                -- human label e.g. "andy's laptop"
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE INDEX api_tokens_user_id_idx ON api_tokens(user_id);

INSERT INTO app_meta(key, value) VALUES ('schema_version', '002_users')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
