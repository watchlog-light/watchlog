// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's response headers (ADR-181). The dashboard's files are served by the web image
// (web/Caddyfile, with WATCHLOG_EDITION=cloud), the API by the backend (helmet, below);
// both send this one policy, and test/headers.test.ts keeps the Caddyfile's copy the same.
// Measured by loading every page in Chrome with the policy on (slice 6b):
//   - no inline or eval'd script: scripts only from the app's own files, and Cloudflare
//     Turnstile's (the sign-up and reset pages), which also needs its frame;
//   - styles from the app's files; inline style *attributes* only, which the charts'
//     tooltips (ECharts) and the unsubscribe page use; never a <style> element;
//   - fonts and images from the app, and data: URIs (the build inlines a small font);
//   - the page can't be framed by anyone.
// HSTS is the TLS proxy's (nginx in Cloud), not set here.
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export const CLOUD_CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", TURNSTILE_ORIGIN],
  'frame-src': [TURNSTILE_ORIGIN],
  'style-src': ["'self'"],
  'style-src-attr': ["'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** The header's value, in the directives' order. */
export const CLOUD_CSP = Object.entries(CLOUD_CSP_DIRECTIVES)
  .map(([k, v]) => `${k} ${v.join(' ')}`)
  .join('; ');

/** @fastify/helmet's options in Cloud; Community keeps helmet's defaults (as 0.5.0). */
export const CLOUD_HELMET = {
  contentSecurityPolicy: { useDefaults: false, directives: CLOUD_CSP_DIRECTIVES },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
  frameguard: { action: 'deny' as const },
  // HSTS comes from nginx in Cloud, for every response of the host.
  strictTransportSecurity: false,
};
