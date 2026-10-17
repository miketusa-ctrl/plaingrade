/**
 * v0.5.0 RapidAPI marketplace route /rapidapi/v1/* (shared pattern: UAParse v0.5.1 / CertGuard src/lib/rapidapi.js).
 * RapidAPI's proxy adds X-RapidAPI-Proxy-Secret (must equal the Worker secret RAPIDAPI_PROXY_SECRET) and X-RapidAPI-User.
 * Compare is constant time (SHA-256 digests + XOR). Wrong/missing secret → uniform 401 unauthorized; secret unset → 503.
 * Tier from X-RapidAPI-Subscription, read only AFTER the secret check (missing/unknown → BASIC). Per-minute limit per
 * RapidAPI user on per-tier bindings RAPIDAPI_BASIC_LIMITER 10/min and RAPIDAPI_PRO_LIMITER 120/min, key
 * "rapidapi-<tier>:<16-hex hash of X-RapidAPI-User>". RapidAPI traffic never touches the free per-IP/key pools, the global
 * daily cap or Pro (PGPR) quotas. Monthly quotas are enforced by RapidAPI. X-API-Key / Authorization are never read on this
 * path. Submitted text is never stored or logged (same as /v1/score).
 */
export const RAPIDAPI_PREFIX = '/rapidapi';
export const RAPIDAPI_TIERS = ['BASIC', 'PRO'];
export const RAPIDAPI_PER_MIN = { BASIC: 10, PRO: 120 };
/** Monthly hard quotas, enforced by RapidAPI (Studio plan settings). */
export const RAPIDAPI_PER_MONTH = { BASIC: 100, PRO: 50_000 };
export const RAPIDAPI_PRICE_USD = { BASIC: 0, PRO: 7 };
export const RAPIDAPI_BINDING = { BASIC: 'RAPIDAPI_BASIC_LIMITER', PRO: 'RAPIDAPI_PRO_LIMITER' };

export function rapidTier(request) {
  const t = String(request.headers.get('x-rapidapi-subscription') || '').trim().toUpperCase();
  return RAPIDAPI_TIERS.includes(t) ? t : 'BASIC';
}
export function isRapidApiPath(path) { return path === RAPIDAPI_PREFIX || path.startsWith(`${RAPIDAPI_PREFIX}/`); }

async function digest(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)))); }
/** Constant-time equality over fixed-length SHA-256 digests. */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
/** Limiter key (16 hex): hashed X-RapidAPI-User (fallback: hashed IP bucket). Never stores the raw username. */
export async function rapidUserKey(request, fallback) {
  const u = String(request.headers.get('x-rapidapi-user') || '').trim().slice(0, 128);
  return [...(await digest(u ? `u:${u}` : `ip:${fallback}`))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** null when allowed, else { status, code, message }. Never echoes the secret or the presented value. */
export async function rapidGate(request, env) {
  const secret = typeof env.RAPIDAPI_PROXY_SECRET === 'string' ? env.RAPIDAPI_PROXY_SECRET : '';
  if (!secret) return { status: 503, code: 'rapidapi_not_configured', message: 'The RapidAPI route is not configured yet. Use the free API at /v1 directly.' };
  const presented = request.headers.get('x-rapidapi-proxy-secret');
  if (!presented || !(await safeEqual(presented, secret))) {
    return { status: 401, code: 'unauthorized', message: 'Missing or invalid RapidAPI proxy secret. Subscribe on RapidAPI, or use the free public API at /v1.' };
  }
  return null;
}

/** h = { HttpError, json(status,obj,extra), score(req) → body (validated + analysed), rateLimit, ipBucket, version } */
export async function handleRapidApi(request, env, path, h) {
  const g = await rapidGate(request, env);
  if (g) throw new h.HttpError(g.status, g.code, g.message);
  const method = request.method.toUpperCase();
  const tier = rapidTier(request);
  const perMin = RAPIDAPI_PER_MIN[tier];
  const plan = { 'x-api-plan': `rapidapi-${tier.toLowerCase()}` };
  if (path === '/rapidapi/v1/health') {
    if (method !== 'GET' && method !== 'HEAD') throw new h.HttpError(405, 'method_not_allowed', 'Use GET /rapidapi/v1/health.', { allow: 'GET, HEAD' });
    return h.json(200, { ok: true, service: 'plaingrade-api', version: h.version, plan: 'rapidapi', tier }, plan);
  }
  if (path === '/rapidapi/v1/score') {
    if (method !== 'POST') throw new h.HttpError(405, 'method_not_allowed', 'Use POST /rapidapi/v1/score with {"text":"…"}.', { allow: 'POST' });
    const input = await h.readInput(request); // 415 / 413 / 400 before any limiter, like /v1/score
    const key = `rapidapi-${tier.toLowerCase()}:${await rapidUserKey(request, h.ipBucket)}`;
    if (!(await h.rateLimit(env[RAPIDAPI_BINDING[tier]], key, perMin))) {
      throw new h.HttpError(429, 'rate_limited', `Too many requests for your RapidAPI ${tier} plan (about ${perMin} per minute). Please wait a minute.`, { 'retry-after': '60', ...plan });
    }
    return h.json(200, h.analyzeInput(input), plan);
  }
  throw new h.HttpError(404, 'not_found', 'Unknown RapidAPI endpoint. Use POST /rapidapi/v1/score or GET /rapidapi/v1/health.');
}
