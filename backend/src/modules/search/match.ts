// SPDX-License-Identifier: AGPL-3.0-only
// How the ⌘K palette's search matches a name (ADR-169), as LIKE patterns PostgreSQL runs:
// - the query is lower-cased and split on spaces into at most 4 words; a space also stands
//   for `-` when the whole query is compared, so "payments api" finds `payments-api-…`;
// - a word matches when its letters appear in order in `namespace/name` (`pay7d9` finds
//   `payments-api-7d9f…`), or, for words of 4 to 32 letters, when they do with any one
//   letter left out: one typo (a wrong, extra or swapped letter);
// - tiers order the matches: the exact name, then names starting with the query, then
//   names containing it, then the namespace or host and name containing it, then letters
//   in order in the name, then in the namespace and name, then one typo. Shorter names
//   first within a tier.

/** At most this many words, each at most this long, are matched. */
export const MAX_WORDS = 4;
export const MAX_WORD = 64;
/** Words this long or longer may have one typo; shorter ones would match nearly anything. */
export const TYPO_MIN = 4;
export const TYPO_MAX = 32;

export const TIERS = ['exact', 'prefix', 'substring', 'path', 'letters', 'typo'] as const;
export type Tier = (typeof TIERS)[number];

/** Escapes LIKE's wildcards (the default escape character is the backslash). */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The query, lower-cased and trimmed, with runs of spaces as one. */
export const normalize = (q: string) => q.toLowerCase().trim().replace(/\s+/g, ' ');

/** The words to match, at most MAX_WORDS of at most MAX_WORD characters. */
export const words = (q: string) =>
  normalize(q)
    .split(' ')
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD));

/** `%p%a%y%`: the letters in order, anything between. */
export const lettersPattern = (word: string) => `%${[...word].map(likeEscape).join('%')}%`;

/** The letters-in-order patterns with one letter left out, for one typo (deduplicated). */
export function typoPatterns(word: string): string[] {
  const chars = [...word];
  if (chars.length < TYPO_MIN || chars.length > TYPO_MAX) return [];
  const out = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    out.add(lettersPattern([...chars.slice(0, i), ...chars.slice(i + 1)].join('')));
  }
  return [...out];
}

/** Everything the SQL needs for one query. */
export interface SearchPatterns {
  /** The whole query with spaces as `-`, escaped: for the exact, prefix and substring tiers. */
  whole: string;
  /** Per word: its letters-in-order pattern and its one-typo patterns. */
  words: { letters: string; typos: string[] }[];
}

export function patterns(q: string): SearchPatterns | null {
  const ws = words(q);
  if (!ws.length) return null;
  return {
    whole: likeEscape(ws.join('-')),
    words: ws.map((w) => ({ letters: lettersPattern(w), typos: typoPatterns(w) })),
  };
}
