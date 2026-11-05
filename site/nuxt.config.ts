// SPDX-License-Identifier: AGPL-3.0-only
// Static marketing site (SPEC §9): every page is prerendered to plain HTML, no Nuxt
// runtime ships to the browser, and one small script (public/js/site.js) only makes
// the copy button work. Build: pnpm --filter @watchlog/site generate.
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { site, siteMeta, WAITLIST_PAGES } from './site.config';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineNuxtConfig({
  compatibilityDate: '2026-10-31',
  devtools: { enabled: false },
  telemetry: false,
  css: [
    '@fontsource-variable/inter',
    '@fontsource-variable/jetbrains-mono',
    '~/assets/css/main.css',
  ],
  features: {
    // Plain HTML: no hydration bundle, no payloads (the pages have nothing to hydrate).
    noScripts: true,
    // Styles in hashed files, not inline, so the CSP needs no 'unsafe-inline'.
    inlineStyles: false,
  },
  // No client app: no payload files and no build manifest to fetch.
  experimental: { payloadExtraction: false, appManifest: false },
  hooks: {
    // Pages load their own images; nothing is prefetched for other pages.
    'build:manifest': (manifest) => {
      for (const entry of Object.values(manifest)) {
        entry.prefetch = false;
        entry.preload = false;
      }
    },
  },
  vite: {
    plugins: [tailwindcss()],
    // Every asset as its own file: the CSP allows no data: URLs (fonts included).
    build: { assetsInlineLimit: 0 },
    // docs/site/*.md are read at build time.
    server: { fs: { allow: [repoRoot] } },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: siteMeta.title,
      meta: [
        { name: 'description', content: siteMeta.description },
        { name: 'color-scheme', content: 'dark' },
        // Browser chrome needs a literal colour: --bg in tokens.css.
        { name: 'theme-color', content: '#0e0f11' },
        { property: 'og:site_name', content: siteMeta.name },
        { property: 'og:type', content: 'website' },
        { property: 'og:image', content: `${site.url}/og.png` },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { name: 'twitter:card', content: 'summary_large_image' },
      ],
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicon-96x96.png', sizes: '96x96' },
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'shortcut icon', href: '/favicon.ico' },
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
      ],
      script: [{ src: '/js/site.js', defer: true }],
    },
  },
  nitro: {
    prerender: {
      crawlLinks: true,
      failOnError: true,
      routes: [
        '/',
        '/docs',
        '/security',
        '/legal/privacy',
        '/legal/terms',
        '/not-found',
        '/sitemap.xml',
        ...WAITLIST_PAGES.map((p) => `/waitlist/${p}/`),
      ],
    },
  },
});
