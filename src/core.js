// Shared constants + input validation (imported by app.js and mcp.js; kept separate to avoid an import cycle).
import { DEFAULT_LONG_SENTENCE_WORDS } from './readability.js';

export const VERSION = '0.5.0';
export const MAX_TEXT_BYTES = 20 * 1024;  // 20,480 bytes, UTF-8 length of "text"
export const LONG_MIN = 5; export const LONG_MAX = 200;

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const utf8Len = (s) => new TextEncoder().encode(s).byteLength;

/** Validates { text, lang, long_sentence_words } with the exact rules + messages of POST /v1/score (v0.2.x). */
export function validateScoreInput(body) {
  if (typeof body.text !== 'string') throw new HttpError(400, 'missing_text', '"text" (string) is required.');
  const textBytes = utf8Len(body.text);
  if (textBytes > MAX_TEXT_BYTES) throw new HttpError(413, 'text_too_large', `"text" is ${textBytes.toLocaleString('en-US')} bytes; the limit is ${MAX_TEXT_BYTES.toLocaleString('en-US')} bytes (20 KB, UTF-8). Split longer text into several requests.`);
  let lang = 'en';
  if (body.lang !== undefined && body.lang !== null) {
    if (typeof body.lang !== 'string') throw new HttpError(400, 'invalid_lang', '"lang" must be a string language code. Only "en" (English) is supported.');
    if (!/^en(?:[-_][a-z0-9]{2,8})*$/i.test(body.lang.trim())) {
      throw new HttpError(422, 'unsupported_language', `lang "${body.lang.slice(0, 20)}" is not supported. Only English ("en", incl. en-US/en-GB) is supported: these readability formulas are calibrated for English, so scores for other languages would be misleading.`);
    }
  }
  let longWords = DEFAULT_LONG_SENTENCE_WORDS;
  if (body.long_sentence_words !== undefined && body.long_sentence_words !== null) {
    const v = body.long_sentence_words;
    if (!Number.isInteger(v) || v < LONG_MIN || v > LONG_MAX) throw new HttpError(400, 'invalid_long_sentence_words', `"long_sentence_words" must be an integer from ${LONG_MIN} to ${LONG_MAX} (default ${DEFAULT_LONG_SENTENCE_WORDS}).`);
    longWords = v;
  }
  return { text: body.text, textBytes, lang, longWords };
}
