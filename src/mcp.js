/**
 * PlainGrade remote MCP server (v0.3.0). Adapted from DnsGuard src/lib/mcp.js (v0.7.x) + the CertGuard c2606ed _meta fix.
 * Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK, no dependencies.
 *
 * Dual-era and stateless:
 *  - Modern (MCP 2026-07-28): every request carries params._meta["io.modelcontextprotocol/protocolVersion"] plus the
 *    MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover, tools/list, tools/call.
 *  - Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): initialize handshake, notifications/initialized, ping,
 *    tools/list, tools/call. JSON-RPC batches (max 10 messages, at most one tools/call) are accepted for legacy clients.
 *  - No sessions: no Mcp-Session-Id is ever issued; one sent by a client is ignored. GET/DELETE → 405 (no SSE stream).
 *  - Responses are always application/json (no SSE).
 *
 * Auth + limits are NOT implemented here: the router passes in authenticate() and runCheck() from app.js, the exact
 * functions behind POST /v1/score, so key handling and every rate/daily/global counter are identical.
 * One tools/call = one /v1/score request. initialize / tools/list / ping / server/discover never touch the API quota;
 * they have a light per-isolate cap per IP (DISCOVERY_PER_MIN).
 *
 * PRIVACY: submitted text is never logged, stored or cached. There is NO result cache (unlike DnsGuard): a cache keyed
 * on the text would keep text-derived data after the request. Nothing in this file logs anything.
 */
import { VERSION, LONG_MIN, LONG_MAX, MAX_TEXT_BYTES, validateScoreInput, HttpError } from './core.js';
import { DEFAULT_LONG_SENTENCE_WORDS } from './readability.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1; // bounds CPU per invocation and keeps 1 HTTP request ≈ 1 scored text
export const DISCOVERY_PER_MIN = 120; // per IP per isolate, for non-check messages (initialize, tools/list, ping, …)
export const MAX_LONG_ITEMS = 10; // structuredContent caps (full payload only with include_raw)
export const MAX_SENTENCE_CHARS = 300;
export const MAX_NOTES = 10;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
export const ERROR_META = 'plaingrade-api/error';
// Headers /v1/score really sends that MCP passes through (no x-cache: PlainGrade has no result cache).
export const PASS_HEADERS = ['retry-after', 'x-api-plan', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-policy'];

export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

export const MCP_CORS = {
  // Keys are explicit headers (never ambient cookies), so a wildcard origin without credentials is safe.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'plaingrade-api', title: 'PlainGrade', version: VERSION };
export const instructions = (L) => `PlainGrade scores the readability of English text: Flesch Reading Ease, Flesch-Kincaid grade, Gunning Fog, SMOG, Coleman-Liau, ARI and a consensus grade, plus word/sentence/syllable counts, reading time and long sentences. Call score_readability with the text (up to ${MAX_TEXT_BYTES.toLocaleString('en-US')} bytes UTF-8, English only). Text is scored in memory and never stored or logged. Without a key: about ${L.anonPerMin} calls/min and ${L.anonDailyPerIp}/day per IP. A free key (POST /v1/keys) gives ${L.keyDailyQuota}/day and ${L.keyPerMin}/min; send it as "Authorization: Bearer <key>" or "X-Api-Key: <key>".`;

const num = { type: 'number' };
export const TOOLS = [{
  name: 'score_readability',
  title: 'Score English text readability (Flesch, Flesch-Kincaid, Gunning Fog, SMOG, Coleman-Liau, ARI)',
  description: 'Compute readability scores for English text: Flesch Reading Ease, Flesch-Kincaid grade, Gunning Fog, SMOG, Coleman-Liau, ARI and a consensus grade, with plain-English interpretation, text statistics (words, sentences, syllables, reading and speaking time) and the sentences longer than a threshold. Read-only; the text is scored in memory and never stored or logged. Same engine as the PlainGrade JSON API (POST /v1/score).',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_BYTES, description: `English text to score, up to ${MAX_TEXT_BYTES.toLocaleString('en-US')} bytes (UTF-8).` },
      lang: { type: 'string', maxLength: 20, default: 'en', description: 'Language code. Only English is supported: "en", "en-US", "en-GB", …' },
      long_sentence_words: { type: 'integer', minimum: LONG_MIN, maximum: LONG_MAX, default: DEFAULT_LONG_SENTENCE_WORDS, description: `A sentence with more words than this is listed as long (default ${DEFAULT_LONG_SENTENCE_WORDS}).` },
      include_raw: { type: 'boolean', default: false, description: 'Also return the full /v1/score JSON (every long sentence, unclipped) in structuredContent.raw. Larger output.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      scores: { type: 'object', properties: Object.fromEntries(['flesch_reading_ease', 'flesch_kincaid_grade', 'gunning_fog', 'smog', 'coleman_liau', 'ari', 'consensus_grade'].map((k) => [k, num])) },
      interpretation: { type: 'object', properties: { flesch_reading_ease: { type: 'string' }, audience: { type: 'string' }, consensus_grade: { type: 'string' } } },
      stats: { type: 'object', description: 'Counts and averages (words, sentences, syllables, reading_time_seconds, …)' },
      long_sentences: {
        type: 'object',
        properties: {
          threshold_words: num, count: num, truncated: { type: 'boolean', description: `true if more than ${MAX_LONG_ITEMS} long sentences exist or any text was clipped (use include_raw for all)` },
          items: { type: 'array', items: { type: 'object', properties: { index: num, start: num, end: num, words: num, text: { type: 'string' } }, required: ['index', 'words', 'text'] } },
        },
        required: ['threshold_words', 'count', 'items', 'truncated'],
      },
      notes: { type: 'array', items: { type: 'string' } },
      lang: { type: 'string' },
      text_bytes: num,
      tier: { type: 'string', enum: ['anonymous', 'free_key', 'pro'] },
      engine: { type: 'string' },
      version: { type: 'string' },
      raw: { type: 'object', description: 'Full /v1/score response (only when include_raw is true)' },
    },
    required: ['scores', 'interpretation', 'stats', 'long_sentences', 'lang', 'version'],
  },
  annotations: { title: 'Score readability', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
const TOOL_ARGS = new Set(Object.keys(TOOLS[0].inputSchema.properties));

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Concise, schema-conforming summary of a full /v1/score body (arrays sliced, strings clipped). */
export function summarizeScore(body, { plan, includeRaw }) {
  const ls = body.long_sentences || { threshold_words: 0, count: 0, items: [], truncated: false };
  let clipped = false;
  const items = (ls.items || []).slice(0, MAX_LONG_ITEMS).map((it) => {
    const text = clip(String(it.text), MAX_SENTENCE_CHARS); if (text !== it.text) clipped = true;
    return { index: it.index, start: it.start, end: it.end, words: it.words, text };
  });
  const out = {
    scores: body.scores,
    interpretation: body.interpretation,
    stats: body.stats,
    long_sentences: { threshold_words: ls.threshold_words, count: ls.count, items, truncated: !!ls.truncated || clipped || (ls.items || []).length > MAX_LONG_ITEMS },
    notes: (body.notes || []).slice(0, MAX_NOTES).map((n) => clip(String(n), 300)),
    lang: body.lang,
    text_bytes: body.text_bytes,
    tier: plan === 'free_key' || plan === 'pro' ? plan : 'anonymous',
    engine: body.engine,
    version: body.version || VERSION,
  };
  if (includeRaw) out.raw = body;
  return out;
}

/** Human/LLM-readable text version (content[0]). Contains no submitted text. */
export function summaryText(s) {
  const sc = s.scores || {}; const st = s.stats || {}; const it = s.interpretation || {};
  return [
    `PlainGrade readability: Flesch Reading Ease ${sc.flesch_reading_ease} (${it.flesch_reading_ease}), consensus grade ${sc.consensus_grade} (${it.consensus_grade}).`,
    `Flesch-Kincaid ${sc.flesch_kincaid_grade} · Gunning Fog ${sc.gunning_fog} · SMOG ${sc.smog} · Coleman-Liau ${sc.coleman_liau} · ARI ${sc.ari}.`,
    `${st.words} words, ${st.sentences} sentences, ${st.syllables} syllables; reading time ${st.reading_time}.`,
    `Long sentences (> ${s.long_sentences.threshold_words} words): ${s.long_sentences.count}${s.long_sentences.truncated ? ` (first ${s.long_sentences.items.length} in structuredContent, clipped)` : ''}.`,
    ...(s.notes.length ? ['Notes:', ...s.notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

/** tools/call for score_readability. Returns { result } or { error } (protocol error), plus HTTP headers to surface. */
async function callTool(params, deps, auth) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  if (name !== TOOLS[0].name) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  const unknown = Object.keys(args).filter((k) => !TOOL_ARGS.has(k));
  if (unknown.length) {
    return { result: toolError(`Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${[...TOOL_ARGS].join(', ')}.`, { code: 'invalid_arguments', httpStatus: 400 }) };
  }
  if (args.include_raw !== undefined && typeof args.include_raw !== 'boolean') return { result: toolError('include_raw must be a boolean.', { code: 'invalid_arguments', httpStatus: 400 }) };
  // Same validation rules + messages as POST /v1/score, applied BEFORE any limiter/quota is touched.
  let input;
  try { input = validateScoreInput({ text: args.text, lang: args.lang, long_sentence_words: args.long_sentence_words }); } catch (e) {
    if (e instanceof HttpError) return { result: toolError(e.message, { code: e.code, httpStatus: e.status }) };
    throw e;
  }
  const r = await deps.runCheck({ input: async () => input, auth, env: deps.env, ctx: deps.ctx });
  const headers = { ...(r.headers || {}) };
  if (!r.ok) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    return { result: toolError(`${r.message}${retry ? ` (retry after ${retry} seconds)` : ''}`, { code: r.code, httpStatus: r.status, ...(retry ? { retryAfterSeconds: retry } : {}) }), headers };
  }
  const summary = summarizeScore(r.body, { plan: headers['x-api-plan'], includeRaw: args.include_raw === true });
  return { result: { content: [{ type: 'text', text: summaryText(summary) }], structuredContent: summary, isError: false }, headers };
}

// ---------- transport helpers (verbatim from DnsGuard) ----------

/** Origin policy: absent = OK. Present: bare https origin or http loopback, or (if MCP_ALLOWED_ORIGINS is set)
 * same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {}; // client JSON-RPC response → accepted
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification: accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // CertGuard c2606ed: merge, so a tool error's _meta["plaingrade-api/error"] survives next to serverInfo.
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method === 'tools/list') return done({ tools: TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      return done({ protocolVersion: LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, deps, auth);
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. deps: { authenticate(req, env), runCheck, memLimit,
 * limiterKey (HMAC of the IP bucket, never the raw IP), origin, allowedOrigins, security, limits }. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.limiterKey}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same key gate as /v1/score, evaluated once per HTTP request (bad key → 401 for every method).
  const auth = await deps.authenticate(request, env);
  if (!auth.ok) {
    // No WWW-Authenticate: we don't offer MCP OAuth, so a Bearer challenge would send clients into a dead end.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), auth.headers || {});
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try { out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget }); } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') }; // never a stack trace, never logged
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.isCheck && out.headers) headers = out.headers; // batches too: surface the check's Retry-After / quota
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
