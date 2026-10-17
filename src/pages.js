import { PRO_PORTAL_URL } from './pro.js';
// Static pages. User-provided text is only ever rendered client-side with textContent (never innerHTML).
// Every link that leaves this site opens in a new tab with rel="noopener noreferrer" (ext()).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
export const ext = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
// Support address comes from the SUPPORT_EMAIL var (wrangler.toml); nothing is rendered if it's unset.
const contact = (o, prefix = '') => (o.supportEmail ? `${prefix}<a href="mailto:${esc(o.supportEmail)}">${esc(o.supportEmail)}</a>` : '');

// Other free other tools (live production sites).
const MORE_TOOLS = [
  ['https://profanity-api.mike-tusa.workers.dev/', 'CussCheck (profanity filter)'],
  ['https://checkdigit.mike-tusa.workers.dev/', 'CheckDigit (IBAN/VAT/GTIN check)'],
  ['https://domainage.mike-tusa.workers.dev/', 'DomainAge (domain age lookup)'],
];

const STYLE = `
:root{--fg:#1d2330;--muted:#5b6475;--bg:#f7f8fb;--card:#fff;--line:#dfe3ea;--acc:#2f5bd3;--bad:#b42318;--ok:#067647;--warn:#b54708}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header,main,footer{max-width:960px;margin:0 auto;padding:0 18px}header{display:flex;justify-content:space-between;align-items:center;padding-top:18px;flex-wrap:wrap;gap:8px}
header a.brand{font-weight:700;font-size:20px;color:var(--fg);text-decoration:none}nav a{margin-left:16px;color:var(--acc);text-decoration:none}
h1{font-size:30px;margin:22px 0 4px}h2{margin-top:34px}.lead{color:var(--muted);margin-top:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
textarea{width:100%;min-height:220px;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:10px;border:1px solid var(--line);border-radius:8px;resize:vertical}
input[type=number]{width:80px;padding:6px;border:1px solid var(--line);border-radius:6px;font:inherit}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6}button.secondary{background:#e8edf9;color:var(--acc)}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}pre{background:#0f1729;color:#e6ebf5;padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.scores{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.score{border:1px solid var(--line);border-radius:8px;padding:10px;background:#fbfcfe}.score b{display:block;font-size:24px}.score span{font-size:13px;color:var(--muted)}
.bad{color:var(--bad);font-weight:700}.ok{color:var(--ok);font-weight:700}.warn{color:var(--warn)}.muted{color:var(--muted);font-size:14px}
.long{border-left:3px solid var(--warn);padding:4px 10px;margin:8px 0;background:#fffaf2}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.tier h3{margin:0 0 4px}.price{font-size:22px;font-weight:700}
.banner{background:#fff4e5;border:1px solid #f5c26b;padding:8px 12px;border-radius:8px;font-size:14px;margin-top:12px}
footer{color:var(--muted);font-size:13px;padding:30px 18px 40px}footer a{color:var(--muted)}
@media (max-width:560px){#mcp-config{white-space:pre-wrap;word-break:break-all}}`;

// Canonical + Open Graph + Twitter card tags. Canonical/og:url come from PUBLIC_ORIGIN (config), never the request
// Host, and are omitted when it is unset. og:image is absolute (o.ogImage, built in app.js).
export function socialMeta(o, title, desc) {
  const url = o.publicOrigin ? `${o.publicOrigin}${o.path === '/' ? '/' : o.path}` : null;
  const alt = `${o.brand}: free readability scores and API by Digital Promo Hub`;
  const m = (k, v, attr = 'property') => `<meta ${attr}="${k}" content="${esc(v)}">`;
  return [
    url ? `<link rel="canonical" href="${esc(url)}">` : '',
    m('og:type', 'website'), m('og:site_name', o.brand), m('og:title', title), m('og:description', desc),
    url ? m('og:url', url) : '',
    m('og:image', o.ogImage), m('og:image:type', 'image/png'), m('og:image:width', '1200'), m('og:image:height', '630'), m('og:image:alt', alt),
    m('twitter:card', 'summary_large_image', 'name'), m('twitter:title', title, 'name'), m('twitter:description', desc, 'name'),
    m('twitter:image', o.ogImage, 'name'), m('twitter:image:alt', alt, 'name'),
  ].filter(Boolean).join('');
}

function layout(o, title, desc, body) {
  const banner = o.publicLaunch ? '' : `<div class="banner">Preview build (${esc(o.env)}). Not publicly launched yet.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="icon" href="data:,">${o.publicLaunch ? '' : '<meta name="robots" content="noindex,nofollow">'}
${socialMeta(o, title, desc)}${o.path === '/' ? '<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt"><link rel="service-desc" type="application/json" href="/openapi.json" title="OpenAPI 3.1">' : ''}
<style>${STYLE}</style></head><body>
<header><a class="brand" href="/">${esc(o.brand)}</a><nav><a href="/">Paste tool</a><a href="/docs">API docs</a><a href="/privacy">Privacy</a></nav></header>
<main>${banner}${body}</main>
<footer>${esc(o.brand)} v${esc(o.version)} by Digital Promo Hub: English readability scores (Flesch, Flesch-Kincaid, Gunning Fog, SMOG, Coleman-Liau, ARI) and text stats. Syllables are counted with the open-source ${ext('https://github.com/words/syllable', 'syllable')} library (MIT); the formulas and sentence splitter are our own. We never store or log the text you submit. <a href="/privacy">Privacy</a> · <a href="/docs">API docs</a> · <a href="/health">Status</a>${contact(o, ' · Contact: ')}<br>More free tools: ${MORE_TOOLS.map(([h, l]) => ext(h, esc(l))).join(' · ')}</footer>
</body></html>`;
}

function pricing(o) {
  return `<h2 id="pricing">Pricing</h2>
<div class="tiers">
<div class="card tier"><h3>Free</h3><div class="price">$0</div><p>${fmt(o.keyDaily)} requests/day with a free API key (${fmt(o.keyPerMin)}/min), texts up to 20 KB. Commercial use allowed. No card, no sign-up form.</p><p class="muted">Without a key: ${fmt(o.anonDaily)}/day and ${fmt(o.anonPerMin)}/min per IP (the paste tool uses this).</p></div>
<div class="card tier" id="pro"><h3>Pro</h3><div class="price">$5/month</div><p>${fmt(o.proDaily)} requests/day per license (${fmt(o.keyPerMin)}/min), texts up to 20 KB, with its own capacity separate from the free pool. Send your Pro license key in the X-API-Key header (MCP: Authorization: Bearer). Cancel any time.</p><p>${o.proCheckout ? ext(o.proCheckout, '<strong>Get PlainGrade Pro</strong>') + ' (secure checkout by Polar)' : '<span class="muted">Checkout opens shortly.</span>'}</p></div>
</div><p class="muted">Payments are handled by Polar (polar.sh), our merchant of record. See ${'<a href="/privacy#payments">Privacy</a>'} for what that means for your data. Manage or cancel a subscription in the ${ext(PRO_PORTAL_URL, 'Polar customer portal')}.</p>`;
}

function method(o) {
  return `<h2 id="how">How the scores are computed</h2>
<ul>
<li><b>Sentences</b>: our own splitter. It knows common abbreviations (Mr., Dr., e.g., i.e., U.S., a.m., etc.), decimals (3.14), ellipses, quotes ("Why?" she asked), Wikipedia-style citations ([1]), URLs and e-mail addresses. Each list/bullet item, heading and blank-line-separated paragraph is its own sentence; a single line break inside a paragraph is treated as a space.</li>
<li><b>Words</b>: runs of letters/digits, keeping apostrophes, hyphens and inner dots (don't, well-known, 3.14 and U.S. are one word each). A URL or e-mail address is one word of one syllable. Citation markers like [1] and bullet markers are not words.</li>
<li><b>Syllables</b>: the syllable library, per word part (well-known = well + known); a number counts as one syllable. Syllable counts come from a spelling-based heuristic, not a pronunciation dictionary. They are right for about 95% of common English words, so scores can differ by a few points from other tools (e.g. textstat, Hemingway) that count syllables differently.</li>
<li><b>Letters</b> (Coleman-Liau, ARI): letters and digits inside words.</li>
<li><b>Complex words</b> (Gunning Fog): 3+ syllables, excluding proper nouns (capitalised, not first in the sentence), hyphenated words, and words that reach 3 syllables only through -es, -ed or -ing. <b>Polysyllables</b> (SMOG): every word with 3+ syllables.</li>
<li>Flesch Reading Ease = 206.835 − 1.015 × (words/sentences) − 84.6 × (syllables/words). Flesch-Kincaid grade = 0.39 × (words/sentences) + 11.8 × (syllables/words) − 15.59. Gunning Fog = 0.4 × (words/sentences + 100 × complex/words). SMOG = 1.043 × √(polysyllables × 30/sentences) + 3.1291. Coleman-Liau = 0.0588 × L − 0.296 × S − 15.8 (L = letters per 100 words, S = sentences per 100 words). ARI = 4.71 × (letters/words) + 0.5 × (words/sentences) − 21.43. <b>Consensus grade</b> = the mean of the five grade-level scores.</li>
<li>Scores are not clamped: Flesch Reading Ease can go below 0 or above 100, and grades can be negative for very simple text. Reading time assumes 238 words/minute; speaking time 150 words/minute.</li>
<li>English only. Scores are unstable under ~100 words, and SMOG was designed for 30+ sentences; the response flags both in <code>notes</code>.</li>
</ul>`;
}

export function indexHtml(o) {
  return layout(o, `${o.brand}: free readability score checker and API (Flesch-Kincaid, Gunning Fog, SMOG)`, 'Paste English text to get Flesch Reading Ease, Flesch-Kincaid grade, Gunning Fog, SMOG, Coleman-Liau and ARI scores, word and sentence counts, reading time and long sentences. Free JSON API.', `
<h1>Readability score checker</h1>
<p class="lead">Paste English text to get its Flesch Reading Ease, Flesch-Kincaid grade, Gunning Fog, SMOG, Coleman-Liau and ARI scores, plus word, sentence and syllable counts, reading time and a list of long sentences. Free, no sign-up, and the same results are available as a JSON API.</p>
<div class="card">
<label for="text" class="muted">Text (English, up to ${fmt(o.maxText)} bytes)</label>
<textarea id="text" maxlength="${o.maxText}" placeholder="Type or paste text here…"></textarea>
<div class="row" style="margin-top:12px"><button id="go">Score text</button><button id="sample" class="secondary" type="button">Try a sample</button>
<label class="muted">Long sentence = more than <input type="number" id="longw" min="${o.longMin}" max="${o.longMax}" value="${o.longDefault}"> words</label><span id="count" class="muted"></span></div>
</div>
<div id="out" class="card" hidden>
<p id="verdict"></p>
<div class="scores" id="scores"></div>
<h3>Text statistics</h3><table><tbody id="stats"></tbody></table>
<h3 id="longTitle">Long sentences</h3><div id="longs"></div>
<p id="notes" class="muted"></p>
</div>
<p class="muted">Your text is sent to this site's API, scored in memory and discarded. It is never stored or logged (<a href="/privacy">privacy</a>).</p>
<h2>Use the API</h2>
<pre>curl -s ${esc(o.origin)}/v1/score \\
  -H 'content-type: application/json' \\
  -d '{"text":"The cat sat on the mat. It was happy.","lang":"en"}'</pre>
<p>Get a free key (${fmt(o.keyDaily)} requests/day, commercial use OK): <code>curl -s -X POST ${esc(o.origin)}/v1/keys -H 'content-type: application/json' -d '{}'</code>. Full reference: <a href="/docs">API docs</a>.</p>
<section id="agents"><h2>For AI agents (MCP)</h2>
<p>${esc(o.brand)} is also a remote ${ext('https://modelcontextprotocol.io/', 'Model Context Protocol')} (MCP) server with one read-only tool, <code>score_readability</code>, using the same limits and keys as the API. Most MCP clients accept this config; some use a different format (for example, VS Code uses a <code>servers</code> key). Clients with a settings screen just need the URL <code>${esc(o.origin)}/mcp</code>.</p>
<pre><code id="mcp-config">${esc(JSON.stringify({ mcpServers: { 'plaingrade-api': { type: 'http', url: `${o.origin}/mcp` } } }, null, 2))}</code></pre>
<p class="muted">Machine-readable docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI 3.1 spec</a></p></section>
${method(o)}
${pricing(o)}
<p class="muted">Questions or abuse reports: ${contact(o) || 'see the footer'}.</p>
<script src="/app.js"></script>`);
}

export function docsHtml(o) {
  return layout(o, `${o.brand} API docs: readability scores and text stats`, `${o.brand} reference: POST /v1/score, free API keys, limits and errors.`, `
<h1>API docs</h1>
<p class="lead">Base URL: <code>${esc(o.origin)}</code>. JSON in, JSON out. English only.</p>
<h2>POST /v1/score</h2>
<p>Request body (JSON, at most ${fmt(o.maxBody)} bytes):</p>
<table><tr><th>Field</th><th>Type</th><th>Notes</th></tr>
<tr><td><code>text</code></td><td>string, required</td><td>At most ${fmt(o.maxText)} bytes (UTF-8), measured after JSON decoding. The body cap leaves room for JSON escaping (quotes, newlines, backslashes), so any normal 20 KB text fits.</td></tr>
<tr><td><code>lang</code></td><td>string, default <code>"en"</code></td><td>Only English is supported (<code>en</code>, <code>en-US</code>, <code>en-GB</code>, …). Any other value returns <code>422 unsupported_language</code>.</td></tr>
<tr><td><code>long_sentence_words</code></td><td>integer, default ${o.longDefault}</td><td>A sentence with more words than this is listed in <code>long_sentences</code> (${o.longMin}–${o.longMax}).</td></tr></table>
<pre>curl -s ${esc(o.origin)}/v1/score -H 'content-type: application/json' -H 'x-api-key: pg_…' \\
  -d '{"text":"The Australian platypus is seemingly a hybrid of a mammal and reptilian creature.","lang":"en"}'</pre>
<p>Response (the real response is compact JSON):</p>
<pre>{
  "ok": true,
  "lang": "en",
  "scores": {
    "flesch_reading_ease": 24.4, "flesch_kincaid_grade": 13.1, "gunning_fog": 14.4, "smog": 14.6,
    "coleman_liau": 12.7, "ari": 9.7, "consensus_grade": 12.9
  },
  "interpretation": { "flesch_reading_ease": "Very difficult", "audience": "College graduate", "consensus_grade": "College" },
  "stats": {
    "characters": 81, "characters_no_spaces": 69, "letters": 68, "words": 13, "sentences": 1, "paragraphs": 1,
    "syllables": 26, "polysyllable_words": 4, "complex_words": 3, "avg_words_per_sentence": 13,
    "avg_syllables_per_word": 2, "avg_letters_per_word": 5.23, "reading_time_seconds": 3, "reading_time": "3 s",
    "speaking_time_seconds": 5
  },
  "long_sentences": { "threshold_words": 25, "count": 0, "items": [], "truncated": false },
  "notes": ["short_text: …", "smog_under_30_sentences: …"],
  "text_bytes": 81,
  "engine": "${esc(o.engine)}",
  "version": "${esc(o.version)}"
}</pre>
<p><code>long_sentences.items</code> holds up to 50 entries <code>{ index, start, end, words, text }</code>: <code>index</code> is the sentence number (0-based), <code>start</code>/<code>end</code> are JavaScript string (UTF-16) offsets into your text (end exclusive), and <code>text</code> is the sentence, cut to 300 characters. <code>scores</code> and <code>interpretation</code> are <code>null</code> when the text has no words. <code>notes</code> can include <code>short_text</code>, <code>smog_under_30_sentences</code>, <code>no_words</code> and <code>likely_not_english</code> (most letters are not Latin script).</p>
<h2>POST /v1/keys</h2>
<p>Issues a free API key: ${fmt(o.keyDaily)} requests/day, ${fmt(o.keyPerMin)}/min, commercial use allowed. No email or sign-up needed. The key is shown once; we store only its SHA-256 hash. Up to 3 keys per IP per day (at most 2 per minute). Lost a key or need it revoked? ${contact(o, 'Email ') || 'Contact us.'}</p>
<pre>curl -s -X POST ${esc(o.origin)}/v1/keys -H 'content-type: application/json' -d '{}'</pre>
<p>Send it as <code>X-API-Key</code>. <code>GET /v1/usage</code> with the header shows today's usage.</p>
<h2>Limits and headers</h2>
<ul><li>Without a key: ${fmt(o.anonPerMin)} requests/min and ${fmt(o.anonDaily)}/day per IP. With a free key: ${fmt(o.keyPerMin)}/min and ${fmt(o.keyDaily)}/day.</li>
<li>Responses carry <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and <code>X-RateLimit-Reset</code> (daily quota, reset at 00:00 UTC, Unix seconds), <code>X-RateLimit-Policy</code> and <code>X-API-Plan</code>. A 429 includes <code>Retry-After</code>. CORS is open (<code>Access-Control-Allow-Origin: *</code>) on <code>/v1/score</code>.</li>
<li>Body over ${fmt(o.maxBody)} bytes (by Content-Length or by the bytes actually sent): <code>413 body_too_large</code>. Text over ${fmt(o.maxText)} bytes: <code>413 text_too_large</code>.</li>
<li>There is also a service-wide daily soft cap. If it's reached, you get <code>429 daily_cap_reached</code> until 00:00 UTC.</li></ul>
<h2>Errors</h2>
<p>Errors look like <code>{"ok":false,"error":{"code":"…","message":"…"}}</code>. Codes: <code>invalid_json</code>, <code>missing_text</code>, <code>invalid_lang</code>, <code>invalid_long_sentence_words</code> (400); <code>invalid_api_key</code>, <code>missing_api_key</code> (401); <code>cross_origin_forbidden</code> (403); <code>not_found</code> (404); <code>method_not_allowed</code> (405); <code>body_too_large</code>, <code>text_too_large</code> (413); <code>unsupported_media_type</code> (415); <code>unsupported_language</code> (422); <code>rate_limited</code>, <code>ip_daily_quota</code>, <code>key_quota_exceeded</code>, <code>issuer_quota_exceeded</code>, <code>key_issue_limit</code>, <code>daily_cap_reached</code> (429); <code>internal_error</code> (500); <code>not_configured</code>, <code>unavailable</code> (503).</p>
<h2>Other endpoints</h2>
<p><code>GET /health</code> returns the service status and version. <code>GET /privacy</code> is the privacy note.</p>
${method(o)}
<h2>Support</h2>
<p>Questions, key revocation or abuse reports: ${contact(o) || 'not configured yet'}.</p>
${pricing(o)}`);
}

export function privacyHtml(o) {
  return layout(o, `${o.brand} privacy`, `${o.brand} privacy: submitted text is never stored or logged. We keep only expiring rate-limit counters (IPs hashed) and hashed API keys.`, `
<h1>Privacy</h1>
<div class="card">
<p><strong>We never store or log the text you submit.</strong> Each request is scored in memory inside a Cloudflare Worker, the result is returned to you, and the text is discarded. That includes the small word cache used to speed up syllable counting: it is emptied at the end of every request, so no word from your text is kept for the next one. Text is not written to any database or key-value store, it is not logged, it is not used for analytics or training, and it is never sent to any other service. Scoring runs locally and makes no outside calls.</p>
<p>What we do keep, for rate limiting and quotas only:</p>
<ul>
<li>Daily request counters per API key and per IP address. IP addresses are stored only as keyed hashes (HMAC), never in plain form, and every counter expires after 2 days. Our rate limiter is also keyed on that hash, not on your IP address.</li>
<li>For each API key: a SHA-256 hash of the key (never the key itself), its creation time, plan and daily quota, plus a keyed hash of the issuing network for abuse limits. We don't ask for an email address or any personal details.</li>
</ul>
<p>The service runs on Cloudflare Workers, so Cloudflare handles network traffic under its own privacy policy. Our Worker has request logging and analytics turned off.</p>
<p>Questions, data requests or abuse reports: ${contact(o) || 'contact details coming soon'}.</p>
<h2 id="payments">Payments (PlainGrade Pro)</h2>
<p>Pro subscriptions are sold and billed by ${ext('https://polar.sh', 'Polar')} (polar.sh), our merchant of record. Polar collects your name, email address and payment details and handles taxes, receipts and cancellations under ${ext('https://polar.sh/legal/privacy-policy', 'its own privacy policy')}. We never see or store your card details. Manage or cancel your subscription in the ${ext(PRO_PORTAL_URL, 'Polar customer portal')}.</p>
<p>When you subscribe, Polar issues a license key. To check it, our Worker reads a small record (status, plan, product and expiry; no name, email or payment details) from a store kept up to date by our billing service. We do not log the key; usage counters use a one-way hash of it and expire after 2 days. Submitted text is handled exactly as for free users: never stored or logged.</p>
<h2 id="rapidapi">RapidAPI</h2>
<p>PlainGrade is also offered on the ${ext('https://rapidapi.com', 'RapidAPI')} marketplace. If you use it there, RapidAPI handles your account, API key, subscription, billing and usage metering under ${ext('https://rapidapi.com/privacy', 'its own privacy policy')}, and your requests pass through RapidAPI's servers before they reach ours. On our side the RapidAPI route works like the free API: the text is scored in memory and never stored or logged. We keep only a short-lived per-minute rate-limit counter keyed by a one-way hash of your RapidAPI username.</p>
<p class="muted">Last updated: October 16, 2026.</p>
</div>`);
}

export const appJs = `(() => {
  const mc = document.getElementById('mcp-config');
  if (mc) mc.textContent = JSON.stringify({ mcpServers: { 'plaingrade-api': { type: 'http', url: location.origin + '/mcp' } } }, null, 2);
  const $ = (id) => document.getElementById(id);
  const text = $('text'), go = $('go'), out = $('out'), count = $('count');
  const enc = new TextEncoder();
  const limit = Number(text.getAttribute('maxlength')) || 20480;
  const upd = () => { const n = enc.encode(text.value).length; count.textContent = n.toLocaleString() + ' / ' + limit.toLocaleString() + ' bytes'; count.className = n > limit ? 'bad' : 'muted'; };
  text.addEventListener('input', upd); upd();
  $('sample').addEventListener('click', () => {
    text.value = 'Readability formulas estimate how hard a text is to read. They count words, sentences and syllables, then turn those counts into a score. Short sentences and short words make text easier. Dr. Rudolf Flesch published his Reading Ease formula in 1948, and the U.S. Navy adopted the Flesch-Kincaid grade level in 1975.\\n\\nThis sentence is deliberately long, winding and full of clauses, because it wants to show you what the tool reports when a writer keeps adding one more idea, and then another, without ever stopping to let the reader breathe.';
    upd();
  });
  const td = (tr, v) => { const c = document.createElement('td'); c.textContent = v; tr.appendChild(c); };
  const NAMES = [['flesch_reading_ease', 'Flesch Reading Ease'], ['flesch_kincaid_grade', 'Flesch-Kincaid grade'], ['gunning_fog', 'Gunning Fog'], ['smog', 'SMOG'], ['coleman_liau', 'Coleman-Liau'], ['ari', 'ARI'], ['consensus_grade', 'Consensus grade']];
  const STATS = [['words', 'Words'], ['sentences', 'Sentences'], ['paragraphs', 'Paragraphs'], ['syllables', 'Syllables'], ['characters', 'Characters'], ['characters_no_spaces', 'Characters (no spaces)'], ['letters', 'Letters and digits'], ['polysyllable_words', 'Words with 3+ syllables'], ['complex_words', 'Complex words (Gunning Fog)'], ['avg_words_per_sentence', 'Words per sentence'], ['avg_syllables_per_word', 'Syllables per word'], ['avg_letters_per_word', 'Letters per word'], ['reading_time', 'Reading time']];
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Scoring…';
    const v = $('verdict'), scores = $('scores'), stats = $('stats'), longs = $('longs'), notes = $('notes');
    try {
      const lw = parseInt($('longw').value, 10);
      const body = { text: text.value, lang: 'en' };
      if (Number.isInteger(lw)) body.long_sentence_words = lw;
      const r = await fetch('/v1/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      out.hidden = false; scores.textContent = ''; stats.textContent = ''; longs.textContent = ''; notes.textContent = '';
      if (!j.ok) { v.className = 'bad'; v.textContent = 'Error: ' + ((j.error && j.error.message) || r.status); return; }
      if (!j.scores) { v.className = 'bad'; v.textContent = 'No words found, so there is nothing to score.'; }
      else {
        v.className = 'ok';
        v.textContent = 'Flesch Reading Ease ' + j.scores.flesch_reading_ease + ' (' + j.interpretation.flesch_reading_ease + ', ' + j.interpretation.audience + '). Consensus grade ' + j.scores.consensus_grade + ' (' + j.interpretation.consensus_grade + ').';
        for (const [k, name] of NAMES) {
          const d = document.createElement('div'); d.className = 'score';
          const b = document.createElement('b'); b.textContent = String(j.scores[k]);
          const s = document.createElement('span'); s.textContent = name;
          d.appendChild(b); d.appendChild(s); scores.appendChild(d);
        }
      }
      for (const [k, name] of STATS) { const tr = document.createElement('tr'); td(tr, name); td(tr, j.stats[k] === null ? '-' : String(j.stats[k])); stats.appendChild(tr); }
      $('longTitle').textContent = 'Long sentences (more than ' + j.long_sentences.threshold_words + ' words): ' + j.long_sentences.count;
      for (const s of j.long_sentences.items) {
        const p = document.createElement('div'); p.className = 'long';
        p.textContent = '#' + (s.index + 1) + ' (' + s.words + ' words): ' + s.text; longs.appendChild(p);
      }
      if (j.long_sentences.count === 0) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'None.'; longs.appendChild(p); }
      if (j.notes.length) notes.textContent = 'Notes: ' + j.notes.map((n) => n.split(': ').slice(1).join(': ') || n).join(' ');
    } catch (e) {
      out.hidden = false; v.className = 'bad'; v.textContent = 'Request failed. Please try again.';
    } finally { go.disabled = false; go.textContent = 'Score text'; }
  });
})();
`;
