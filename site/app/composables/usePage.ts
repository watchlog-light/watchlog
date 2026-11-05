// SPDX-License-Identifier: AGPL-3.0-only
import { site, siteMeta } from '../../site.config';

/** Title, description, canonical URL and Open Graph tags for one page. */
export function usePage(p: { title?: string; description: string; path: string }) {
  const title = p.title ? `${p.title} · ${siteMeta.name}` : siteMeta.title;
  const url = `${site.url}${p.path === '/' ? '/' : p.path}`;
  useSeoMeta({
    title,
    description: p.description,
    ogTitle: title,
    ogDescription: p.description,
    ogUrl: url,
  });
  useHead({ link: [{ rel: 'canonical', href: url }] });
}
