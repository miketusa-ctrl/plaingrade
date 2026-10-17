// PlainGrade HTTP layer: routing, body/text caps, rate limits, KV quotas, free-key issuance. Pattern copied from the
// account's CussCheck/SwearGuard Worker. PRIVACY INVARIANT: submitted text is never logged, stored, cached or sent
// anywhere. The only console output in this Worker is the global-cap warning (counts only) and an internal-error line
// (error name only); Workers observability/logs are disabled in wrangler.toml.
import { analyze, ENGINE, DEFAULT_LONG_SENTENCE_WORDS } from './readability.js';
import { rateLimit, counterValue, counterIncr, utcDay, lookupKey, isKeyCached, generateKey, sha256hex, hmacHex, ipBucket } from './limits.js';
import { indexHtml, docsHtml, privacyHtml, appJs } from './pages.js';

import { VERSION, MAX_TEXT_BYTES, LONG_MIN, LONG_MAX, HttpError, validateScoreInput } from './core.js';
import { handleMcp, MCP_CORS } from './mcp.js';
import { llmsTxt, openApiSpec } from './agentdocs.js';
import { validateFleetLicense, isFleetLicenseCached } from './fleet-license.js';
import { isRapidApiPath, handleRapidApi } from './rapidapi.js';
import { PRO_PRODUCT_SLUG, looksLikeProKey, proKeyIdFor, proCheckoutUrl } from './pro.js';
export { VERSION, MAX_TEXT_BYTES, LONG_MIN, LONG_MAX, HttpError, validateScoreInput };
export const OG_IMAGE_PATH = '/og.png';
export const MAX_BODY_BYTES = 48 * 1024;  // 49,152 bytes, POST body (Content-Length and actual bytes read). Room for JSON
                                          // escaping of a 20 KB text (quotes/newlines double); the text cap bounds CPU.
export const COUNTER_TTL = 2 * 86400;     // every KV counter expires after 2 days (matches /privacy)
export const KEY_ISSUE_COST = 4;          // IP_LIMITER tokens per key issuance

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export function config(env) {
  return {
    env: env.ENVIRONMENT || 'development',
    publicLaunch: env.PUBLIC_LAUNCH === 'true',
    build: env.BUILD_COMMIT || 'dev',
    brand: env.BRAND_NAME || 'PlainGrade',
    // Canonical public origin (no path, no trailing slash). Used for <link rel=canonical>, og:url, sitemap and robots
    // Sitemap line, never the request Host header. Invalid/unset -> null -> canonical/og:url omitted.
    publicOrigin: typeof env.PUBLIC_ORIGIN === 'string' && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(env.PUBLIC_ORIGIN) ? env.PUBLIC_ORIGIN : null,
    supportEmail: typeof env.SUPPORT_EMAIL === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(env.SUPPORT_EMAIL) ? env.SUPPORT_EMAIL : null,
    anonPerMin: num(env.ANON_PER_MIN, 10),
    anonDailyPerIp: num(env.ANON_DAILY_PER_IP, 50),
    keyPerMin: num(env.KEY_PER_MIN, 30),
    keyDailyQuota: num(env.KEY_DAILY_QUOTA, 100),
    keyIssuerDailyQuota: num(env.KEY_ISSUER_DAILY_QUOTA, 300),
    keyIssuePerIpPerDay: num(env.KEY_ISSUE_PER_IP_PER_DAY, 3),
    keyIssueGlobalPerDay: num(env.KEY_ISSUE_GLOBAL_PER_DAY, 200),
    globalDailyRequestCap: num(env.GLOBAL_DAILY_REQUEST_CAP, 10000),
    // Pro (Polar license keys): own per-license quota and own global cap, separate from the free pool.
    proDailyQuota: num(env.PRO_DAILY_QUOTA, 5000),
    proGlobalDailyCap: num(env.PRO_GLOBAL_DAILY_CAP, 5000),
    proCheckoutUrl: proCheckoutUrl(env),
    pepper: typeof env.HASH_PEPPER === 'string' && env.HASH_PEPPER.length >= 16 ? env.HASH_PEPPER : null,
  };
}


function baseHeaders(cfg, extra = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'interest-cohort=(), camera=(), microphone=(), geolocation=()',
    ...extra,
  };
  if (!cfg.publicLaunch) h['x-robots-tag'] = 'noindex, nofollow';
  return h;
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-policy, x-api-plan, retry-after',
};
function json(cfg, status, obj, extra = {}, { cors = true, compact = false } = {}) {
  return new Response(compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2), {
    status,
    headers: baseHeaders(cfg, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cors ? CORS : {}), ...extra }),
  });
}
const errBody = (code, message) => ({ ok: false, error: { code, message } });

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function page(cfg, method, body, type = 'text/html; charset=utf-8', extra = {}) {
  return new Response(method === 'HEAD' ? null : body, { headers: baseHeaders(cfg, { 'content-type': type, 'cache-control': 'public, max-age=300', 'content-security-policy': CSP, ...extra }) });
}

const tooLarge = (max) => new HttpError(413, 'body_too_large', `Request body exceeds ${max.toLocaleString('en-US')} bytes (${Math.round(max / 1024)} KB).${max === MAX_BODY_BYTES ? ` Send at most ${MAX_TEXT_BYTES / 1024} KB of text per request.` : ''}`);
export async function readBodyCapped(req, max = MAX_BODY_BYTES) {
  const cl = req.headers.get('content-length');
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > max)) throw tooLarge(max);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const nextResetEpoch = () => { const d = new Date(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000); };
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'unknown';
function requirePepper(cfg) {
  if (!cfg.pepper) throw new HttpError(503, 'not_configured', 'This deployment is missing its HASH_PEPPER secret; the API is disabled until it is set.');
}
export const GLAMA_CLAIM_JSON = '{"$schema":"https://glama.ai/mcp/schemas/connector.json","claim":"<GLAMA_CLAIM_TOKEN>"}';

const friendlyCap = () => 'The service reached its free daily request allowance for today. It resets at 00:00 UTC; please retry later.';

const capWarned = new Set();
function capWarn(used, cap, day) {
  if (!cap) return;
  const pct = (used / cap) * 100;
  for (const t of [100, 80]) {
    if (pct >= t && !capWarned.has(`${day}:${t}`)) {
      capWarned.add(`${day}:${t}`);
      console.warn(`plaingrade-api: global request cap at ${Math.floor(pct)}% (${used}/${cap}) for ${day} UTC`); // counts only
      return;
    }
  }
}

// ---------- auth + quotas (shared by POST /v1/score and POST /mcp) ----------
// v0.3.0: the former authorize() is split into authenticate() (global cap read + key gate) and runCheck() (limiters,
// daily quotas, counters, then the work). The REST order of checks and every message/header is unchanged.
const fail = (e) => ({ ok: false, status: e.status, code: e.code, message: e.message, headers: e.headers || {} });
function presentedKey(req, allowBearer) {
  const k = req.headers.get('x-api-key');
  if (k !== null || !allowBearer) return k;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') || ''); // MCP clients send keys as Bearer
  return m ? m[1] : null;
}

/** Key gate. { ok:true, plan, rec?, capReached?, ... } | { ok:false, status, code, message, headers }. Never echoes the key.
 * allowBearer: MCP only (REST keeps X-API-Key only, so its behaviour is byte-identical to v0.2.3). */
export async function authenticate(req, env, cfg, { allowBearer = false } = {}) {
  try {
    requirePepper(cfg);
    const kv = env.PLAINGRADE_KV;
    const bucket = ipBucket(clientIp(req));
    const day = utcDay();
    const reset = String(nextResetEpoch());
    const apiKey = presentedKey(req, allowBearer);
    // Rate-limiter keys and KV counter names use a keyed HMAC of the IP bucket, never the raw IP.
    const ipHash = (await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32);
    // Global daily soft cap first (approximate, batched KV counter). Reached → runCheck answers 429 before any key
    // lookup (same order as v0.2.x); MCP discovery calls still work.
    const gName = `q:global:req:${day}`;
    const gUsed = await counterValue(kv, gName);
    capWarn(gUsed, cfg.globalDailyRequestCap, day);
    const base = { ok: true, ipHash, day, reset, gName };
    if (apiKey !== null && looksLikeProKey(apiKey)) return { ...base, ...(await authenticatePro(env, cfg, apiKey.trim(), ipHash)) };
    if (gUsed >= cfg.globalDailyRequestCap) return { ...base, plan: apiKey !== null ? 'free_key' : 'anonymous', capReached: true };
    if (apiKey !== null) {
      // Key lookups that would read KV (isolate-cache misses, incl. every new random key) go through the per-IP
      // limiter ('auth:' bucket), so key guessing can't run up KV reads.
      if (!(await isKeyCached(apiKey.trim())) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) {
        throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
      }
      const rec = await lookupKey(kv, apiKey.trim());
      if (!rec || rec.revoked) throw new HttpError(401, 'invalid_api_key', INVALID_KEY_MSG);
      return { ...base, plan: 'free_key', rec };
    }
    return { ...base, plan: 'anonymous' };
  } catch (e) {
    if (e instanceof HttpError) return fail(e);
    throw e;
  }
}

const INVALID_KEY_MSG = 'X-API-Key is not valid. Omit the header for anonymous (lower-rate) use, or get a free key with POST /v1/keys.';
/** Pro license gate: read-only LICENSES KV lookup. Every non-active result (unknown, revoked, expired, other product,
 * KV missing/error) gets the SAME 401 as any bad key, so a key's state is never revealed. */
async function authenticatePro(env, cfg, key, ipHash) {
  if (!isFleetLicenseCached(key) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) {
    throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
  }
  const r = await validateFleetLicense(env.LICENSES, key, PRO_PRODUCT_SLUG);
  if (!r.valid || r.plan !== 'pro') throw new HttpError(401, 'invalid_api_key', INVALID_KEY_MSG);
  return { plan: 'pro', proId: await proKeyIdFor(key) };
}

async function consumeQuota(auth, env, cfg, ctx) {
  const kv = env.PLAINGRADE_KV;
  const { ipHash, day, reset, gName } = auth;
  if (auth.plan === 'pro') {
    // Pro: own quota + own global counter (q:global:pro:<day>); never counts toward or is blocked by the free pool.
    const { proId } = auth;
    if (!(await rateLimit(env.KEY_LIMITER, 'k:' + proId, cfg.keyPerMin))) {
      throw new HttpError(429, 'rate_limited', `Per-key rate limit (${cfg.keyPerMin}/min) exceeded. Retry in a minute.`, { 'retry-after': '60' });
    }
    const quota = cfg.proDailyQuota;
    const headers = { 'x-api-plan': 'pro', 'x-ratelimit-limit': String(quota), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${quota};w=86400, ${cfg.keyPerMin};w=60` };
    const pgName = `q:global:pro:${day}`;
    if ((await counterValue(kv, pgName)) >= cfg.proGlobalDailyCap) throw new HttpError(429, 'daily_cap_reached', friendlyCap(), { ...headers, 'retry-after': '3600' });
    const usedName = `q:key:${proId}:${day}`;
    if ((await counterValue(kv, usedName)) >= quota) throw new HttpError(429, 'key_quota_exceeded', `Daily quota for this Pro license (${quota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
    const n = await counterIncr(kv, usedName, ctx, 1, { flushFirst: true, ttl: COUNTER_TTL });
    await counterIncr(kv, pgName, ctx, 1, { ttl: COUNTER_TTL });
    headers['x-ratelimit-remaining'] = String(Math.max(0, quota - n));
    return headers;
  }
  if (auth.capReached) throw new HttpError(429, 'daily_cap_reached', friendlyCap(), { 'retry-after': '3600' });
  if (auth.plan === 'free_key') {
    const { rec } = auth;
    if (!(await rateLimit(env.KEY_LIMITER, 'k:' + rec.id, cfg.keyPerMin))) {
      throw new HttpError(429, 'rate_limited', `Per-key rate limit (${cfg.keyPerMin}/min) exceeded. Retry in a minute.`, { 'retry-after': '60' });
    }
    const quota = rec.dailyQuota || cfg.keyDailyQuota;
    const usedName = `q:key:${rec.id}:${day}`;
    const used = await counterValue(kv, usedName);
    const headers = { 'x-api-plan': 'free_key', 'x-ratelimit-limit': String(quota), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${quota};w=86400, ${cfg.keyPerMin};w=60` };
    if (used >= quota) throw new HttpError(429, 'key_quota_exceeded', `Daily quota for this API key (${quota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
    const issuerName = `q:issuer:${rec.issuer || 'k-' + rec.id}:${day}`;
    if ((await counterValue(kv, issuerName)) >= cfg.keyIssuerDailyQuota) {
      throw new HttpError(429, 'issuer_quota_exceeded', `Combined daily quota for keys issued to your network (${cfg.keyIssuerDailyQuota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'retry-after': '3600' });
    }
    const n = await counterIncr(kv, usedName, ctx, 1, { flushFirst: true, ttl: COUNTER_TTL });
    await counterIncr(kv, issuerName, ctx, 1, { ttl: COUNTER_TTL });
    await counterIncr(kv, gName, ctx, 1, { ttl: COUNTER_TTL });
    headers['x-ratelimit-remaining'] = String(Math.max(0, quota - n));
    return headers;
  }
  if (!(await rateLimit(env.IP_LIMITER, 'ip:' + ipHash, cfg.anonPerMin))) {
    throw new HttpError(429, 'rate_limited', `Anonymous rate limit (${cfg.anonPerMin} requests/min per IP) exceeded. Retry in a minute, or use a free API key (X-API-Key).`, { 'retry-after': '60' });
  }
  const ipName = `q:ipday:${ipHash}:${day}`;
  const used = await counterValue(kv, ipName);
  const headers = { 'x-api-plan': 'anonymous', 'x-ratelimit-limit': String(cfg.anonDailyPerIp), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${cfg.anonDailyPerIp};w=86400, ${cfg.anonPerMin};w=60` };
  if (used >= cfg.anonDailyPerIp) throw new HttpError(429, 'ip_daily_quota', `Anonymous daily quota (${cfg.anonDailyPerIp} requests/day per IP) reached. It resets at 00:00 UTC; a free API key gives ${cfg.keyDailyQuota}/day.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
  const n = await counterIncr(kv, ipName, ctx, 1, { flushEvery: 10, maxAgeMs: Infinity, ttl: COUNTER_TTL });
  await counterIncr(kv, gName, ctx, 1, { ttl: COUNTER_TTL });
  headers['x-ratelimit-remaining'] = String(Math.max(0, cfg.anonDailyPerIp - n));
  return headers;
}

/** One scored text with every limit applied exactly like POST /v1/score. input: async () => validated input
 * ({ text, lang, longWords }); REST reads + parses the body there (after the quota, as in v0.2.x), MCP passes
 * pre-validated arguments. No result cache: the text is analysed in memory and dropped (privacy invariant).
 * { ok:true, body, headers } | { ok:false, status, code, message, headers } */
export async function runCheck({ input, auth, env, ctx, cfg }) {
  let headers = {};
  try {
    headers = await consumeQuota(auth, env, cfg, ctx);
    const p = await input();
    const r = analyze(p.text, { longSentenceWords: p.longWords });
    return { ok: true, body: { ok: true, lang: p.lang, ...r, engine: ENGINE, version: VERSION }, headers };
  } catch (e) {
    if (e instanceof HttpError) return fail({ status: e.status, code: e.code, message: e.message, headers: { ...headers, ...e.headers } });
    throw e;
  }
}

// ---------- handlers ----------

export function parseScoreBody(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON: {"text": "...", "lang": "en"}'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object: {"text": "...", "lang": "en"}');
  return validateScoreInput(body);
}

async function handleScore(req, env, ctx, cfg) {
  requirePepper(cfg);
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the body as application/json: {"text": "...", "lang": "en"}');
  }
  // Reject a declared oversize body before it counts against any quota (the streamed read re-checks actual bytes).
  const cl = req.headers.get('content-length');
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > MAX_BODY_BYTES)) throw tooLarge(MAX_BODY_BYTES);
  const auth = await authenticate(req, env, cfg);
  if (!auth.ok) throw new HttpError(auth.status, auth.code, auth.message, auth.headers);
  const r = await runCheck({ input: async () => parseScoreBody(await readBodyCapped(req)), auth, env, ctx, cfg });
  if (!r.ok) throw new HttpError(r.status, r.code, r.message, r.headers);
  return json(cfg, 200, r.body, r.headers, { compact: true });
}

async function handleKeys(req, env, ctx, cfg) {
  const kv = env.PLAINGRADE_KV;
  if (!kv) throw new HttpError(503, 'unavailable', 'Key issuance is not configured.');
  requirePepper(cfg);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'cross_origin_forbidden', 'API keys can only be requested from this site or directly (e.g. curl), not from other websites.');
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'unsupported_media_type', 'POST with Content-Type: application/json (an empty {} body is fine).');
  const bucket = ipBucket(clientIp(req));
  const ipH = (await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32);
  // The KV day counters below are read-then-write and eventually consistent, so parallel requests can all read the same
  // count. The Rate Limiting binding counts atomically per Cloudflare location, so one issuance costs KEY_ISSUE_COST tokens
  // of the per-IP limiter (10/min). That allows at most 2 keys per IP per minute per location, however many requests run in
  // parallel. The KV counters then enforce the daily 3/IP and global caps once they propagate (up to ~60 s). Residual: a
  // parallel burst spread over minutes or locations can exceed the daily caps by a few keys. Each key still has its own
  // 100/day quota and the issuer quota caps total keyed use per network. Exact caps would need a Durable Object, which the
  // shared does not use.
  const tokens = await Promise.all(Array.from({ length: KEY_ISSUE_COST }, () => rateLimit(env.IP_LIMITER, 'keys:' + ipH, cfg.anonPerMin)));
  if (tokens.includes(false)) throw new HttpError(429, 'rate_limited', 'Too many key requests. Retry in a minute.', { 'retry-after': '60' });
  const raw = await readBodyCapped(req, 1024);
  if (raw.trim()) { try { const b = JSON.parse(raw); if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(); } catch { throw new HttpError(400, 'invalid_json', 'Body must be a JSON object (or empty).'); } }
  const day = utcDay();
  const ipName = `q:keyissue:${ipH}:${day}`;
  const gName = `q:keyissue:global:${day}`;
  const [ipCount, gCount] = await Promise.all([kv.get(ipName), kv.get(gName)]);
  const ipN = Number(ipCount || 0); const gN = Number(gCount || 0);
  if (ipN >= cfg.keyIssuePerIpPerDay) throw new HttpError(429, 'key_issue_limit', `At most ${cfg.keyIssuePerIpPerDay} keys per IP (IPv6: per /64) per day.`, { 'retry-after': '3600' });
  if (gN >= cfg.keyIssueGlobalPerDay) throw new HttpError(429, 'daily_cap_reached', 'Free key issuance reached its daily limit. It resets at 00:00 UTC.', { 'retry-after': '3600' });
  await Promise.all([
    kv.put(ipName, String(ipN + 1), { expirationTtl: COUNTER_TTL }),
    kv.put(gName, String(gN + 1), { expirationTtl: COUNTER_TTL }),
  ]);
  const apiKey = generateKey();
  const keyHash = await sha256hex(apiKey);
  const id = keyHash.slice(0, 16);
  const rec = { id, created: new Date().toISOString(), plan: 'free', dailyQuota: cfg.keyDailyQuota, issuer: (await hmacHex(cfg.pepper, 'issuer:' + bucket)).slice(0, 32) };
  await kv.put('key:' + keyHash, JSON.stringify(rec));
  return json(cfg, 201, {
    ok: true, api_key: apiKey, key_id: id, plan: 'free', daily_quota: cfg.keyDailyQuota, per_minute: cfg.keyPerMin,
    commercial_use: true,
    note: 'Store this key now: it is shown only once (we keep only a SHA-256 hash). Send it as the X-API-Key header.',
  }, {}, { cors: false });
}

async function handleUsage(req, env, cfg) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) throw new HttpError(401, 'missing_api_key', 'Send your key in the X-API-Key header.');
  requirePepper(cfg);
  const ipHash = (await hmacHex(cfg.pepper, 'ip:' + ipBucket(clientIp(req)))).slice(0, 32);
  if (looksLikeProKey(apiKey)) {
    let pro;
    try { pro = await authenticatePro(env, cfg, apiKey.trim(), ipHash); } catch (e) { if (e instanceof HttpError && e.status === 401) throw new HttpError(401, 'invalid_api_key', 'X-API-Key is not valid.'); throw e; }
    const used = await counterValue(env.PLAINGRADE_KV, `q:key:${pro.proId}:${utcDay()}`);
    return json(cfg, 200, { ok: true, plan: 'pro', daily_quota: cfg.proDailyQuota, used_today: used, remaining_today: Math.max(0, cfg.proDailyQuota - used), per_minute: cfg.keyPerMin, resets_at: new Date(nextResetEpoch() * 1000).toISOString(), note: 'Usage counts are approximate (batched counters).' });
  }
  if (!(await isKeyCached(apiKey.trim())) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
  const rec = await lookupKey(env.PLAINGRADE_KV, apiKey.trim());
  if (!rec || rec.revoked) throw new HttpError(401, 'invalid_api_key', 'X-API-Key is not valid.');
  const used = await counterValue(env.PLAINGRADE_KV, `q:key:${rec.id}:${utcDay()}`);
  const quota = rec.dailyQuota || cfg.keyDailyQuota;
  return json(cfg, 200, { ok: true, key_id: rec.id, plan: rec.plan, daily_quota: quota, used_today: used, remaining_today: Math.max(0, quota - used), per_minute: cfg.keyPerMin, resets_at: new Date(nextResetEpoch() * 1000).toISOString(), note: 'Usage counts are approximate (batched counters).' });
}

const memHits = new Map();
export function memLimit(key, limit, windowMs, now = Date.now()) {
  let h = memHits.get(key);
  if (!h || now - h.t >= windowMs) { h = { t: now, n: 0 }; memHits.set(key, h); }
  if (memHits.size > 5000) { for (const [k, v] of memHits) if (now - v.t >= windowMs) memHits.delete(k); if (memHits.size > 5000) memHits.clear(); }
  return ++h.n <= limit;
}
export function _resetMemLimitForTests() { memHits.clear(); }

const REGISTRY_PROOF_RE = /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/;

function robots(cfg, origin) {
  return cfg.publicLaunch ? `User-agent: *\nAllow: /\nDisallow: /v1/\n\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
}
function sitemap(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/docs', '/privacy'].map((p) => `  <url><loc>${origin}${p}</loc></url>\n`).join('')}</urlset>\n`;
}

const ROUTES = {
  '/': ['GET', 'HEAD'],
  '/docs': ['GET', 'HEAD'],
  '/privacy': ['GET', 'HEAD'],
  '/app.js': ['GET', 'HEAD'],
  '/health': ['GET', 'HEAD'],
  '/robots.txt': ['GET', 'HEAD'],
  [OG_IMAGE_PATH]: ['GET', 'HEAD'],
  '/sitemap.xml': ['GET', 'HEAD'],
  '/v1/score': ['POST', 'OPTIONS'],
  '/v1/keys': ['POST'],
  '/v1/usage': ['GET', 'OPTIONS'],
  '/llms.txt': ['GET', 'HEAD', 'OPTIONS'],
  '/openapi.json': ['GET', 'HEAD', 'OPTIONS'],
  '/.well-known/mcp-registry-auth': ['GET', 'HEAD'],
  '/.well-known/glama.json': ['GET', 'HEAD'],
};
// JSON/agent routes documented in /openapi.json (drift-tested against this list). Pages + static assets are not.
export const API_ROUTES = { '/v1/score': ['post'], '/v1/keys': ['post'], '/v1/usage': ['get'], '/health': ['get'], '/mcp': ['post', 'get', 'delete'], '/llms.txt': ['get'], '/openapi.json': ['get'] };
export const limitsOf = (cfg) => ({ anonPerMin: cfg.anonPerMin, anonDailyPerIp: cfg.anonDailyPerIp, keyPerMin: cfg.keyPerMin, keyDailyQuota: cfg.keyDailyQuota, globalDailyRequestCap: cfg.globalDailyRequestCap, keyIssuePerIpPerDay: cfg.keyIssuePerIpPerDay, proDailyQuota: cfg.proDailyQuota });

// Social preview image. Bundled by wrangler as a Data module in src/index.js and injected here, so tests can pass
// the file bytes. Served as-is: no per-request work beyond a Response wrapper.
export function createApp({ ogPng = null } = {}) {
  return {
    async fetch(req, env, ctx) {
      const cfg = config(env);
      const url = new URL(req.url);
      let path = url.pathname; // strip trailing slashes with a loop: /\/+$/ is O(n^2) on a long run of slashes
      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      const method = req.method.toUpperCase();
      if (path === '/mcp') {
        // v0.3.0: remote MCP server (Streamable HTTP, stateless, JSON). Same key gate + limits as POST /v1/score.
        const bucket = ipBucket(clientIp(req));
        const limiterKey = cfg.pepper ? (await hmacHex(cfg.pepper, 'mcp:' + bucket)).slice(0, 32) : 'unconfigured';
        try {
          return await handleMcp(req, env, ctx, {
            authenticate: (r, e) => authenticate(r, e, cfg, { allowBearer: true }),
            runCheck: (a) => runCheck({ ...a, cfg }),
            memLimit, limiterKey, origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS,
            security: baseHeaders(cfg), limits: limitsOf(cfg),
          });
        } catch (e) {
          console.error('plaingrade-api: internal error', e && e.name); // error name only, never the body/text
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }), { status: 500, headers: baseHeaders(cfg, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...MCP_CORS }) });
        }
      }
      if (isRapidApiPath(path)) {
        try {
          return await handleRapidApi(req, env, path, {
            HttpError, version: VERSION, ipBucket: ipBucket(clientIp(req)), rateLimit,
            json: (status, obj, extra) => json(cfg, status, obj, extra, { cors: false, compact: true }),
            readInput: async (r) => {
              if (!/^application\/json\b/i.test(r.headers.get('content-type') || '')) throw new HttpError(415, 'unsupported_media_type', 'Send the body as application/json: {"text": "...", "lang": "en"}');
              const cl = r.headers.get('content-length');
              if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > MAX_BODY_BYTES)) throw tooLarge(MAX_BODY_BYTES);
              return parseScoreBody(await readBodyCapped(r));
            },
            analyzeInput: (p) => ({ ok: true, lang: p.lang, ...analyze(p.text, { longSentenceWords: p.longWords }), engine: ENGINE, version: VERSION }),
          });
        } catch (e) {
          if (e instanceof HttpError) return json(cfg, e.status, errBody(e.code, e.message), e.headers, { cors: false });
          console.error('plaingrade-api: internal error', e && e.name);
          return json(cfg, 500, errBody('internal_error', 'Internal error.'), {}, { cors: false });
        }
      }
      const allowed = ROUTES[path];
      try {
        if (!allowed) throw new HttpError(404, 'not_found', 'Not found. See /docs.');
        if (!allowed.includes(method)) throw new HttpError(405, 'method_not_allowed', `Use ${allowed.join(', ')}.`, { allow: allowed.join(', ') });
        const pageOpts = { brand: cfg.brand, supportEmail: cfg.supportEmail, env: cfg.env, publicLaunch: cfg.publicLaunch, version: VERSION, origin: url.origin, path, publicOrigin: cfg.publicOrigin,
          // og:image must be absolute. Public (prod): the configured origin. Unlisted (staging): this deployment's own
          // origin, so previews load the image staging actually serves (prod may not have it yet). Versioned for caching.
          ogImage: `${cfg.publicLaunch && cfg.publicOrigin ? cfg.publicOrigin : url.origin}${OG_IMAGE_PATH}?v=${VERSION}`, maxText: MAX_TEXT_BYTES, maxBody: MAX_BODY_BYTES, engine: ENGINE, anonPerMin: cfg.anonPerMin, anonDaily: cfg.anonDailyPerIp, keyPerMin: cfg.keyPerMin, keyDaily: cfg.keyDailyQuota, proDaily: cfg.proDailyQuota, proCheckout: cfg.proCheckoutUrl, longDefault: DEFAULT_LONG_SENTENCE_WORDS, longMin: LONG_MIN, longMax: LONG_MAX };
        switch (path) {
          case '/': return page(cfg, method, indexHtml(pageOpts));
          case '/docs': return page(cfg, method, docsHtml(pageOpts));
          case '/privacy': return page(cfg, method, privacyHtml(pageOpts));
          case '/app.js': return page(cfg, method, appJs, 'text/javascript; charset=utf-8');
          case '/robots.txt': return page(cfg, method, robots(cfg, cfg.publicOrigin || url.origin), 'text/plain; charset=utf-8');
          case OG_IMAGE_PATH:
            if (!ogPng) throw new HttpError(404, 'not_found', 'Not found.');
            return new Response(method === 'HEAD' ? null : ogPng, { headers: baseHeaders(cfg, { 'content-type': 'image/png', 'content-length': String(ogPng.byteLength), 'cache-control': 'public, max-age=86400, stale-while-revalidate=604800', 'access-control-allow-origin': '*', 'content-security-policy': "default-src 'none'; sandbox" }) });
          case '/sitemap.xml':
            if (!cfg.publicLaunch) throw new HttpError(404, 'not_found', 'Not found. See /docs.');
            return page(cfg, method, sitemap(cfg.publicOrigin || url.origin), 'application/xml; charset=utf-8');
          case '/health': {
            const r = json(cfg, 200, { ok: true, service: 'plaingrade-api', name: cfg.brand, version: VERSION, build: cfg.build, environment: cfg.env, engine: ENGINE, configured: !!cfg.pepper && !!env.PLAINGRADE_KV });
            return method === 'HEAD' ? new Response(null, { status: 200, headers: r.headers }) : r;
          }
          case '/v1/score':
          case '/v1/usage':
            if (method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(cfg, { ...CORS, 'access-control-allow-methods': path === '/v1/score' ? 'POST, OPTIONS' : 'GET, OPTIONS', 'access-control-allow-headers': 'content-type, x-api-key', 'access-control-max-age': '86400' }) });
            return path === '/v1/score' ? await handleScore(req, env, ctx, cfg) : await handleUsage(req, env, cfg);
          case '/v1/keys': return await handleKeys(req, env, ctx, cfg);
          case '/llms.txt':
          case '/openapi.json': {
            const DOC_CORS = { 'access-control-allow-origin': '*' };
            if (method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(cfg, { ...DOC_CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' }) });
            const body = path === '/llms.txt' ? llmsTxt(url.origin, limitsOf(cfg)) : JSON.stringify(openApiSpec(url.origin, limitsOf(cfg)), null, 2);
            return new Response(method === 'HEAD' ? null : body, { headers: baseHeaders(cfg, { 'content-type': path === '/llms.txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600', ...DOC_CORS }) });
          }
          case '/.well-known/glama.json':
            // Glama connector claim (shared account-wide token; must stay published). Static, no
            // limits.
            return new Response(method === 'HEAD' ? null : GLAMA_CLAIM_JSON, { headers: baseHeaders(cfg, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }) });
          case '/.well-known/mcp-registry-auth': {
            // Official MCP Registry HTTP namespace proof. Only the PUBLIC key lives in a wrangler var; 404 until set.
            const proof = String(env.MCP_REGISTRY_AUTH || '').trim();
            if (!REGISTRY_PROOF_RE.test(proof)) throw new HttpError(404, 'not_found', 'Not found.');
            return new Response(method === 'HEAD' ? null : `${proof}\n`, { headers: baseHeaders(cfg, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }) });
          }
        }
        throw new HttpError(404, 'not_found', 'Not found.');
      } catch (e) {
        if (e instanceof HttpError) return json(cfg, e.status, errBody(e.code, e.message), e.headers, { cors: path !== '/v1/keys' });
        // Never include the request body or text in error output.
        console.error('plaingrade-api: internal error', e && e.name);
        return json(cfg, 500, errBody('internal_error', 'Internal error.'));
      }
    },
  };
}
