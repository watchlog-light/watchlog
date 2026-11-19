// SPDX-License-Identifier: AGPL-3.0-only
// Setting a password (ADR-175, amended in 0.9.9): the two rules the server has, checked as
// the user types. No composition rules ("one symbol, one capital"): length
// and not being a known leaked password are what count.
//   - Long enough: the server's minimum (10).
//   - Not leaked: the password is hashed here (SHA-1, as Have I Been Pwned keys its list),
//     the first 5 of the hash's 40 characters go to the server, and the answer is searched
//     for the other 35 here. The password never leaves the browser. The server checks again
//     when the form is sent: it is the authority, this is the early word.
/** What the live leaked-password check knows about what is typed. */
export type LeakState = 'idle' | 'checking' | 'ok' | 'leaked' | 'unavailable';

/** The password's SHA-1 as 40 upper-case hex characters; null where the browser can't hash. */
export async function sha1Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Whether a range ("<35 hex>:<count>" lines; count 0 is padding) lists this hash ending. */
export function inRange(range: string, suffix: string): boolean {
  for (const line of range.split('\n')) {
    const [s, count] = line.trim().split(':');
    if (s === suffix && Number(count) > 0) return true;
  }
  return false;
}

/** Ranges already fetched in this page, by prefix: typing on rarely needs a second call. */
const ranges = new Map<string, string>();

/**
 * Whether the password is in the leaked list: 'leaked', 'ok', or 'unavailable' when the
 * browser can't hash or the list can't be reached (the server then decides). `fetchRange`
 * gets the range for a 5-character prefix and throws when it can't.
 */
export async function leakCheck(
  password: string,
  fetchRange: (prefix: string) => Promise<string>,
): Promise<'ok' | 'leaked' | 'unavailable'> {
  try {
    const hash = await sha1Hex(password);
    if (!hash) return 'unavailable';
    const prefix = hash.slice(0, 5);
    let range = ranges.get(prefix);
    if (range === undefined) {
      range = await fetchRange(prefix);
      if (ranges.size > 200) ranges.clear();
      ranges.set(prefix, range);
    }
    return inRange(range, hash.slice(5)) ? 'leaked' : 'ok';
  } catch {
    return 'unavailable';
  }
}

/** For tests: forget the ranges fetched so far. */
export function forgetRanges(): void {
  ranges.clear();
}
