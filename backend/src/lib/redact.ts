// SPDX-License-Identifier: AGPL-3.0-only
// Credentials inside URLs that the API shows (proxy and webhook addresses).

/** Replaces a redacted credential. URL-safe in userinfo and query strings. */
export const URL_SECRET_MASK = '****';

const SECRET_PARAM = /token|secret|passw|pwd|key|sig|auth|credential/i;

/**
 * The URL with the password of its userinfo and the values of secret-looking query
 * parameters (token, key, secret, signature…) masked. Anything that is not a URL comes
 * back as is.
 */
export function redactUrl(value: string): string {
  if (!URL.canParse(value)) return value;
  const u = new URL(value);
  let changed = false;
  if (u.password) {
    u.password = URL_SECRET_MASK;
    changed = true;
  }
  for (const [k, v] of [...u.searchParams]) {
    if (v && SECRET_PARAM.test(k)) {
      u.searchParams.set(k, URL_SECRET_MASK);
      changed = true;
    }
  }
  return changed ? u.toString() : value;
}

/**
 * A URL edited from a redacted one: where it still holds the mask, the stored URL's
 * password comes back, provided the user and host are unchanged.
 */
export function restoreUrlPassword(edited: string, stored: string | undefined): string {
  if (!stored || !URL.canParse(edited) || !URL.canParse(stored)) return edited;
  const e = new URL(edited);
  const s = new URL(stored);
  if (e.password !== URL_SECRET_MASK || e.username !== s.username || e.host !== s.host) {
    return edited;
  }
  e.password = s.password;
  return e.toString();
}
