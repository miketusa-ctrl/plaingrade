// Readability formulas (hand-written from the published definitions) and text statistics. Pure, no I/O.
// Syllables come from the `syllable` package (MIT, wooorm). Nothing here logs or stores text.
import { syllable } from 'syllable';
import { splitSentences, countParagraphs, CITATION_RE } from './sentences.js';
import { trimEndChars } from './text-utils.js';

export const ENGINE = 'syllable@5.0.1 (+ small correction list) with in-house formulas and sentence splitter';
export const READING_WPM = 238;  // average silent reading speed for adults, non-fiction (Brysbaert 2019)
export const SPEAKING_WPM = 150; // typical presentation pace
export const DEFAULT_LONG_SENTENCE_WORDS = 25;
export const MAX_LONG_SENTENCES = 50;
export const LONG_SENTENCE_PREVIEW = 300;

// ---------------------------------------------------------------------------------------------------------------
// Formulas. W = words, S = sentences, Sy = syllables, L = letters+digits in words.
export const fleschReadingEase = (W, S, Sy) => 206.835 - 1.015 * (W / S) - 84.6 * (Sy / W);
export const fleschKincaidGrade = (W, S, Sy) => 0.39 * (W / S) + 11.8 * (Sy / W) - 15.59;
export const gunningFog = (W, S, complex) => 0.4 * ((W / S) + 100 * (complex / W));
export const smog = (S, poly) => 1.043 * Math.sqrt(poly * (30 / S)) + 3.1291;
export const colemanLiau = (W, S, L) => 0.0588 * ((L / W) * 100) - 0.296 * ((S / W) * 100) - 15.8;
export const automatedReadabilityIndex = (W, S, L) => 4.71 * (L / W) + 0.5 * (W / S) - 21.43;

export function fleschLabel(fre) {
  if (fre >= 90) return { label: 'Very easy', audience: '5th grade' };
  if (fre >= 80) return { label: 'Easy', audience: '6th grade' };
  if (fre >= 70) return { label: 'Fairly easy', audience: '7th grade' };
  if (fre >= 60) return { label: 'Plain English', audience: '8th-9th grade' };
  if (fre >= 50) return { label: 'Fairly difficult', audience: '10th-12th grade' };
  if (fre >= 30) return { label: 'Difficult', audience: 'College' };
  return { label: 'Very difficult', audience: 'College graduate' };
}
export function gradeLabel(g) {
  const n = Math.round(g);
  if (n < 1) return 'Kindergarten';
  if (n <= 12) return `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} grade`;
  if (n <= 16) return 'College';
  return 'College graduate';
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens. Linear-time by construction: the e-mail branch can only start at the beginning of a run (lookbehind) and
// its parts are length-bounded, so a 20 KB run of letters can't trigger quadratic backtracking.
const URL_EMAIL = /(?:\b(?:https?|ftp):\/\/|\bwww\.)[^\s<>"'`]+|(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/giu;
const URL_TRAILING = new Set(`.,;:!?)]}"'”’`);
const WORD = /[\p{L}\p{N}]+(?:['’.\-‐][\p{L}\p{N}]+)*/gu;
const LETTER = /[\p{L}\p{N}]/gu;

// Corrections for common words the syllable heuristic miscounts (checked against dictionary syllabification).
const OVERRIDES = new Map(Object.entries({
  ruin: 2, ruins: 2, ruined: 2, fluid: 2, fluids: 2, poem: 2, poems: 2, poet: 2, poets: 2, poetry: 3, ideas: 3,
  area: 3, areas: 3, museum: 3, museums: 3, science: 2, sciences: 3, scientist: 3, scientists: 3, scientific: 4,
  experience: 4, experiences: 5, experienced: 4, prove: 1, proves: 1, proved: 1, evening: 2, evenings: 2,
}));
const cache = new Map();
function rawSyllables(key) {
  const o = OVERRIDES.get(key);
  if (o !== undefined) return o;
  // The library undercounts -ing after a vowel ("going" = 1, "seeing" = 3): count the stem, then add one for -ing.
  if (key.length > 4 && /[aeiouy]ing$/.test(key)) return Math.max(1, syllable(key.slice(0, -3))) + 1;
  return Math.max(1, syllable(key));
}
function syllablesOfPart(part) {
  const p = part.replace(/['’]/g, '');
  if (!/\p{L}/u.test(p)) return 1; // numbers count as one syllable
  const key = p.toLowerCase();
  if (key.length > 40) return Math.max(1, (key.match(/[aeiouy]+/g) || []).length); // longer than any real word
  let n = cache.get(key);
  if (n === undefined) {
    n = rawSyllables(key);
    if (cache.size > 20000) cache.clear();
    cache.set(key, n);
  }
  return n;
}
/** Syllables in one word token; hyphenated/dotted parts are counted separately ("well-known" = 2, "U.S" = 2). */
const wordCache = new Map();
export function wordSyllables(word) {
  let n = wordCache.get(word);
  if (n !== undefined) return n;
  n = 0;
  for (const part of word.split(/[.\-‐]/)) if (part) n += syllablesOfPart(part);
  n = Math.max(1, n);
  if (wordCache.size > 20000) wordCache.clear();
  wordCache.set(word, n);
  return n;
}
// Word tokens are letters/digits joined by ' ’ . - ‐, so letters = length minus joiners (URLs: count explicitly).
const JOINERS = /['’.\-‐]/g;
const lettersIn = (t) => (t.url ? (t.w.match(LETTER) || []).length : t.w.length - (t.w.match(JOINERS) || []).length);

/** Word tokens of one sentence: [{ w, url, first }]. URLs/e-mails count as one word; citations are ignored. */
export function tokenize(s) {
  const toks = [];
  let masked = s.includes('[') ? s.replace(CITATION_RE, (c) => ' '.repeat(c.length)) : s;
  if (masked.includes('@') || masked.includes('://') || /www\./i.test(masked)) {
    masked = masked.replace(URL_EMAIL, (u, offset) => {
      const trimmed = trimEndChars(u, URL_TRAILING); // loop, not /[...]+$/ (quadratic on long punctuation runs)
      toks.push({ i: offset, w: trimmed, url: true });
      return ' '.repeat(trimmed.length) + u.slice(trimmed.length);
    });
  }
  const hadUrls = toks.length > 0;
  for (const m of masked.matchAll(WORD)) toks.push({ i: m.index, w: m[0], url: false });
  if (hadUrls) toks.sort((a, b) => a.i - b.i);
  return toks;
}

/** Gunning's "complex word": 3+ syllables, not a proper noun, not hyphenated, not 3 syllables only via -es/-ed/-ing. */
function isComplex(tok, syl, first) {
  if (tok.url || syl < 3) return false;
  if (/[-‐]/.test(tok.w)) return false;
  if (!first && /^\p{Lu}/u.test(tok.w) && !/^\p{Lu}+$/u.test(tok.w)) return false; // proper noun (not ALL CAPS)
  const m = /(?:es|ed|ing)$/i.test(tok.w) ? /^(.*?)(es|ed|ing)$/i.exec(tok.w) : null;
  if (m && m[1].length > 1 && wordSyllables(m[1]) < 3) return false;
  return true;
}

/** Length in Unicode code points (surrogate pairs count once). */
function cpLength(s) { let n = s.length; for (const _ of s.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) n--; return n; }
const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const utf8Bytes = (s) => new TextEncoder().encode(s).byteLength;

function fmtDuration(sec) {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60); const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * Analyse English text. Options: longSentenceWords (default 25).
 * Returns the API result object (scores null when there are no words).
 */
// Privacy: the syllable caches live for one request only. analyze() clears them on return, so no submitted word
// outlives the request that sent it. Within a request they still help, because texts repeat words a lot.
export function analyze(text, opts) {
  try { return analyzeInner(text, opts); } finally { cache.clear(); wordCache.clear(); }
}
/** Test hook: sizes of the syllable caches (both must be 0 between requests). */
export const _cacheSizesForTests = () => [cache.size, wordCache.size];
function analyzeInner(text, { longSentenceWords = DEFAULT_LONG_SENTENCE_WORDS } = {}) {
  const sentences = splitSentences(text);
  let W = 0; let Sy = 0; let L = 0; let poly = 0; let complex = 0; let S = 0;
  const long = [];
  for (let idx = 0; idx < sentences.length; idx++) {
    const sen = sentences[idx];
    const toks = tokenize(sen.text);
    if (!toks.length) continue;
    S++;
    toks.forEach((t, k) => {
      const syl = t.url ? 1 : wordSyllables(t.w);
      Sy += syl; L += lettersIn(t);
      if (!t.url && syl >= 3) poly++;
      if (isComplex(t, syl, k === 0)) complex++;
    });
    W += toks.length;
    if (toks.length > longSentenceWords) {
      long.push({ index: S - 1, start: sen.start, end: sen.end, words: toks.length, text: sen.text.length > LONG_SENTENCE_PREVIEW ? sen.text.slice(0, LONG_SENTENCE_PREVIEW - 1) + '…' : sen.text });
    }
  }
  const chars = cpLength(text);
  const charsNoSpaces = cpLength(text.replace(/\s+/g, ''));
  const letterCount = text.replace(/\P{L}+/gu, '').length;
  const latin = text.replace(/\P{Script=Latin}+/gu, '').replace(/\P{L}+/gu, '').length;

  const notes = [];
  let scores = null; let interpretation = null;
  if (W > 0 && S > 0) {
    const fre = fleschReadingEase(W, S, Sy);
    const fk = fleschKincaidGrade(W, S, Sy);
    const fog = gunningFog(W, S, complex);
    const sm = smog(S, poly);
    const cli = colemanLiau(W, S, L);
    const ari = automatedReadabilityIndex(W, S, L);
    const consensus = (fk + fog + sm + cli + ari) / 5;
    scores = {
      flesch_reading_ease: round(fre), flesch_kincaid_grade: round(fk), gunning_fog: round(fog), smog: round(sm),
      coleman_liau: round(cli), ari: round(ari), consensus_grade: round(consensus),
    };
    const fl = fleschLabel(fre);
    interpretation = { flesch_reading_ease: fl.label, audience: fl.audience, consensus_grade: gradeLabel(consensus) };
    if (W < 100) notes.push('short_text: under 100 words; readability formulas are unstable on very short text.');
    if (S < 30) notes.push('smog_under_30_sentences: SMOG was designed for samples of 30+ sentences; it is scaled to 30 here.');
  } else {
    notes.push('no_words: the text contains no words, so no scores were computed.');
  }
  if (letterCount >= 20 && latin / letterCount < 0.8) {
    notes.push('likely_not_english: most letters are not Latin script. These formulas are calibrated for English only, so the scores are not meaningful for this text.');
  }
  const readSec = Math.round((W / READING_WPM) * 60);
  const speakSec = Math.round((W / SPEAKING_WPM) * 60);
  return {
    scores,
    interpretation,
    stats: {
      characters: chars,
      characters_no_spaces: charsNoSpaces,
      letters: L,
      words: W,
      sentences: S,
      paragraphs: countParagraphs(text),
      syllables: Sy,
      polysyllable_words: poly,
      complex_words: complex,
      avg_words_per_sentence: S ? round(W / S, 2) : null,
      avg_syllables_per_word: W ? round(Sy / W, 2) : null,
      avg_letters_per_word: W ? round(L / W, 2) : null,
      reading_time_seconds: readSec,
      reading_time: fmtDuration(readSec),
      speaking_time_seconds: speakSec,
    },
    long_sentences: {
      threshold_words: longSentenceWords,
      count: long.length,
      items: long.slice(0, MAX_LONG_SENTENCES),
      truncated: long.length > MAX_LONG_SENTENCES,
    },
    notes,
    text_bytes: utf8Bytes(text),
  };
}

// Module-load warm-up: compiles the splitter/tokenizer/syllable regexes and lets V8 tier up the hot paths during
// Worker startup (startup has its own limit and is not billed to the first request's cpu_ms). Fixed synthetic text,
// ~6 KB, analysed 3 times (~10-20 ms of startup); nothing user-provided. Caches are cleared afterwards.
{
  const base = 'Mr. Smith met Dr. Jones in the U.S. at 5 p.m. on Jan. 3. "Why?" she asked... The rate was 3.14%.[1] ' +
    'See https://example.com/a or mail jo@example.org. Readability formulas estimate comprehension difficulty, ' +
    'counting syllables, sentences and characters; unbelievably, interdisciplinary organisations rarely publish them.\n' +
    '- first item\n- second item\n\nIntroduction\nWell-known authors don\'t write extraordinarily complicated paragraphs. ' +
    'It was going well, and everyone was seeing results! A b. C d. Wait... Then it rained. ';
  let warm = '';
  for (let i = 0; warm.length < 6000; i++) warm += base.replace(/authors/g, 'authors' + (i % 7 ? '' : 'x' + i));
  for (let i = 0; i < 3; i++) analyze(warm);
  cache.clear(); wordCache.clear();
}
