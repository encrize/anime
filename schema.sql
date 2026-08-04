-- =====================================================================
-- AniWired - Cloudflare D1 schema
-- Apply locally : npx wrangler d1 execute aniwired --local  --file=./schema.sql
-- Apply remote  : npx wrangler d1 execute aniwired --remote --file=./schema.sql
-- The script is idempotent, it is safe to run it again after an update.
-- =====================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- uuid
  username      TEXT NOT NULL UNIQUE,      -- lowercase nickname, 3-20 chars
  display_name  TEXT NOT NULL DEFAULT '',  -- nickname exactly as typed
  password_hash TEXT NOT NULL,             -- pbkdf2$iterations$salt$hash
  created_at    INTEGER NOT NULL,          -- ms epoch
  history_public INTEGER NOT NULL DEFAULT 1, -- 1 = watched titles are visible on the public profile
  profile_public INTEGER NOT NULL DEFAULT 1, -- 1 = other people may open this profile at /u/<username>
  -- Token revocation. The JWT carries "epoch"; requireUser() rejects any token
  -- whose epoch is below this value, so incrementing it signs the account out
  -- everywhere at once without maintaining a session table. Bumped on password
  -- change and by "sign out everywhere". Existing DBs: run migrate-v6.sql.
  token_epoch    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS progress (
  user_id      TEXT    NOT NULL,
  anime_id     TEXT    NOT NULL,            -- AniLibria id or "al-<AniList id>"
  name         TEXT    NOT NULL DEFAULT '',
  poster       TEXT    NOT NULL DEFAULT '',
  episode_idx  INTEGER NOT NULL DEFAULT 0,  -- index inside the episode list
  quality      TEXT    NOT NULL DEFAULT '', -- hls_1080 / hls_720 / hls_480
  time_sec     INTEGER NOT NULL DEFAULT 0,  -- playback timecode, seconds
  duration_sec INTEGER NOT NULL DEFAULT 0,  -- episode length, drives the progress bars
  ep_label     TEXT    NOT NULL DEFAULT '', -- human readable episode number
  ep_total     INTEGER NOT NULL DEFAULT 0,  -- episodes in the title
  source       TEXT    NOT NULL DEFAULT 'libria',
  seen_json    TEXT    NOT NULL DEFAULT '[]', -- JSON array of watched episode indexes
  updated_at   INTEGER NOT NULL,            -- ms epoch, used for conflict resolution
  PRIMARY KEY (user_id, anime_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_progress_user_updated
  ON progress (user_id, updated_at DESC);

-- Comments left under a title. anime_id matches progress.anime_id
-- (AniLibria id or "al-<AniList id>").
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,            -- uuid
  anime_id    TEXT NOT NULL,
  anime_name  TEXT NOT NULL DEFAULT '',    -- denormalised, used on the public profile
  user_id     TEXT NOT NULL,
  body        TEXT NOT NULL,               -- 1-1000 chars
  created_at  INTEGER NOT NULL,            -- ms epoch
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_anime
  ON comments (anime_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comments_user
  ON comments (user_id, created_at DESC);

/* ---------------------------------------------------------------
 * follows - subscriptions between accounts.
 * One row = "follower_id subscribes to following_id".
 * Two mirrored rows (A->B and B->A) mean the accounts are friends.
 * --------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS follows (
  follower_id  TEXT NOT NULL,
  following_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, following_id),
  FOREIGN KEY (follower_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows (follower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id, created_at DESC);

/* ---------------------------------------------------------------
 * auth_attempts - rate limiting backstop.
 * The primary defence is the Cloudflare WAF rate-limiting rule; this table
 * keeps brute-force protection working if the project ever leaves Cloudflare.
 * One row per bucket key: "auth:<ip>", "pwd:<user id>", "cmt:<user id>".
 * The worker fails open if this table is missing, so sign-in never breaks
 * just because the migration has not been applied yet.
 * --------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS auth_attempts (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL   -- ms epoch: when the window resets
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_reset ON auth_attempts (reset_at);

-- Housekeeping, run occasionally so stale keys do not accumulate:
--   npx wrangler d1 execute aniwired --remote \
--     --command "DELETE FROM auth_attempts WHERE reset_at < unixepoch()*1000"
