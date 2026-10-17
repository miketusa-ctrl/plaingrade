// Rate limiting, quotas and API keys (shared pattern: certguard -> swearguard/src/limits.js, copied with the key prefix changed).
//  - Per-IP and per-key burst limits: Workers Rate Limiting bindings (per-minute, per-location, approximate).
//  - Per-key daily quota + global daily soft caps: KV counters, batched per isolate to keep KV writes low
//    (KV writes cost money past the included allowance). Counters are approximate by design ("soft" caps) — eventual consistency and
//    concurrent isolates can undercount by up to FLUSH_EVERY × isolates.

const FLUSH_EVERY = 10;      // flush a counter to KV after this many local increments…
const FLUSH_MAX_AGE = 30000; // …or after this many ms
const READ_TTL = 20000;      // re-read a counter from KV at most this often per isolate

export function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

const counters = new Map(); // name -> { base, baseAt, pending, lastFlush }

async function readCounter(kv, name) {
  let c = counters.get(name);
  const now = Date.now();
  if (!c) { c = { base: 0, baseAt: 0, pending: 0, lastFlush: now, flushed: false }; counters.set(name, c); }
  if (now - c.baseAt > READ_TTL) {
    const v = kv ? await kv.get(name) : null;
    c.base = Math.max(c.base, Number(v) || 0);
    c.baseAt = now;
  }
  return c;
}

/** Current approximate value of a counter (KV base + unflushed local increments). */
export async function counterValue(kv, name) {
  const c = await readCounter(kv, name);
  return c.base + c.pending;
}

/**
 * Increment; returns new approximate value. Flush happens in ctx.waitUntil. opts.flushEvery (default 10) and
 * opts.maxAgeMs (default 30 s; Infinity = only flush by count). opts.ttl: KV expirationTtl seconds. opts.flushFirst:
 * also flush on this isolate's first increment of the counter (per-key usage shows up right away
 *   for low-volume keys instead of sitting unflushed in one isolate).
 */
export async function counterIncr(kv, name, ctx, by = 1, opts = {}) {
  const flushEvery = opts.flushEvery || FLUSH_EVERY;
  const maxAge = opts.maxAgeMs === undefined ? FLUSH_MAX_AGE : opts.maxAgeMs;
  const ttl = opts.ttl || 2 * 86400;
  const c = await readCounter(kv, name);
  c.pending += by;
  const value = c.base + c.pending;
  if (kv && (c.pending >= flushEvery || Date.now() - c.lastFlush > maxAge || (opts.flushFirst && !c.flushed))) {
    c.flushed = true;
    const delta = c.pending; c.pending = 0; c.lastFlush = Date.now();
    const p = (async () => {
      try {
        const cur = Number(await kv.get(name)) || 0;
        const next = Math.max(cur + delta, c.base + delta);
        await kv.put(name, String(next), { expirationTtl: Math.max(60, ttl) });
        c.base = next; c.baseAt = Date.now();
      } catch { c.pending += delta; }
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  if (counters.size > 5000) { // bound memory (keys rotate daily)
    const day = utcDay(); const hour = new Date().toISOString().slice(0, 13);
    for (const k of counters.keys()) { if (!k.includes(day) && !k.includes(hour)) counters.delete(k); }
  }
  return value;
}

export function _resetCountersForTests() { counters.clear(); keyCache.clear(); }

// ---------- Rate limit bindings ----------
const memLimiter = new Map();
/** Fallback in-memory limiter if a binding is missing (e.g. unit tests). */
function memLimit(key, limit, periodMs = 60000) {
  const now = Date.now();
  let e = memLimiter.get(key);
  if (!e || now - e.start > periodMs) { e = { start: now, n: 0 }; memLimiter.set(key, e); }
  e.n++;
  if (memLimiter.size > 10000) memLimiter.clear();
  return e.n <= limit;
}

export async function rateLimit(binding, key, fallbackLimit) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return success; } catch { /* fall through */ }
  }
  return memLimit(key, fallbackLimit);
}

// ---------- API keys ----------
const KEY_RE = /^pg_[A-Za-z0-9]{32}$/;

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidKeyFormat(k) { return typeof k === 'string' && KEY_RE.test(k); }

export function generateKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const out = [];
  while (out.length < 32) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) {
      if (b < 248 && out.length < 32) out.push(alphabet[b % 62]); // rejection sampling: 248 = 4*62
    }
  }
  return 'pg_' + out.join('');
}

const keyCache = new Map(); // keyHash -> { rec, at }
/** True if this key's lookup (hit or miss) is cached in this isolate, i.e. lookupKey won't read KV. */
export async function isKeyCached(apiKey) {
  if (!isValidKeyFormat(apiKey)) return true; // malformed keys never reach KV
  const c = keyCache.get(await sha256hex(apiKey));
  return !!c && Date.now() - c.at < 300000;
}
export async function lookupKey(kv, apiKey) {
  if (!isValidKeyFormat(apiKey)) return null;
  const h = await sha256hex(apiKey);
  const c = keyCache.get(h);
  if (c && Date.now() - c.at < 300000) return c.rec;
  const raw = kv ? await kv.get('key:' + h) : null;
  const rec = raw ? { ...JSON.parse(raw), hash: h } : null;
  keyCache.set(h, { rec, at: Date.now() });
  if (keyCache.size > 2000) keyCache.clear();
  return rec;
}

/** HMAC-SHA-256(secret, message) as hex. Used for anything derived from IPs or emails that is stored in KV. */
const hmacKeys = new Map();
export async function hmacHex(secret, message) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, k);
  }
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- client IP bucketing (IPv6 aggregated per /64; never stored raw: only HMACs with HASH_PEPPER) ----------
function expandV6(ip) {
  let s = ip.split('%')[0];
  if (s.includes('.')) { // embedded IPv4 tail
    const i = s.lastIndexOf(':'); const v4 = s.slice(i + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
    s = s.slice(0, i + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}
export function ipBucket(ip) {
  if (typeof ip !== 'string' || !ip) return 'unknown';
  if (ip.includes(':')) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return mapped[1];
    const g = expandV6(ip);
    return g ? g.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64' : 'v6:invalid';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : 'v4:invalid';
}
