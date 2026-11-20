-- Additive, non-destructive migration for authenticated V3-to-chatbot sessions.
-- Review and apply to the chatbot PostgreSQL database before enabling the
-- V3 integration endpoint in production. This does not drop or rewrite data.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mindora_external_id VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS ix_users_mindora_external_id
  ON users (mindora_external_id)
  WHERE mindora_external_id IS NOT NULL;
