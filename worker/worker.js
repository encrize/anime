const TE = new TextEncoder();
const TD = new TextDecoder();

const ALLOWED_ORIGINS = new Set([
  'https://anime.encrize.vip',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

function corsFor(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://kodik-add.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data: https:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://anilibria.top https://*.anilibria.top https://api.anilibria.tv https://*.anilibria.tv https://graphql.anilist.co https://api.themoviedb.org https://kodik-api.com https://kodik-add.com https://cdn.jsdelivr.net https://cloudflareinsights.com https://static.cloudflareinsights.com",
    "frame-src https://kodikplayer.com https://*.kodikplayer.com https://kodik.info https://*.kodik.info https://aniqit.com https://*.aniqit.com https://*.kodik-storage.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};

const CSP_REPORT_ONLY = false;

function withSecurityHeaders(response, request) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (k === 'Content-Security-Policy' && CSP_REPORT_ONLY) {
      out.headers.set('Content-Security-Policy-Report-Only', v);
    } else {
      out.headers.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(corsFor(request))) out.headers.set(k, v);
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const fail = (message, status = 400, code = 'error') => json({ error: message, code }, status);

function b64urlFromBytes(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlFromString = (s) => b64urlFromBytes(TE.encode(s));
const stringFromB64url = (s) => TD.decode(bytesFromB64url(s));

function requireSecret(env) {
  const s = env && env.JWT_SECRET;
  if (!s || String(s).length < 32) {
    throw new Error('JWT_SECRET is not configured (needs at least 32 characters). Run: wrangler secret put JWT_SECRET');
  }
  return s;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', TE.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

async function signJWT(payload, secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64urlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = head + '.' + b64urlFromString(JSON.stringify(body));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), TE.encode(data));
  return data + '.' + b64urlFromBytes(sig);
}

async function verifyJWT(token, secret) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, s] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), bytesFromB64url(s), TE.encode(h + '.' + p));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(stringFromB64url(p)); } catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

const PBKDF2_ITER = 100000;

async function derive(password, saltBytes, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', TE.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64urlFromBytes(salt)}$${b64urlFromBytes(hash)}`;
}

function needsRehash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  return !Number.isFinite(iter) || iter < PBKDF2_ITER;
}

async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;
  const salt = bytesFromB64url(parts[2]);
  const expected = bytesFromB64url(parts[3]);
  const actual = await derive(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,19}$/;

function validCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
    return 'Username: 3-20 characters, letters, digits, _ . - only';
  }
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 200) return 'Password is too long';
  return null;
}

async function rateLimit(env, key, max = 10, windowMs = 600000) {
  const now = Date.now();
  try {
    const row = await env.DB.prepare(
      'SELECT count, reset_at FROM auth_attempts WHERE key = ?1').bind(key).first();
    if (row && row.reset_at > now) {
      if (row.count >= max) return false;
      await env.DB.prepare('UPDATE auth_attempts SET count = count + 1 WHERE key = ?1').bind(key).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO auth_attempts (key, count, reset_at) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = ?2`).bind(key, now + windowMs).run();
    }
    return true;
  } catch (_) {
    return true;
  }
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || '0.0.0.0';

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const animeId = String(raw.id != null ? raw.id : raw.anime_id != null ? raw.anime_id : '').trim();
  if (!animeId || animeId.length > 64) return null;
  const num = (v, d = 0) => (Number.isFinite(+v) ? Math.max(0, Math.floor(+v)) : d);
  const seen = Array.isArray(raw.seen)
    ? [...new Set(raw.seen.map((v) => num(v, -1)).filter((v) => v >= 0))].sort((a, b) => a - b).slice(0, 2000)
    : [];
  return {
    id: animeId,
    name: String(raw.name || '').slice(0, 300),
    poster: String(raw.poster || '').slice(0, 600),
    idx: num(raw.idx, 0),
    quality: String(raw.quality || '').slice(0, 32),
    time: num(raw.time, 0),
    duration: num(raw.duration, 0),
    epLabel: String(raw.epLabel != null ? raw.epLabel : '').slice(0, 32),
    epTotal: num(raw.epTotal, 0),
    source: String(raw.source || 'libria').slice(0, 16),
    seen,
    ts: num(raw.ts, Date.now()),
  };
}

function parseSeen(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const rowToItem = (r) => ({
  id: r.anime_id,
  name: r.name,
  poster: r.poster,
  idx: r.episode_idx,
  quality: r.quality,
  time: r.time_sec,
  duration: r.duration_sec,
  epLabel: r.ep_label,
  epTotal: r.ep_total,
  source: r.source,
  seen: parseSeen(r.seen_json),
  ts: r.updated_at,
});

async function loadUserRow(env, column, value) {
  const cols = 'id, username, display_name, created_at, history_public, profile_public';
  try {
    return await env.DB.prepare(`SELECT ${cols} FROM users WHERE ${column} = ?1`).bind(value).first();
  } catch (_) {
    const row = await env.DB.prepare(
      `SELECT id, username, display_name, created_at FROM users WHERE ${column} = ?1`).bind(value).first();
    if (row) { row.history_public = 1; row.profile_public = 1; }
    return row;
  }
}

const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name || row.username,
  createdAt: row.created_at,
});

const settingsOf = (row) => ({
  historyPublic: row.history_public == null ? true : !!row.history_public,
  profilePublic: row.profile_public == null ? true : !!row.profile_public,
});

function statsOf(items) {
  let episodes = 0, seconds = 0, finished = 0;
  for (const it of items) {
    const seen = Array.isArray(it.seen) && it.seen.length ? it.seen.length : 1;
    episodes += seen;
    seconds += (it.duration ? Math.max(0, seen - 1) * it.duration : 0) + (it.time || 0);
    if (it.duration > 30 && it.time / it.duration >= 0.9) finished++;
  }
  return { titles: items.length, episodes, seconds, finished };
}

const FOLLOW_MISSING =
  'Follows table is missing. Run: wrangler d1 execute aniwired --remote --file=./schema.sql';

const userCard = (r) => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name || r.username,
  profilePublic: r.profile_public == null ? true : !!r.profile_public,
  since: r.created_at || null,
  friend: !!r.friend,
});

async function followCounts(env, userId) {
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows f
           WHERE f.follower_id = ?1
             AND NOT EXISTS (SELECT 1 FROM follows b
                              WHERE b.follower_id = f.following_id AND b.following_id = ?1)) AS following,
         (SELECT COUNT(*) FROM follows f
           WHERE f.following_id = ?1
             AND NOT EXISTS (SELECT 1 FROM follows b
                              WHERE b.follower_id = ?1 AND b.following_id = f.follower_id)) AS followers,
         (SELECT COUNT(*) FROM follows f JOIN follows b
            ON b.follower_id = f.following_id AND b.following_id = f.follower_id
           WHERE f.follower_id = ?1) AS friends`).bind(userId).first();
    return {
      following: (row && row.following) || 0,
      followers: (row && row.followers) || 0,
      friends: (row && row.friends) || 0,
    };
  } catch (_) {
    return { following: 0, followers: 0, friends: 0 };
  }
}

async function relationOf(env, viewerId, targetId) {
  const none = { isFollowing: false, followsMe: false, isFriend: false, isSelf: false };
  if (!viewerId || !targetId) return none;
  if (viewerId === targetId) return { ...none, isSelf: true };
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT 1 FROM follows WHERE follower_id = ?1 AND following_id = ?2) AS out_edge,
         (SELECT 1 FROM follows WHERE follower_id = ?2 AND following_id = ?1) AS in_edge`)
      .bind(viewerId, targetId).first();
    const isFollowing = !!(row && row.out_edge);
    const followsMe = !!(row && row.in_edge);
    return { isFollowing, followsMe, isFriend: isFollowing && followsMe, isSelf: false };
  } catch (_) {
    return none;
  }
}

async function listFollows(env, userId, kind, limit = 200) {
  let sql;
  if (kind === 'followers') {
    sql = `SELECT u.id, u.username, u.display_name, u.created_at, u.profile_public, 0 AS friend
             FROM follows f JOIN users u ON u.id = f.follower_id
            WHERE f.following_id = ?1
              AND NOT EXISTS (SELECT 1 FROM follows b
                               WHERE b.follower_id = ?1 AND b.following_id = f.follower_id)
            ORDER BY f.created_at DESC LIMIT ?2`;
  } else if (kind === 'friends') {
    sql = `SELECT u.id, u.username, u.display_name, u.created_at, u.profile_public, 1 AS friend
             FROM follows f
             JOIN follows b ON b.follower_id = f.following_id AND b.following_id = f.follower_id
             JOIN users u ON u.id = f.following_id
            WHERE f.follower_id = ?1 ORDER BY f.created_at DESC LIMIT ?2`;
  } else {
    sql = `SELECT u.id, u.username, u.display_name, u.created_at, u.profile_public, 0 AS friend
             FROM follows f JOIN users u ON u.id = f.following_id
            WHERE f.follower_id = ?1
              AND NOT EXISTS (SELECT 1 FROM follows b
                               WHERE b.follower_id = f.following_id AND b.following_id = ?1)
            ORDER BY f.created_at DESC LIMIT ?2`;
  }

  try {
    const { results } = await env.DB.prepare(sql).bind(userId, limit).all();
    return (results || []).map(userCard);
  } catch (_) {
    return [];
  }
}


const commentRow = (r, viewerId) => ({
  id: r.id,
  animeId: r.anime_id,
  animeName: r.anime_name || '',
  body: r.body,
  createdAt: r.created_at,
  mine: !!viewerId && viewerId === r.user_id,
  user: {
    id: r.user_id,
    username: r.username,
    displayName: r.display_name || r.username,
    profilePublic: r.profile_public == null ? true : !!r.profile_public,
  },
});

async function listComments(env, animeId, viewerId, limit = 200) {
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `SELECT c.*, u.username, u.display_name, u.profile_public
         FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.anime_id = ?1 ORDER BY c.created_at DESC LIMIT ?2`).bind(animeId, limit).all());
  } catch (_) {
    ({ results } = await env.DB.prepare(
      `SELECT c.*, u.username, u.display_name
         FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.anime_id = ?1 ORDER BY c.created_at DESC LIMIT ?2`).bind(animeId, limit).all());
  }
  return (results || []).map((r) => commentRow(r, viewerId));
}

async function requireUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const payload = await verifyJWT(token, requireSecret(env));
  if (!payload || !payload.sub) return null;

  try {
    const row = await env.DB.prepare('SELECT token_epoch FROM users WHERE id = ?1').bind(payload.sub).first();
    if (row && (row.token_epoch || 0) > (payload.epoch || 0)) return null;
  } catch (_) {
  }

  return {
    id: payload.sub,
    username: payload.username || payload.email,
    epoch: payload.epoch || 0,
    exp: payload.exp || 0,
  };
}

const TOKEN_REFRESH_WINDOW_SECONDS = 60 * 60 * 24;

async function maybeRefreshToken(env, user) {
  const now = Math.floor(Date.now() / 1000);
  if (!user || !user.exp || user.exp - now > TOKEN_REFRESH_WINDOW_SECONDS) return null;
  try {
    return await signJWT(
      { sub: user.id, username: user.username, epoch: user.epoch || 0 },
      requireSecret(env), TOKEN_TTL_SECONDS);
  } catch (_) {
    return null;
  }
}

async function upsertProgress(env, userId, item) {
  return env.DB.prepare(
    `INSERT INTO progress (user_id, anime_id, name, poster, episode_idx, quality, time_sec, duration_sec,
                           ep_label, ep_total, source, seen_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(user_id, anime_id) DO UPDATE SET
       name         = excluded.name,
       poster       = excluded.poster,
       episode_idx  = excluded.episode_idx,
       quality      = excluded.quality,
       time_sec     = excluded.time_sec,
       duration_sec = excluded.duration_sec,
       ep_label     = excluded.ep_label,
       ep_total     = excluded.ep_total,
       source       = excluded.source,
       -- Union of both sets, so a device that was offline never drops episodes
       -- another device already recorded.
       seen_json    = (SELECT json_group_array(value) FROM (
                         SELECT DISTINCT CAST(value AS INTEGER) AS value FROM (
                           SELECT value FROM json_each(
                             CASE WHEN json_valid(progress.seen_json) THEN progress.seen_json ELSE '[]' END)
                           UNION
                           SELECT value FROM json_each(
                             CASE WHEN json_valid(excluded.seen_json) THEN excluded.seen_json ELSE '[]' END)
                         ) ORDER BY value LIMIT 2000)),
       updated_at   = excluded.updated_at
     WHERE excluded.updated_at >= progress.updated_at`)
    .bind(userId, item.id, item.name, item.poster, item.idx, item.quality, item.time, item.duration,
          item.epLabel, item.epTotal, item.source, JSON.stringify(item.seen), item.ts)
    .run();
}

async function tokenEpochOf(env, userId) {
  try {
    const row = await env.DB.prepare('SELECT token_epoch FROM users WHERE id = ?1').bind(userId).first();
    return (row && row.token_epoch) || 0;
  } catch (_) {
    return 0;
  }
}

const KODIK_API_HOSTS_DEFAULT = ['kodik-api.com', 'kodikapi.com'];
const KODIK_ADD_SCRIPT = 'https://kodik-add.com/add-players.min.js?v=2';
const KODIK_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const KODIK_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let kodikLoaderCache = { at: 0, tokens: [], hosts: [] };
let kodikWorking = { host: '', token: '', at: 0 };

function extractKodikTokens(txt) {
  const out = [];
  const push = (v) => {
    if (v && out.indexOf(v) === -1) out.push(v);
  };
  let m;
  const explicit = /['"]?token['"]?\s*[:=]\s*['"]([0-9a-zA-Z]{16,})['"]/gi;
  while ((m = explicit.exec(txt)) !== null) push(m[1]);
  const hex32 = /['"]([0-9a-f]{32})['"]/gi;
  while ((m = hex32.exec(txt)) !== null) push(m[1]);

  const score = (s) => (/^[0-9a-f]{32}$/.test(s) ? 2 : s.length === 32 ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a)).slice(0, 6);
}

async function kodikLoader() {
  const now = Date.now();
  if (kodikLoaderCache.at && now - kodikLoaderCache.at < KODIK_TOKEN_TTL_MS) {
    return kodikLoaderCache;
  }
  const out = { at: now, tokens: [], hosts: [] };
  try {
    const r = await fetch(KODIK_ADD_SCRIPT, { headers: { 'User-Agent': KODIK_UA } });
    if (r.ok) {
      const txt = await r.text();
      out.tokens = extractKodikTokens(txt);

      const found = new Set();
      const re = /https?:\/\/([a-z0-9.-]*kodik[a-z0-9.-]*\.[a-z]{2,})/gi;
      let hit;
      while ((hit = re.exec(txt)) !== null) {
        const host = hit[1].toLowerCase();
        if (host.includes('api')) found.add(host);
      }
      out.hosts = Array.from(found);
    }
  } catch (_) { /* fall through to defaults */ }
  kodikLoaderCache = out;
  return out;
}

async function kodikTokens(env) {
  const list = [];
  if (env.KODIK_TOKEN) list.push(String(env.KODIK_TOKEN).trim());
  if (kodikWorking.token) list.push(kodikWorking.token);
  for (const t of (await kodikLoader()).tokens) list.push(t);
  return Array.from(new Set(list.filter(Boolean)));
}

async function kodikToken(env) {
  return (await kodikTokens(env))[0] || '';
}

async function kodikApiHosts(env) {
  const hosts = [];
  if (env.KODIK_API_HOST) hosts.push(String(env.KODIK_API_HOST).replace(/^https?:\/\//, '').replace(/\/+$/, ''));
  for (const h of (await kodikLoader()).hosts) hosts.push(h);
  for (const h of KODIK_API_HOSTS_DEFAULT) hosts.push(h);
  return Array.from(new Set(hosts));
}

async function kodikSearch(params, hosts, tokens) {
  const tried = [];

  const pairs = [];
  const seen = new Set();
  const addPair = (host, token) => {
    const key = host + '|' + token;
    if (host && token && !seen.has(key)) {
      seen.add(key);
      pairs.push({ host, token });
    }
  };
  if (Date.now() - kodikWorking.at < KODIK_TOKEN_TTL_MS) {
    addPair(kodikWorking.host, kodikWorking.token);
  }
  for (const host of hosts) for (const token of tokens) addPair(host, token);

  for (const pair of pairs) {
    const host = pair.host;
    const search = new URLSearchParams(params);
    search.set('token', pair.token);
    const shown = host + ' token\u2026' + pair.token.slice(-6);
    const base = 'https://' + host;
    const attempts = [
      {
        label: 'POST ' + shown,
        url: base + '/search',
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': KODIK_UA,
          },
          body: search.toString(),
        },
      },
      {
        label: 'GET ' + shown,
        url: base + '/search?' + search.toString(),
        init: {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': KODIK_UA },
        },
      },
    ];

    for (const attempt of attempts) {
      let res;
      try {
        res = await fetch(attempt.url, attempt.init);
      } catch (err) {
        tried.push(attempt.label + ' network error: ' + (err && err.message ? err.message : String(err)));
        continue;
      }
      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch (_) {
          tried.push(attempt.label + ' returned a non-JSON body');
          continue;
        }
        if (data && data.error) {
          tried.push(attempt.label + ' -> ' + String(data.error).slice(0, 120));
          continue;
        }
        kodikWorking = { host: host, token: pair.token, at: Date.now() };
        return { data, tried };
      }
      let body = '';
      try {
        body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch (_) { /* body is optional context */ }
      tried.push(attempt.label + ' -> HTTP ' + res.status + (body ? ': ' + body : ''));
    }
  }

  return { error: tried.join(' | ') || 'no attempt ran', tried };
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  if (!env.DB) return fail('D1 binding "DB" is not configured. Run: wrangler d1 create aniwired', 500);

  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    try { body = await request.json(); } catch { body = {}; }
  }

  if (path === '/api/auth/register' && method === 'POST') {
    if (!(await rateLimit(env, 'auth:' + clientIp(request)))) {
      return fail('Too many attempts, try again later', 429, 'auth.rate_limited');
    }
    const raw = String(body.username || '').trim();
    const username = raw.toLowerCase();
    const password = String(body.password || '');
    const bad = validCredentials(raw, password);
    if (bad) return fail(bad, 422, 'auth.invalid_credentials_format');

    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
    if (exists) return fail('This username is already taken', 409, 'auth.username_taken');

    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(id, username, raw, await hashPassword(password), Date.now()).run();

    const token = await signJWT({ sub: id, username, epoch: 0 }, requireSecret(env), TOKEN_TTL_SECONDS);
    return json({ token, user: { id, username, displayName: raw } }, 201);
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (!(await rateLimit(env, 'auth:' + clientIp(request)))) {
      return fail('Too many attempts, try again later', 429, 'auth.rate_limited');
    }
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) return fail('Username and password are required', 422, 'auth.missing_credentials');

    const row = await env.DB.prepare(
      'SELECT id, username, display_name, password_hash FROM users WHERE username = ?1').bind(username).first();
    if (!row || !(await checkPassword(password, row.password_hash))) {
      return fail('Wrong username or password', 401, 'auth.bad_credentials');
    }

    if (needsRehash(row.password_hash)) {
      const rehash = env.DB.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1')
        .bind(row.id, await hashPassword(password)).run();
      if (ctx && ctx.waitUntil) ctx.waitUntil(rehash); else await rehash;
    }

    const token = await signJWT(
      { sub: row.id, username: row.username, epoch: await tokenEpochOf(env, row.id) },
      requireSecret(env), TOKEN_TTL_SECONDS);
    return json({ token, user: { id: row.id, username: row.username, displayName: row.display_name || row.username } });
  }

  const user = await requireUser(request, env);

  if (path === '/api/auth/me' && method === 'GET') {
    if (!user) return fail('Unauthorized', 401, 'auth.unauthorized');
    const row = await loadUserRow(env, 'id', user.id);
    if (!row) return fail('Unauthorized', 401, 'auth.unauthorized');
    const fresh = await maybeRefreshToken(env, user);
    const out = { user: publicUser(row), settings: settingsOf(row) };
    if (fresh) out.token = fresh;
    return json(out);
  }

  if (path === '/api/auth/password' && method === 'PUT') {
    if (!user) return fail('Unauthorized', 401, 'auth.unauthorized');
    if (!(await rateLimit(env, 'pwd:' + user.id, 10, 600000))) {
      return fail('Too many attempts, try again later', 429, 'auth.rate_limited');
    }

    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(user.id).first();
    if (!row || !(await checkPassword(String(body.currentPassword || ''), row.password_hash))) {
      return fail('Current password is wrong', 403, 'auth.wrong_current_password');
    }

    const newPassword = String(body.newPassword || '');
    const bad = validCredentials('placeholder', newPassword);
    if (bad) return fail(bad, 422, 'auth.invalid_credentials_format');
    if (newPassword === String(body.currentPassword || '')) {
      return fail('The new password must be different', 422, 'auth.password_unchanged');
    }

    const hash = await hashPassword(newPassword);
    let epoch = 0;
    try {
      epoch = (await tokenEpochOf(env, user.id)) + 1;
      await env.DB.prepare('UPDATE users SET password_hash = ?2, token_epoch = ?3 WHERE id = ?1')
        .bind(user.id, hash, epoch).run();
    } catch (_) {
      await env.DB.prepare('UPDATE users SET password_hash = ?2 WHERE id = ?1').bind(user.id, hash).run();
    }

    const token = await signJWT({ sub: user.id, username: user.username, epoch }, requireSecret(env), TOKEN_TTL_SECONDS);
    return json({ ok: true, token });
  }

  if (path === '/api/auth/logout-all' && method === 'POST') {
    if (!user) return fail('Unauthorized', 401, 'auth.unauthorized');
    try {
      await env.DB.prepare('UPDATE users SET token_epoch = ?2 WHERE id = ?1')
        .bind(user.id, (await tokenEpochOf(env, user.id)) + 1).run();
    } catch (_) {
      return fail('Run: wrangler d1 execute aniwired --remote --file=./migrate-v6.sql', 500, 'db.migration_required');
    }
    return json({ ok: true });
  }

  if (path === '/api/account' && method === 'DELETE') {
    if (!user) return fail('Unauthorized', 401, 'auth.unauthorized');
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?1').bind(user.id).first();
    if (!row || !(await checkPassword(String(body.password || ''), row.password_hash))) {
      return fail('Password is wrong', 403, 'auth.wrong_password');
    }
    await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id).run();
    return json({ ok: true, deleted: true });
  }

  if (path === '/api/account/export' && method === 'GET') {
    if (!user) return fail('Unauthorized', 401, 'auth.unauthorized');
    const me = await loadUserRow(env, 'id', user.id);
    if (!me) return fail('Unauthorized', 401, 'auth.unauthorized');

    const progress = await env.DB.prepare(
      'SELECT * FROM progress WHERE user_id = ?1 ORDER BY updated_at DESC').bind(user.id).all();
    let comments = [];
    try {
      const r = await env.DB.prepare(
        'SELECT id, anime_id, anime_name, body, created_at FROM comments WHERE user_id = ?1 ORDER BY created_at DESC')
        .bind(user.id).all();
      comments = r.results || [];
    } catch (_) { comments = []; }

    return json({
      exportedAt: new Date().toISOString(),
      user: publicUser(me),
      settings: settingsOf(me),
      progress: (progress.results || []).map(rowToItem),
      comments,
      follows: {
        friends: await listFollows(env, user.id, 'friends', 1000),
        following: await listFollows(env, user.id, 'following', 1000),
        followers: await listFollows(env, user.id, 'followers', 1000),
      },
    });
  }

  if (path === '/api/kodik/token' && method === 'GET') {
    if (!(await rateLimit(env, 'kodik:' + clientIp(request), 60, 3600000))) {
      return fail('Too many requests, slow down', 429, 'kodik.rate_limited');
    }
    const token = await kodikToken(env);
    if (!token) return fail('Kodik token is unavailable', 502, 'kodik.no_token');
    return json({ token });
  }

  if (path === '/api/kodik/diag' && method === 'GET') {
    if (!(await rateLimit(env, 'kodik:' + clientIp(request), 60, 3600000))) {
      return fail('Too many requests, slow down', 429, 'kodik.rate_limited');
    }
    const loader = await kodikLoader();
    const tokens = await kodikTokens(env);
    const hosts = await kodikApiHosts(env);
    let probe = { tried: [], data: null };
    if (tokens.length) {
      probe = await kodikSearch(new URLSearchParams({ title: 'K-On!', limit: '1' }), hosts, tokens);
    }
    return json({
      tokenSource: env.KODIK_TOKEN ? 'secret' : loader.tokens.length ? 'loader-script' : 'none',
      tokenCandidates: tokens.length,
      hostsFromLoader: loader.hosts,
      hostsTried: hosts,
      ok: Boolean(probe.data),
      resultCount: probe.data && Array.isArray(probe.data.results) ? probe.data.results.length : 0,
      attempts: probe.tried,
    });
  }

  if (path === '/api/kodik/search' && method === 'GET') {
    if (!(await rateLimit(env, 'kodik:' + clientIp(request), 60, 3600000))) {
      return fail('Too many requests, slow down', 429, 'kodik.rate_limited');
    }
    const title = String(url.searchParams.get('title') || '').trim();
    const shikimoriId = String(url.searchParams.get('shikimoriId') || '').trim();
    if (!title && !shikimoriId) {
      return fail('title or shikimoriId is required', 400, 'kodik.bad_request');
    }
    const tokens = await kodikTokens(env);
    if (!tokens.length) return fail('Kodik token is unavailable', 502, 'kodik.no_token');

    const params = new URLSearchParams({ limit: '50' });
    if (shikimoriId) params.set('shikimori_id', shikimoriId);
    else params.set('title', title);

    const { data, error } = await kodikSearch(params, await kodikApiHosts(env), tokens);
    if (error) return fail('Kodik search failed - ' + error, 502, 'kodik.upstream');

    const results = Array.isArray(data.results) ? data.results : [];
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  if (path === '/api/settings') {
    if (!user) return fail('Unauthorized', 401);

    if (method === 'GET') {
      const row = await loadUserRow(env, 'id', user.id);
      if (!row) return fail('Unauthorized', 401);
      return json({ settings: settingsOf(row) });
    }

    if (method === 'PUT') {
      const historyPublic = body.historyPublic ? 1 : 0;
      const profilePublic = body.profilePublic ? 1 : 0;
      try {
        await env.DB.prepare(
          'UPDATE users SET history_public = ?2, profile_public = ?3 WHERE id = ?1')
          .bind(user.id, historyPublic, profilePublic).run();
      } catch (_) {
        return fail('Privacy columns are missing. Run: wrangler d1 execute aniwired --remote --file=./schema.sql', 500);
      }
      return json({ ok: true, settings: { historyPublic: !!historyPublic, profilePublic: !!profilePublic } });
    }
  }

  if (path === '/api/comments' && method === 'POST') {
    if (!user) return fail('Sign in to leave a comment', 401, 'auth.unauthorized');
    if (!(await rateLimit(env, 'cmt:' + user.id, 20, 3600000))) {
      return fail('You are commenting too fast, try again later', 429, 'comments.rate_limited');
    }
    const animeId = String(body.animeId != null ? body.animeId : '').trim();
    const text = String(body.body || '').trim();
    if (!animeId || animeId.length > 64) return fail('anime id is required', 422);
    if (!text) return fail('Comment cannot be empty', 422);
    if (text.length > 1000) return fail('Comment is too long (1000 characters max)', 422);

    const id = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.prepare(
        'INSERT INTO comments (id, anime_id, anime_name, user_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(id, animeId, String(body.animeName || '').slice(0, 300), user.id, text, now).run();
    } catch (_) {
      return fail('Comments table is missing. Run: wrangler d1 execute aniwired --remote --file=./schema.sql', 500);
    }

    const me = await loadUserRow(env, 'id', user.id);
    return json({
      ok: true,
      item: commentRow({
        id, anime_id: animeId, anime_name: String(body.animeName || ''), user_id: user.id,
        body: text, created_at: now,
        username: me ? me.username : user.username,
        display_name: me ? me.display_name : '',
        profile_public: me ? me.profile_public : 1,
      }, user.id),
    }, 201);
  }

  if (path.startsWith('/api/comments/')) {
    const tail = decodeURIComponent(path.slice('/api/comments/'.length));

    if (method === 'GET') {
      if (!tail) return fail('anime id is required', 422);
      try {
        return json({ items: await listComments(env, tail, user && user.id) });
      } catch (_) {
        return json({ items: [] });
      }
    }

    if (method === 'DELETE') {
      if (!user) return fail('Unauthorized', 401);
      const row = await env.DB.prepare('SELECT user_id FROM comments WHERE id = ?1').bind(tail).first();
      if (!row) return fail('Comment not found', 404);
      if (row.user_id !== user.id) return fail('You can only delete your own comments', 403);
      await env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(tail).run();
      return json({ ok: true });
    }
  }

  if (path === '/api/follows' || path.startsWith('/api/follows/')) {
    if (method !== 'GET') return fail('Method not allowed', 405);

    const tail = path === '/api/follows'
      ? ''
      : decodeURIComponent(path.slice('/api/follows/'.length)).trim().toLowerCase();

    let owner;
    if (tail) {
      owner = await loadUserRow(env, 'username', tail);
      if (!owner) return fail('User not found', 404);
      const s = settingsOf(owner);
      if (!s.profilePublic && !(user && user.id === owner.id)) {
        return json({ friends: [], following: [], followers: [], hidden: 'profile' });
      }
    } else {
      if (!user) return fail('Unauthorized', 401);
      owner = await loadUserRow(env, 'id', user.id);
      if (!owner) return fail('Unauthorized', 401);
    }

    const [friends, following, followers] = await Promise.all([
      listFollows(env, owner.id, 'friends'),
      listFollows(env, owner.id, 'following'),
      listFollows(env, owner.id, 'followers'),
    ]);
    return json({ friends, following, followers, counts: await followCounts(env, owner.id) });
  }

  if (path.startsWith('/api/follow/')) {
    if (!user) return fail('Sign in to follow other people', 401);

    const uname = decodeURIComponent(path.slice('/api/follow/'.length)).trim().toLowerCase();
    if (!uname) return fail('username is required', 422);

    const target = await loadUserRow(env, 'username', uname);
    if (!target) return fail('User not found', 404);
    if (target.id === user.id) return fail('You cannot follow yourself', 422);

    if (method === 'POST') {
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?1, ?2, ?3)')
          .bind(user.id, target.id, Date.now()).run();
      } catch (_) {
        return fail(FOLLOW_MISSING, 500);
      }
    } else if (method === 'DELETE') {
      try {
        await env.DB.prepare(
          'DELETE FROM follows WHERE follower_id = ?1 AND following_id = ?2')
          .bind(user.id, target.id).run();
      } catch (_) {
        return fail(FOLLOW_MISSING, 500);
      }
    } else {
      return fail('Method not allowed', 405);
    }

    return json({
      ok: true,
      user: publicUser(target),
      relation: await relationOf(env, user.id, target.id),
      counts: await followCounts(env, target.id),
    });
  }

  if (path.startsWith('/api/users/') && method === 'GET') {
    const uname = decodeURIComponent(path.slice('/api/users/'.length)).trim().toLowerCase();
    if (!uname) return fail('username is required', 422);

    const row = await loadUserRow(env, 'username', uname);
    if (!row) return fail('User not found', 404);

    const settings = settingsOf(row);
    const isSelf = !!user && user.id === row.id;
    const relation = await relationOf(env, user && user.id, row.id);
    const counts = await followCounts(env, row.id);

    if (!settings.profilePublic && !isSelf) {
      return json({
        user: publicUser(row), isSelf: false, hidden: 'profile',
        stats: null, items: [], comments: [], friends: [], relation, counts,
      });
    }

    const friends = await listFollows(env, row.id, 'friends', 24);

    let comments = [];
    try {
      const { results } = await env.DB.prepare(
        `SELECT c.*, u.username, u.display_name
           FROM comments c JOIN users u ON u.id = c.user_id
          WHERE c.user_id = ?1 ORDER BY c.created_at DESC LIMIT 20`).bind(row.id).all();
      comments = (results || []).map((r) => commentRow(r, user && user.id));
    } catch (_) { comments = []; }

    if (!settings.historyPublic && !isSelf) {
      return json({
        user: publicUser(row), isSelf: false, hidden: 'history',
        stats: null, items: [], comments, friends, relation, counts,
      });
    }

    const { results } = await env.DB.prepare(
      'SELECT * FROM progress WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 100').bind(row.id).all();
    const items = (results || []).map(rowToItem);

    return json({
      user: publicUser(row),
      isSelf,
      hidden: null,
      settings: isSelf ? settings : undefined,
      stats: statsOf(items),
      items,
      comments,
      friends,
      relation,
      counts,
    });
  }

  if (path.startsWith('/api/progress')) {
    if (!user) return fail('Unauthorized', 401);

    if (path === '/api/progress' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM progress WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 100').bind(user.id).all();
      return json({ items: (results || []).map(rowToItem) });
    }

    if (path === '/api/progress/last' && method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT * FROM progress WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 1').bind(user.id).first();
      return json({ item: row ? rowToItem(row) : null });
    }

    if (path === '/api/progress' && method === 'PUT') {
      const item = normalizeItem(body.item || body);
      if (!item) return fail('Invalid progress payload', 422);
      await upsertProgress(env, user.id, item);
      return json({ ok: true, item });
    }

    if (path === '/api/progress/bulk' && method === 'POST') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 200).map(normalizeItem).filter(Boolean) : [];
      for (const item of items) await upsertProgress(env, user.id, item);
      const { results } = await env.DB.prepare(
        'SELECT * FROM progress WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 100').bind(user.id).all();
      return json({ ok: true, items: (results || []).map(rowToItem) });
    }

    if (path === '/api/progress' && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM progress WHERE user_id = ?1').bind(user.id).run();
      return json({ ok: true, cleared: true });
    }

    if (method === 'DELETE') {
      const animeId = decodeURIComponent(path.slice('/api/progress/'.length));
      if (!animeId) return fail('anime id is required', 422);
      await env.DB.prepare('DELETE FROM progress WHERE user_id = ?1 AND anime_id = ?2').bind(user.id, animeId).run();
      return json({ ok: true });
    }
  }

  return fail('Not found', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const done = (res) => withSecurityHeaders(res, request);

    if (request.method === 'OPTIONS') {
      return done(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return done(await handleApi(request, env, url, ctx));
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (message.indexOf('JWT_SECRET') !== -1) {
          console.error('AniWired config error:', message);
          return done(fail('Server is not configured correctly', 500, 'server.misconfigured'));
        }
        return done(fail('Server error: ' + message, 500, 'server.error'));
      }
    }

    if (env.ASSETS) return done(await env.ASSETS.fetch(request));
    return done(new Response('Static assets binding is not configured', { status: 500 }));
  },
};
