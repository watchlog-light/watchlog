// SPDX-License-Identifier: AGPL-3.0-only
// The docs pages render docs/site/*.md at build time; the legal pages render
// site/content/legal/*.md. Nothing of this reaches the browser as JavaScript.
import { Marked, type Tokens } from 'marked';
import { DOC_PAGES, site } from '../../site.config';

export interface Doc {
  slug: string;
  path: string;
  title: string;
  description: string;
  html: string;
}

const DOCS = import.meta.glob('../../../docs/site/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const LEGAL = import.meta.glob('../../content/legal/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const DOC_ORDER = DOC_PAGES;
const PATHS: Record<string, string> = { security: '/security/' };
export const docPath = (slug: string) => PATHS[slug] ?? `/docs/${slug}/`;

/** Commands and links that only work once the repository and images are public. */
const RELEASE_ONLY =
  /oci:\/\/ghcr\.io\/watchlog-light|raw\.githubusercontent\.com\/watchlog-light|github\.com\/watchlog-light|watchlog\.io\/compose\.yaml/;

const slugOf = (file: string) => file.replace(/^.*\//, '').replace(/\.md$/, '');
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const anchor = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');

function frontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

/**
 * Where a link in a doc goes on the site, or null to render its text only: other docs
 * become site paths; repository links exist only once the repository is public.
 */
export function rewriteHref(href: string, docSlugs: readonly string[]): string | null {
  if (href.startsWith('#') || href.startsWith('mailto:')) return href;
  // Examples such as http://localhost:8080 are text, not links.
  if (/^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(href)) return null;
  if (href === '/pricing' || href.startsWith('/pricing#')) return '/#cloud';
  if (RELEASE_ONLY.test(href)) return site.repoPublic ? href : null;
  if (/^[a-z]+:/i.test(href) || href.startsWith('/')) return href;
  const [file = '', hash] = href.split('#');
  const slug = slugOf(file);
  if (file.endsWith('.md') && !file.includes('/') && docSlugs.includes(slug))
    return docPath(slug) + (hash ? `#${hash}` : '');
  // Any other relative link points into the repository (docs/site/ → repository root).
  const path = new URL(file, 'https://x/docs/site/').pathname;
  return site.repoPublic ? `${site.repoUrl}/blob/main${path}${hash ? `#${hash}` : ''}` : null;
}

const SOON = `<div class="soon" role="note"><strong>Open-source release coming soon.</strong> The install commands appear here when version ${site.version} is released.</div>`;

export function renderMarkdown(body: string, docSlugs: readonly string[]): string {
  const marked = new Marked({
    gfm: true,
    renderer: {
      // Raw HTML in the sources (review comments, TODOs) is never published.
      html: () => '',
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        return `<h${depth} id="${anchor(text)}">${text}</h${depth}>\n`;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const to = rewriteHref(href, docSlugs);
        if (to === null) return text;
        const external = /^https?:/.test(to) && !to.startsWith(site.url);
        return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${text}</a>`;
      },
      code({ text }: Tokens.Code) {
        if (!site.repoPublic && RELEASE_ONLY.test(text)) return SOON;
        return false;
      },
      codespan({ text }: Tokens.Codespan) {
        if (!site.repoPublic && RELEASE_ONLY.test(text))
          return '<em>the release command (coming soon)</em>';
        return false;
      },
    },
  });
  return marked.parse(body, { async: false }) as string;
}

function toDoc(slug: string, raw: string, path: string, vars: Record<string, string> = {}): Doc {
  const { meta, body } = frontmatter(raw);
  const filled = body.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  // The first heading is the page title; the page renders it.
  const content = filled.trimStart().replace(/^# .+\n+/, '');
  const title = meta.title ?? /^# (.+)$/m.exec(body)?.[1] ?? slug;
  return {
    slug,
    path,
    title,
    description: meta.description ?? '',
    html: renderMarkdown(content, Object.keys(DOCS).map(slugOf)),
  };
}

export function getDoc(slug: string): Doc | null {
  const entry = Object.entries(DOCS).find(([f]) => slugOf(f) === slug);
  return entry ? toDoc(slug, entry[1], docPath(slug)) : null;
}

export const listDocs = (): Doc[] =>
  DOC_ORDER.map((s) => getDoc(s)).filter((d): d is Doc => d !== null);

export function getLegal(slug: 'privacy' | 'terms'): Doc {
  const entry = Object.entries(LEGAL).find(([f]) => slugOf(f) === slug);
  if (!entry) throw new Error(`missing legal page ${slug}`);
  return toDoc(slug, entry[1], `/legal/${slug}/`, {
    operator: site.operator,
    contactEmail: site.contactEmail,
    updated: site.legalUpdated,
    version: site.version,
  });
}
