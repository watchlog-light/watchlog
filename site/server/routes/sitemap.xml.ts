// SPDX-License-Identifier: AGPL-3.0-only
// Prerendered to /sitemap.xml at build time.
import { PAGES, site } from '../../site.config';

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'application/xml; charset=utf-8');
  const urls = PAGES.map((p) => `  <url><loc>${site.url}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
});
