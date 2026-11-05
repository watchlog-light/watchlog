// SPDX-License-Identifier: AGPL-3.0-only
// Checks the generated site (.output/public) as plain files: every page exists, every
// internal link resolves, nothing loads from another origin, the only script is
// /js/site.js, there are no inline styles (CSP), and while the repository is private
// nothing links to it or shows an install command.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, site, WAITLIST_PAGES } from '../site.config.ts';

const out = fileURLToPath(new URL('../.output/public', import.meta.url));
const errors = [];
const fail = (msg) => errors.push(msg);

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(out);
const rel = (p) => p.slice(out.length);

// A URL path served as nginx would: the file, <path>/index.html or <path>.html.
const resolve = (path) => {
  const clean = decodeURIComponent(path.split('#')[0].split('?')[0]);
  for (const c of [clean, `${clean.replace(/\/$/, '')}/index.html`, `${clean}.html`]) {
    const p = join(out, c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
};

for (const page of [
  ...PAGES,
  ...WAITLIST_PAGES.map((p) => `/waitlist/${p}/`),
  '/404.html',
  '/sitemap.xml',
  '/robots.txt',
  '/js/site.js',
]) {
  if (!resolve(page)) fail(`missing page ${page}`);
}
if (existsSync(join(out, '200.html'))) fail('200.html (SPA fallback) is still there');

const PRIVATE =
  /github\.com\/watchlog-light|raw\.githubusercontent\.com\/watchlog-light|oci:\/\/ghcr\.io\/watchlog-light|watchlog\.io\/compose\.yaml/;
for (const file of files.filter((f) => /\.(html|xml|txt|js|json|css)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  if (!site.repoPublic && PRIVATE.test(text))
    fail(`${rel(file)} links to the private repository or shows an install command`);
  if (/url\(\s*['"]?data:/.test(text)) fail(`${rel(file)}: data: URL (blocked by the CSP)`);
  if (!file.endsWith('.html')) continue;
  for (const [, tag, attrs] of text.matchAll(/<(script|link|img|iframe|source)\b([^>]*)>/g)) {
    const url = /\b(?:src|href)="([^"]+)"/.exec(attrs)?.[1];
    if (tag === 'script') {
      // JSON-LD and speculation rules are data; the CSP allows the latter by keyword.
      if (!/type="(application\/ld\+json|speculationrules)"/.test(attrs) && url !== '/js/site.js')
        fail(`${rel(file)}: unexpected script ${url ?? '(inline)'}`);
      continue;
    }
    if (tag === 'link' && /rel="canonical"/.test(attrs)) continue;
    if (url && /^(https?:)?\/\//.test(url)) fail(`${rel(file)}: third-party ${tag} ${url}`);
  }
  if (/\sstyle="/.test(text)) fail(`${rel(file)}: inline style attribute (blocked by the CSP)`);
  if (/<style[\s>]/.test(text)) fail(`${rel(file)}: inline <style> (blocked by the CSP)`);
  for (const [, href] of text.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    if (href.startsWith('/') && !href.startsWith('//') && !resolve(href))
      fail(`${rel(file)}: broken link ${href}`);
  }
}
if (!site.repoPublic && existsSync(join(out, 'compose.yaml')))
  fail('compose.yaml is published before the release');

if (errors.length) {
  console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
  process.exit(1);
}
console.log(
  `site output: ok (${PAGES.length} pages, ${files.length} files, repoPublic=${site.repoPublic})`,
);
