-- Per-user token version. Every JWT we mint embeds the current value; on
-- verify, a mismatch invalidates the token. POST /auth/logout-all bumps it,
-- killing every JWT in flight for that user after a password reset or lost
-- device. API tokens (api_tokens table) are unaffected — those are revoked
-- via DELETE /tokens/:id.

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

INSERT INTO app_meta(key, value) VALUES ('schema_version', '005_user_token_version')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
