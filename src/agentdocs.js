// Agent discovery documents, generated from code constants + the live limits (never a number hard-coded twice).
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES as MCP_MAX_BODY, MAX_BATCH } from './mcp.js';
import { VERSION, MAX_TEXT_BYTES, LONG_MIN, LONG_MAX } from './core.js';
import { DEFAULT_LONG_SENTENCE_WORDS } from './readability.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const mcpClientConfig = (origin) => ({ mcpServers: { 'plaingrade-api': { type: 'http', url: `${origin}/mcp` } } });
const fmt = (n) => Number(n).toLocaleString('en-US');

// Every error code the JSON API can return, by route (drift-tested).
export const ERROR_CODES = {
  '/v1/score': ['invalid_json', 'missing_text', 'invalid_lang', 'invalid_long_sentence_words', 'invalid_api_key', 'unsupported_media_type', 'body_too_large', 'text_too_large', 'unsupported_language', 'rate_limited', 'ip_daily_quota', 'key_quota_exceeded', 'issuer_quota_exceeded', 'daily_cap_reached', 'internal_error', 'not_configured'],
  '/v1/keys': ['invalid_json', 'cross_origin_forbidden', 'body_too_large', 'unsupported_media_type', 'rate_limited', 'key_issue_limit', 'daily_cap_reached', 'internal_error', 'unavailable', 'not_configured'],
  '/v1/usage': ['missing_api_key', 'invalid_api_key', 'rate_limited', 'internal_error', 'not_configured'],
};

export const llmsTxt = (origin, L) => `# PlainGrade

> English readability scores (Flesch Reading Ease, Flesch-Kincaid, Gunning Fog, SMOG, Coleman-Liau, ARI, consensus grade) plus text statistics and long sentences, for writers, editors and developers. Public JSON API plus a remote MCP server for AI agents. Submitted text is scored in memory and never stored or logged.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tool \`${TOOLS[0].name}\` (text, optional lang, long_sentence_words, include_raw). Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API

## JSON API

- \`POST ${origin}/v1/score\` with JSON \`{"text": "...", "lang": "en", "long_sentence_words": ${DEFAULT_LONG_SENTENCE_WORDS}}\`: text up to ${fmt(MAX_TEXT_BYTES)} bytes (UTF-8), English only, long_sentence_words ${LONG_MIN}–${LONG_MAX}. Returns scores, interpretation, stats, long_sentences and notes. Optional header \`X-API-Key\`.
- \`POST ${origin}/v1/keys\` with \`{}\`: issues a free API key (shown once). \`GET ${origin}/v1/usage\` with \`X-API-Key\`: today's usage. \`GET ${origin}/health\`: status and version.
- Errors: \`{"ok": false, "error": {"code", "message"}}\` with HTTP 400, 401, 403, 404, 405, 413, 415, 422, 429, 500 or 503. Codes: ${[...new Set(Object.values(ERROR_CODES).flat())].join(', ')}.

## Limits, keys and pricing

- Anonymous: about ${L.anonPerMin}/min and ${fmt(L.anonDailyPerIp)}/day per IP (IPv6: per /64). Free API key: ${fmt(L.keyDailyQuota)} requests/day and ${L.keyPerMin}/min, commercial use allowed; at most ${L.keyIssuePerIpPerDay} new keys per IP per day. Pro ($5/month, Polar license key in X-API-Key or Bearer): ${fmt(L.proDailyQuota)} requests/day, ${L.keyPerMin}/min, capacity separate from the free pool; see /#pro. The service has a global daily soft cap (HTTP 429 daily_cap_reached until 00:00 UTC).
- The MCP endpoint uses the same keys and counters (send the key as \`Authorization: Bearer <key>\` or \`X-Api-Key\`): each \`tools/call\` counts as one /v1/score request. Other MCP messages (initialize, tools/list, ping, server/discover) don't count against the API quota, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After). Max ${fmt(MCP_MAX_BODY)} bytes per MCP request, batches of up to ${MAX_BATCH} messages with at most one tools/call.

## Optional

- [Privacy](${origin}/privacy)
- [API docs](${origin}/docs)
- Contact: ${CONTACT}
`;

const errSchema = { $ref: '#/components/schemas/Error' };
const hdr = (description, type = 'string') => ({ description, schema: { type } });
const RL_HEADERS = {
  'X-Api-Plan': hdr('anonymous, free_key or pro'), 'X-RateLimit-Limit': hdr('Daily request quota', 'integer'), 'X-RateLimit-Remaining': hdr('Requests left today (approximate)', 'integer'),
  'X-RateLimit-Reset': hdr('Unix time of the next 00:00 UTC reset', 'integer'), 'X-RateLimit-Policy': hdr('Daily and per-minute policy, e.g. "100;w=86400, 30;w=60"'),
};
const resp = (description, extra = {}) => ({ description, content: { 'application/json': { schema: errSchema } }, ...extra });
const retry = { headers: { 'Retry-After': hdr('Seconds to wait', 'integer') } };

export function openApiSpec(origin, L) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'PlainGrade API', version: VERSION,
      description: `English readability scores and text statistics. Text is scored in memory and never stored or logged. Anonymous: about ${L.anonPerMin}/min and ${fmt(L.anonDailyPerIp)}/day per IP; free key: ${fmt(L.keyDailyQuota)}/day, ${L.keyPerMin}/min. Also a remote MCP server at /mcp (see /llms.txt).`,
      contact: { email: CONTACT },
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'Free key from POST /v1/keys. Optional on /v1/score and /mcp.' },
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Same key as X-Api-Key; accepted on /mcp only.' },
      },
      schemas: {
        Error: { type: 'object', required: ['ok', 'error'], properties: { ok: { const: false }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        ScoreRequest: {
          type: 'object', required: ['text'], properties: {
            text: { type: 'string', maxLength: MAX_TEXT_BYTES, description: `English text, at most ${fmt(MAX_TEXT_BYTES)} bytes UTF-8 (413 text_too_large otherwise).` },
            lang: { type: 'string', maxLength: 20, pattern: '^[Ee][Nn]([-_][A-Za-z0-9]{2,8})*$', default: 'en' },
            long_sentence_words: { type: 'integer', minimum: LONG_MIN, maximum: LONG_MAX, default: DEFAULT_LONG_SENTENCE_WORDS },
          },
        },
        ScoreResponse: {
          type: 'object', properties: {
            ok: { const: true }, lang: { type: 'string' }, scores: { type: 'object' }, interpretation: { type: 'object' }, stats: { type: 'object' },
            long_sentences: { type: 'object' }, notes: { type: 'array', items: { type: 'string' } }, text_bytes: { type: 'integer' }, engine: { type: 'string' }, version: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/v1/score': {
        post: {
          operationId: 'scoreText', summary: 'Score English text', security: [{}, { apiKeyHeader: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ScoreRequest' } } } },
          responses: {
            200: { description: 'Scores', headers: RL_HEADERS, content: { 'application/json': { schema: { $ref: '#/components/schemas/ScoreResponse' } } } },
            400: resp('invalid_json, missing_text, invalid_lang, invalid_long_sentence_words'), 401: resp('invalid_api_key'), 404: resp('not_found'), 405: resp('method_not_allowed'),
            413: resp('body_too_large, text_too_large'), 415: resp('unsupported_media_type'), 422: resp('unsupported_language'),
            429: resp('rate_limited, ip_daily_quota, key_quota_exceeded, issuer_quota_exceeded, daily_cap_reached', retry), 500: resp('internal_error'), 503: resp('not_configured'),
          },
        },
      },
      '/v1/keys': {
        post: {
          operationId: 'createKey', summary: 'Issue a free API key (shown once)', requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            201: { description: 'Key issued', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, api_key: { type: 'string' }, key_id: { type: 'string' }, plan: { type: 'string' }, daily_quota: { type: 'integer' }, per_minute: { type: 'integer' } } } } } },
            400: resp('invalid_json'), 403: resp('cross_origin_forbidden'), 405: resp('method_not_allowed'), 413: resp('body_too_large'), 415: resp('unsupported_media_type'),
            429: resp('rate_limited, key_issue_limit, daily_cap_reached', retry), 500: resp('internal_error'), 503: resp('unavailable, not_configured'),
          },
        },
      },
      '/v1/usage': {
        get: {
          operationId: 'getUsage', summary: "Today's usage for a key", security: [{ apiKeyHeader: [] }],
          responses: {
            200: { description: 'Usage', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, key_id: { type: 'string' }, plan: { type: 'string' }, daily_quota: { type: 'integer' }, used_today: { type: 'integer' }, remaining_today: { type: 'integer' }, per_minute: { type: 'integer' }, resets_at: { type: 'string' } } } } } },
            401: resp('missing_api_key, invalid_api_key'), 405: resp('method_not_allowed'), 429: resp('rate_limited', retry), 500: resp('internal_error'), 503: resp('not_configured'),
          },
        },
      },
      '/health': { get: { operationId: 'health', summary: 'Status and version', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, build: { type: 'string' }, environment: { type: 'string' }, configured: { type: 'boolean' } } } } } }, 405: resp('method_not_allowed') } } },
      '/mcp': {
        post: {
          operationId: 'mcp', summary: 'MCP JSON-RPC 2.0 (Streamable HTTP, stateless, JSON responses)', security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
          description: `Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Tool ${TOOLS[0].name}. Max ${fmt(MCP_MAX_BODY)} bytes, batches up to ${MAX_BATCH} with at most one tools/call. Non-check messages: about ${DISCOVERY_PER_MIN}/min per IP.`,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 request, notification or batch' } } } },
          responses: {
            200: { description: 'JSON-RPC response (tool errors are results with isError: true)', content: { 'application/json': { schema: { type: 'object' } } } },
            202: { description: 'Notification or client response accepted (empty body)' },
            400: { description: 'Parse error, invalid request, protocol-version or header mismatch (JSON-RPC error)' },
            401: { description: 'Invalid API key (JSON-RPC error, data.code invalid_api_key; no WWW-Authenticate)' },
            403: { description: 'Origin not allowed' }, 404: { description: 'Method not found (protocol 2026-07-28)' },
            413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests', ...retry }, 500: { description: 'Internal error' }, 503: { description: 'Not configured' },
          },
        },
        get: { operationId: 'mcpGet', summary: 'Not supported (no SSE stream)', responses: { 405: { description: 'Method not allowed', headers: { Allow: hdr('POST, OPTIONS') } } } },
        delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: { Allow: hdr('POST, OPTIONS') } } } },
      },
      '/llms.txt': { get: { operationId: 'llmsTxt', summary: 'llms.txt', responses: { 200: { description: 'text/plain', content: { 'text/plain': { schema: { type: 'string' } } } }, 405: resp('method_not_allowed') } } },
      '/openapi.json': { get: { operationId: 'openApi', summary: 'This document', responses: { 200: { description: 'OpenAPI 3.1', content: { 'application/json': { schema: { type: 'object' } } } }, 405: resp('method_not_allowed') } } },
    },
  };
}
