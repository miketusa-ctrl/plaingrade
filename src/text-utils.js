// Small string helpers shared by the splitter and the tokenizer (no regex, so no backtracking).

/**
 * Strip a trailing run of chars from a set with a loop. An end-anchored /[...]+$/ retries from every position of a run
 * that isn't at the end, which is O(n^2) on a 20 KB token like ")))...x".
 */
export function trimEndChars(s, set) { let e = s.length; while (e > 0 && set.has(s[e - 1])) e--; return e === s.length ? s : s.slice(0, e); }
