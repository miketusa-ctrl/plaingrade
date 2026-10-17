// English sentence splitter for readability scoring. Pure functions, no I/O.
//
// Returns spans into the ORIGINAL string ({ start, end, text }, UTF-16 indices, end exclusive), so callers can
// report offsets. Design (documented in /docs and README):
//  1. Hard boundaries (always split): blank lines, list/bullet items (each item is its own sentence), Markdown
//     headings, and short title-like lines with no closing punctuation followed by a line that starts a new thought.
//     Other single newlines are treated as spaces (hard-wrapped prose).
//  2. Soft boundaries inside a block: a run of terminators (. ! ? ‽ … "..." ". . .") followed by optional closing
//     quotes/brackets and Wikipedia-style citations ([1], [a], [citation needed]) and then whitespace or the end.
//     A period with no whitespace after it never splits (decimals 3.14, versions 1.2.3, domains, e-mails, URLs,
//     U.S.-style initialisms inside a word).
//  3. Abbreviation rules for a single period decide whether a candidate is a real boundary (see decidePeriod).
// Spans with no letter or digit (e.g. a lone "---" or "...") are dropped.
import { trimEndChars } from './text-utils.js';

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Never end a sentence (titles and Latin-style abbreviations that always continue).
const ALWAYS_CONTINUE = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'rev', 'fr', 'gen', 'col', 'lt', 'sgt', 'capt', 'cmdr', 'adm', 'maj',
  'gov', 'sen', 'rep', 'pres', 'hon', 'supt', 'messrs', 'mme', 'mlle', 'mt', 'ft',
  'e.g', 'i.e', 'cf', 'vs', 'viz', 'approx', 'dept', 'univ', 'assn', 'esp', 'incl', 'excl', 'w.r.t',
]);
// Abbreviations only before a number ("No. 5", "p. 12", "Fig. 3", "ca. 1500"); otherwise ordinary words.
const NUMBER_ABBR = new Set(['no', 'nos', 'p', 'pp', 'vol', 'vols', 'fig', 'figs', 'eq', 'eqs', 'ch', 'chap', 'sec', 'art', 'op', 'pt', 'ca', 'c', 'nr']);
// May end a sentence: split only when the next word is a common sentence starter ("in the U.S. The ...").
const AMBIGUOUS = new Set([
  'inc', 'ltd', 'co', 'corp', 'llc', 'plc', 'bros', 'jr', 'sr', 'st', 'al', 'esq', 'ave', 'blvd', 'rd',
  'min', 'max', 'avg', 'est', 'misc', 'govt', 'intl', 'natl', 'hr', 'hrs', 'mins', 'secs', 'yr', 'yrs', 'mo', 'mos',
  'wk', 'wks', 'oz', 'lb', 'lbs', 'km', 'cm', 'mm', 'kg', 'mg', 'ml', 'sq', 'tbsp', 'tsp', 'qt', 'gal', 'dist', 'div',
]);
// Capitalised month/day abbreviations ("Jan.", "Tues."); lowercase forms are real words (mar, sat, sun, wed).
const CAP_ONLY_AMBIGUOUS = new Set(['jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun']);
// "etc." usually ends a sentence when a capitalised word follows.
const SPLIT_IF_CAPITAL = new Set(['etc']);

// Common sentence-initial words (used only after ambiguous abbreviations and initials).
const STARTERS = new Set(('The A An I It Its He She We They You This That These Those There Here But And So Or Yet If When ' +
  'While After Before Then Now However In On At For As By To From With Without Our My Your His Her Their One Some Many ' +
  'Most All Each Every No Not Also Thus Therefore Meanwhile Although Though Because Since Today Yesterday Tomorrow What ' +
  'Why How Where Who Whom Whose Which Do Does Did Is Are Was Were Be Been Has Have Had Can Could Will Would Should Must ' +
  'May Might Let Please Still Even Just Only Such Both Neither Nor Other Another Later Finally First Second Third Next ' +
  'Last Once Over Under Few Several Instead Indeed Moreover Furthermore Nevertheless Otherwise Yes Oh Well Unlike Like ' +
  'Despite During Until Unless Whether Any Much More Less Its Every').split(' '));

const INITIALISM = /^(?:[a-z]{1,2}\.)+[a-z]{1,2}$/i; // U.S, e.g, a.m, Ph.D, D.C (final period excluded)
const BULLET = /^[ \t]*(?:[-*+•·▪◦‣●○■□➢➤►–—]|\(?\d{1,3}[.)]|\(?[a-z][)]|\([a-zA-Z]\)|[a-z]\.|\(?[ivx]{1,5}[.)])[ \t]+(?=\S)/;
const HEADING = /^[ \t]*#{1,6}[ \t]+\S/;
const OPENERS = `"'“‘«([{`;

// Candidate boundary: terminator run, closers, citations, closers, then whitespace or end of block.
const CITATION_SRC = String.raw`\[(?:\d{1,4}(?:\s?[,–-]\s?\d{1,4})*|[a-z]|[ivx]{2,4}|citation needed|clarification needed|when\?|who\?|according to whom\?|[a-z]{1,8} \d{1,3})\]`;
// Linear-time: a run of terminators or closers is matched atomically ((?=(X))\N idiom) and only from the start of the
// run, so a long run NOT followed by whitespace fails once instead of backtracking quadratically. Citations are capped
// at 10 in a row ({0,10}, not *): with *, every '?' inside a run of "[when?]" citations started a scan over all
// following citations (O(n^2), 135 ms on 20 KB). Real text never ends a sentence with 10+ citations.
const CLOSERS = String.raw`["'”’»)\]]*`;
const BOUNDARY = new RegExp(String.raw`(\.(?:[ \u00a0]\.){2,}|(?<!…)(?=(…+))\2|(?<![.!?‽])(?=([.!?‽]+))\3)(?=(${CLOSERS}))\4((?:${CITATION_SRC}){0,10})(?=(${CLOSERS}))\6(?=\s|$)`, 'giu');
export const CITATION_RE = new RegExp(CITATION_SRC, 'giu');

/** Split text into hard blocks ([start, end) ranges). */
export function hardBlocks(text) {
  const lines = [];
  const re = /[^\n]*(?:\n|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '' && m.index >= text.length) break;
    const raw = m[0];
    const content = raw.endsWith('\n') ? raw.slice(0, -1).replace(/\r$/, '') : raw;
    lines.push({ start: m.index, end: m.index + content.length, s: content });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  const blocks = [];
  let cur = null; let prev = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };
  for (const ln of lines) {
    const blank = !/\S/.test(ln.s);
    if (blank) { close(); prev = null; continue; }
    const bm = BULLET.exec(ln.s);
    const isBullet = !!bm;
    const isHeading = HEADING.test(ln.s);
    let boundary = false;
    if (!cur || isBullet || isHeading) boundary = true;
    else if (prev && (prev.heading)) boundary = true;
    else if (prev && prev.bullet && !/^[ \t]+\S/.test(ln.s)) boundary = true; // unindented line after an item
    else if (prev && isTitleLine(prev.s) && startsNewThought(ln.s)) boundary = true;
    if (boundary) {
      close();
      const contentStart = ln.start + (bm ? bm[0].length : (isHeading ? /^[ \t]*#{1,6}[ \t]+/.exec(ln.s)[0].length : 0));
      cur = { start: contentStart, end: ln.end, bullet: isBullet };
    } else {
      cur.end = ln.end;
    }
    prev = { s: ln.s, bullet: isBullet || (prev && prev.bullet && !boundary), heading: isHeading };
  }
  close();
  return blocks;
}

function isTitleLine(s) {
  const t = s.trim();
  if (t.length === 0 || t.length >= 60) return false;
  if (/[.!?…:;,\-–—]["'”’)\]]*$/.test(t)) return false;
  if (!/^[\p{Lu}\p{N}"“'‘(]/u.test(t)) return false;
  return t.split(/\s+/).length <= 10;
}
function startsNewThought(s) { return /^[ \t]*[\p{Lu}\p{N}"“'‘(]/u.test(s); }

// Trailing closers are stripped with a loop (trimEndChars), not an end-anchored /[...]+$/ (quadratic on long runs).
const TRAILING_CLOSERS = new Set(`"'”’»)]}`);

/** Token immediately before position i (letters, digits, dots, apostrophes), with surrounding brackets/quotes removed. */
function tokenBefore(text, i) {
  let j = i;
  while (j > 0 && !/\s/.test(text[j - 1])) j--;
  return trimEndChars(text.slice(j, i).replace(/^[\s"'“‘«(\[{]+/, ''), TRAILING_CLOSERS);
}

/** The next word after position i (skips whitespace and opening quotes/brackets). Returns { word, opener }. */
function nextWord(text, i, end) {
  let j = i;
  while (j < end && /\s/.test(text[j])) j++;
  let opener = false;
  while (j < end && OPENERS.includes(text[j])) { opener = true; j++; }
  const m = /^[\p{L}\p{N}][\p{L}\p{N}'’\-]*/u.exec(text.slice(j, Math.min(end, j + 64)));
  return { word: m ? m[0] : '', opener, atEnd: j >= end, ch: text[j] || '' };
}

const isLower = (w) => /^\p{Ll}/u.test(w);
const isUpper = (w) => /^\p{Lu}/u.test(w);
const isDigit = (w) => /^\p{N}/u.test(w);

/** Classify the abbreviation (if any) that ends at a single period. */
export function abbreviationKind(token) {
  if (!token) return null;
  const t = token.toLowerCase();
  if (ALWAYS_CONTINUE.has(t)) return 'always';
  if (/^[a-z]$/i.test(token)) return token === token.toUpperCase() ? 'initial' : 'ambiguous'; // J. R. R. Tolkien / v.
  if (INITIALISM.test(token)) return 'ambiguous'; // U.S, a.m, p.m, D.C, Ph.D
  if (NUMBER_ABBR.has(t)) return 'number';
  if (SPLIT_IF_CAPITAL.has(t)) return 'etc';
  if (AMBIGUOUS.has(t)) return 'ambiguous';
  if (CAP_ONLY_AMBIGUOUS.has(t) && isUpper(token)) return 'ambiguous';
  return null;
}

/** Decide whether a single "." followed by whitespace ends the sentence. */
export function decidePeriod(token, next) {
  const kind = abbreviationKind(token);
  if (next.atEnd) return true;
  const w = next.word;
  if (!w) return kind !== 'always'; // followed by a symbol, dash, etc.
  if (isLower(w)) return kind === null; // "approx. ten", "U.S. officials" vs casual lowercase prose
  if (isDigit(w)) return !(kind === 'always' || kind === 'number' || kind === 'ambiguous');
  // Uppercase (or other script) next word.
  switch (kind) {
    case 'always': return false;
    case 'number': return true; // "I said no. Then ..."
    case 'etc': return true;
    case 'initial':
    case 'ambiguous': return STARTERS.has(w) || next.opener;
    default: return true;
  }
}

/** Split one block range into sentence spans. */
function splitBlock(text, start, end, out) {
  const block = text.slice(start, end);
  BOUNDARY.lastIndex = 0;
  let segStart = 0; let m;
  while ((m = BOUNDARY.exec(block)) !== null) {
    const term = m[1]; const closers = m[4] + m[6];
    const after = m.index + m[0].length;
    const next = nextWord(block, after, block.length);
    let split;
    if (term === '.') {
      split = decidePeriod(tokenBefore(block, m.index), next);
    } else if (/^[.…\u00a0 ]+$/.test(term) && term.length > 1 || term.startsWith('…')) {
      // Ellipsis: split only when a new sentence clearly starts.
      split = next.atEnd || (!!next.word && !isLower(next.word) && !isDigit(next.word)) || (!next.word && next.opener);
    } else {
      // ! ? ‽ and mixes: keep going for quote attribution ("Really?" she asked) and parentheticals.
      split = next.atEnd || !(next.word && isLower(next.word) && closers.length > 0);
    }
    if (split) {
      push(text, start + segStart, start + after, out);
      segStart = after;
    }
    if (BOUNDARY.lastIndex === m.index) BOUNDARY.lastIndex++;
  }
  push(text, start + segStart, end, out);
}

function push(text, s, e, out) {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return;
  const t = text.slice(s, e);
  if (!LETTER_OR_DIGIT.test(t.replace(CITATION_RE, ''))) return;
  out.push({ start: s, end: e, text: t });
}

/** Split English text into sentences. Returns [{ start, end, text }] in order, plus paragraph count. */
export function splitSentences(text) {
  const out = [];
  for (const b of hardBlocks(text)) splitBlock(text, b.start, b.end, out);
  return out;
}

/** Number of paragraphs: blank-line separated chunks that contain at least one letter or digit. */
export function countParagraphs(text) {
  return text.split(/\n[ \t\r]*\n/).filter((p) => LETTER_OR_DIGIT.test(p)).length;
}
