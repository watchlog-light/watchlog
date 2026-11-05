// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';

// docs.ts reads the flag when it loads, so each mode gets a fresh import.
async function load(repoPublic: boolean) {
  vi.resetModules();
  vi.stubEnv('WATCHLOG_SITE_REPO_PUBLIC', String(repoPublic));
  return import('../app/utils/docs');
}
afterEach(() => vi.unstubAllEnvs());

const PRIVATE =
  /github\.com\/watchlog-light|raw\.githubusercontent\.com|oci:\/\/ghcr\.io\/watchlog-light/;

describe('docs while the repository is private', () => {
  it('renders every doc page without repository links or install commands', async () => {
    const docs = await load(false);
    const pages = [...docs.listDocs(), docs.getDoc('security')!];
    expect(pages.map((d) => d.path)).toEqual([
      '/docs/install/',
      '/docs/configuration/',
      '/docs/faq/',
      '/security/',
    ]);
    for (const d of pages) expect(d.html, d.slug).not.toMatch(PRIVATE);
    expect(docs.getDoc('install')!.html).toContain('Open-source release coming soon');
  });

  it('turns doc links into site paths and keeps their anchors', async () => {
    const { rewriteHref } = await load(false);
    const slugs = ['install', 'security'];
    expect(rewriteHref('install.md#upgrade', slugs)).toBe('/docs/install/#upgrade');
    expect(rewriteHref('security.md', slugs)).toBe('/security/');
    expect(rewriteHref('/pricing', slugs)).toBe('/#cloud');
    expect(rewriteHref('../security.md', slugs)).toBeNull();
    expect(
      rewriteHref('https://github.com/watchlog-light/watchlog/blob/main/SECURITY.md', slugs),
    ).toBeNull();
    expect(rewriteHref('http://localhost:8080', slugs)).toBeNull();
    expect(rewriteHref('https://www.gnu.org/licenses/agpl-3.0.html', slugs)).toBe(
      'https://www.gnu.org/licenses/agpl-3.0.html',
    );
  });

  it('never publishes raw HTML from the sources (review comments, TODOs)', async () => {
    const { renderMarkdown } = await load(false);
    expect(renderMarkdown('a\n\n<!-- TODO: decide -->\n\nb', [])).not.toContain('TODO');
  });

  it('fills the legal pages from the config', async () => {
    const docs = await load(false);
    const privacy = docs.getLegal('privacy');
    expect(privacy.html).not.toMatch(/\{\{\w+\}\}/);
    expect(privacy.html).toContain('mailto:hello@watchlog.io');
  });
});

describe('docs once the repository is public', () => {
  it('restores install commands and repository links', async () => {
    const docs = await load(true);
    expect(docs.getDoc('install')!.html).toContain('oci://ghcr.io/watchlog-light/charts/watchlog');
    expect(docs.getDoc('security')!.html).toContain(
      'href="https://github.com/watchlog-light/watchlog/blob/main/SECURITY.md"',
    );
    expect(docs.rewriteHref('../security.md', [])).toBe(
      'https://github.com/watchlog-light/watchlog/blob/main/docs/security.md',
    );
  });
});
