// SPDX-License-Identifier: AGPL-3.0-only
// The sign-up page's strength meter (ADR-175). A hint only: the backend decides (at least
// 10 characters, not in a known breach). No dictionary library: length counts most, then
// the mix of character kinds, and a password of few distinct characters stays weak.

/** 0 = too short, 1 = weak, 2 = fair, 3 = good, 4 = strong. */
export type Strength = 0 | 1 | 2 | 3 | 4;
export const STRENGTH_LABELS = ['tooShort', 'weak', 'fair', 'good', 'strong'] as const;

export function passwordStrength(password: string, minLength = 10): Strength {
  if (password.length < minLength) return 0;
  const distinct = new Set(password).size;
  if (distinct < 5) return 1;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  let score = 1;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (kinds >= 3 || (kinds >= 2 && password.length >= 14)) score++;
  return Math.min(score, 4) as Strength;
}
