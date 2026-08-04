# AniWired

Full-stack anime streaming web app: a framework-free Vanilla JS single-page
frontend served by a Cloudflare Worker, backed by Cloudflare D1 (SQLite) for
accounts, cross-device watch-history sync, comments, and friends.

> Private project: search indexing is disabled on purpose (`robots.txt`),
> while messenger crawlers stay allowed so shared links unfold into cards.

## Features

- **Accounts and auth** - sign up with a username and password (no email).
  Passwords are hashed with PBKDF2-SHA256 at 210k iterations (WebCrypto);
  sessions are HS256 JWTs with sliding renewal and instant revocation via
  `users.token_epoch`.
- **Watch-history sync** - every title stores episode, timecode, duration,
  quality, source, and the watched-episode set. Writes to D1 are debounced to
  25 s and skipped when nothing changed; pause / seek / episode end / tab close
  flush immediately. Server-side merging is last-write-wins with a union of
  watched episodes, so an offline device never loses progress.
- **Two player sources** - AniLibria (built-in HLS player) and Kodik (embedded
  iframe). Kodik is reached through a server-side proxy, so its token never
  reaches the browser and the API host is auto-discovered from Kodik's own
  loader script.
- **Social** - comments under every title, public profiles at `/u/<nickname>`,
  one-directional follows with mutual follows shown as friends, and
  server-enforced privacy switches (hide profile, hide watch history).
- **Discovery** - genre navigation through AniList, Top 100 charts (best rated
  / most popular), a random-title picker, and multi-variant search that keeps
  sequels (`K-On!` vs `K-On!!`) distinct.
- **SPA routing** - History API routes with working deep links via the assets
  SPA fallback: `/`, `/title/<id>`, `/profile`, `/genre/<name>`,
  `/u/<nickname>`, `/top/best`, `/top/popular`, `/random`.
- **Security hardening** - CORS origin allowlist, strict security headers and
  CSP on every response, per-IP / per-account rate limiting stored in D1.

## Tech stack

| Layer    | Technology                                             |
|----------|--------------------------------------------------------|
| Frontend | Vanilla JS, no frameworks, no build step (`public/index.html`) |
| Backend  | Cloudflare Workers (`worker/worker.js`)                |
| Database | Cloudflare D1 (SQLite)                                 |
| Auth     | HS256 JWT + PBKDF2-SHA256 (WebCrypto)                  |
| Tooling  | Wrangler CLI v4                                        |
| Data     | AniLibria API, AniList GraphQL, Kodik, TMDB (optional) |

## Project structure

```
.
├── public/
│   ├── index.html       # frontend: SPA, player, profile page, sync, router
│   ├── robots.txt       # search indexing off, messenger link previews on
│   ├── _headers         # static security headers
│   └── og.jpg           # Open Graph card image
├── worker/
│   └── worker.js        # backend: JWT auth, REST API, Kodik proxy, static assets
├── schema.sql           # full D1 schema (idempotent; all a fresh install needs)
├── migrate-v6.sql       # one-time upgrade for databases created before v6
├── wrangler.toml        # Worker config: assets binding + D1 binding
├── package.json         # npm scripts (dev / deploy / db / secret)
└── .dev.vars.example    # local-secrets template (copy to .dev.vars)
```

## Getting started

### Prerequisites

- Node.js 18+ and npm
- A Cloudflare account (the free tier is enough: Workers 100k requests/day,
  D1 5 GB storage and 5M row reads/day)

### 1. Install

```bash
npm install
```

### 2. Create and initialize the database

```bash
npx wrangler d1 create aniwired
# paste the printed database_id into wrangler.toml -> [[d1_databases]] database_id

npm run db:local    # wrangler d1 execute aniwired --local  --file=./schema.sql
npm run db:remote   # wrangler d1 execute aniwired --remote --file=./schema.sql
```

`schema.sql` is idempotent and already contains every table, so it is all a
fresh install needs.

### 3. Set the JWT secret

```bash
npx wrangler secret put JWT_SECRET   # minimum 32 characters
```

For local development, copy the template and fill it in:

```bash
cp .dev.vars.example .dev.vars
```

> **Warning:** do not put `JWT_SECRET` into `[vars]` in `wrangler.toml` -
> plaintext vars overwrite the remote secret on every deploy. `.dev.vars` is
> git-ignored.

Optional secrets (set the same way with `wrangler secret put`):

| Secret          | Purpose                                                                |
|-----------------|------------------------------------------------------------------------|
| `KODIK_TOKEN`   | Your own Kodik API token. Without it, the Worker extracts a public token from Kodik's loader script and caches it for 6 h. |
| `KODIK_API_HOST`| Pin the Kodik API host if auto-discovery ever picks the wrong one.     |

### 4. Run locally

```bash
npm run dev     # http://localhost:8787
```

### 5. Deploy

```bash
npm run deploy
```

## Database migrations

`schema.sql` always describes the current schema and is safe to re-run.
Migrations are only needed for databases created by an older release:

| File             | When to run                                                          |
|------------------|----------------------------------------------------------------------|
| `migrate-v6.sql` | Once, on pre-v6 databases: adds the `auth_attempts` table (rate limiting) and `users.token_epoch` (token revocation) |

```bash
npx wrangler d1 execute aniwired --remote --file=./migrate-v6.sql
```

The Worker degrades gracefully while a migration is missing (rate limiting
fails open, revocation checks are skipped) and its error responses name the
file to run.

## API reference

All routes live under `/api`; authenticated routes expect
`Authorization: Bearer <token>`.

| Method | Path | Auth | Body / result |
|---|---|---|---|
| POST | `/api/auth/register` | - | `{username,password}` → `{token,user}` |
| POST | `/api/auth/login` | - | `{username,password}` → `{token,user}` |
| GET | `/api/auth/me` | Bearer | `{user, settings}` (+ rotated `token` when close to expiry) |
| PUT | `/api/auth/password` | Bearer | `{currentPassword,newPassword}` → `{ok,token}`, signs out other devices |
| POST | `/api/auth/logout-all` | Bearer | `{ok:true}`, revokes every issued token |
| DELETE | `/api/account` | Bearer | `{password}` → `{ok,deleted}`, cascades to all data |
| GET | `/api/account/export` | Bearer | full JSON takeout of the account |
| GET | `/api/progress` | Bearer | `{items:[...]}` |
| GET | `/api/progress/last` | Bearer | `{item}` |
| PUT | `/api/progress` | Bearer | `{item}` → upsert (merges the watched-episode set) |
| POST | `/api/progress/bulk` | Bearer | `{items:[...]}` → merge |
| DELETE | `/api/progress/:animeId` | Bearer | `{ok:true}` |
| DELETE | `/api/progress` | Bearer | `{ok:true, cleared:true}` |
| GET | `/api/comments/:animeId` | - | `{items:[...]}` (`mine:true` on your own) |
| POST | `/api/comments` | Bearer | `{animeId,body,animeName}` → `{ok,item}` |
| DELETE | `/api/comments/:id` | Bearer | `{ok:true}` (author only) |
| GET | `/api/kodik/token` | - | `{token}`, Kodik token fetched server-side |
| GET | `/api/kodik/diag` | - | token source, discovered API hosts, per-attempt results |
| GET | `/api/kodik/search?title=` | - | `{results:[...]}`, proxied Kodik title search |
| GET | `/api/settings` | Bearer | `{settings:{historyPublic,profilePublic}}` |
| PUT | `/api/settings` | Bearer | `{historyPublic,profilePublic}` → `{settings}` |
| GET | `/api/users/:username` | optional | `{user,isSelf,hidden,stats,items,comments,friends,relation,counts}` |
| GET | `/api/follows` | Bearer | your `{friends,following,followers,counts}` |
| GET | `/api/follows/:username` | optional | same shape for that person (empty when the profile is hidden) |
| POST | `/api/follow/:username` | Bearer | subscribe → `{ok,user,relation,counts}` |
| DELETE | `/api/follow/:username` | Bearer | unsubscribe → `{ok,user,relation,counts}` |

## Usage

Keyboard shortcuts:

| Key         | Action                    |
|-------------|---------------------------|
| `H`         | Home                      |
| `U`         | My history (profile page) |
| `T`         | Top 100                   |
| `R`         | Random title              |
| `Shift + S` | Force history sync        |

A title appears in *Continue watching* only after 30 real seconds of playback,
so simply opening a page never pollutes the history. Kodik links are pinned to
episode 1 unless they already carry an episode number, so opening a new show
never drops you into the latest episode.
