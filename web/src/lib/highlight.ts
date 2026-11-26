// SPDX-License-Identifier: AGPL-3.0-only
// What was typed, shown in what was found (the Combobox's options, ADR-239). Pure.

export interface Part {
  text: string;
  hit: boolean;
}

/** The words of a search, lower-cased. */
export const termsOf = (search: string): string[] =>
  search.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * A text cut into the parts that match any term and the parts between them, in order.
 * Overlapping matches are one part; without a term the text is one plain part.
 */
export function highlight(text: string, terms: readonly string[]): Part[] {
  if (!terms.length || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length))
      marks.push([i, i + t.length]);
  }
  if (!marks.length) return [{ text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  const out: Part[] = [];
  let at = 0;
  for (const [from, to] of merged) {
    if (from > at) out.push({ text: text.slice(at, from), hit: false });
    out.push({ text: text.slice(from, to), hit: true });
    at = to;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
