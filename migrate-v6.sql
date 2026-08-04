-- AniWired v6: rate limiting + token revocation.
-- Run once on an existing database:
--   npx wrangler d1 execute aniwired --remote --file=./migrate-v6.sql
--
-- Addresses audit items S-2 (no rate limiting on /api/auth/*) and
-- S-7 (tokens could not be revoked before their 30-day expiry).

-- ---------------------------------------------------------------------
-- Rate limiting backstop.
-- The primary defence is the Cloudflare WAF rate-limiting rule; this table
-- keeps the protection working if the project ever moves off Cloudflare.
-- One row per bucket key, e.g. "auth:<ip>", "pwd:<user id>", "cmt:<user id>".
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_attempts (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL   -- ms epoch: when the window resets
);

-- Lets the daily cleanup below scan only expired rows.
CREATE INDEX IF NOT EXISTS idx_auth_attempts_reset ON auth_attempts (reset_at);

-- Housekeeping: run occasionally so stale keys do not accumulate.
--   npx wrangler d1 execute aniwired --remote \
--     --command "DELETE FROM auth_attempts WHERE reset_at < unixepoch()*1000"

-- ---------------------------------------------------------------------
-- Token revocation.
-- The JWT carries "epoch"; requireUser() rejects any token whose epoch is
-- lower than the stored one. Incrementing this column therefore signs the
-- account out everywhere at once, with no session table to maintain.
-- It is bumped on password change and by "sign out everywhere".
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS": if this statement fails with
-- "duplicate column name", the migration has already been applied.
-- ---------------------------------------------------------------------
ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;