// SPDX-License-Identifier: AGPL-3.0-only
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // Next to the backend's 4080, away from Vite's default (other projects use it); a taken
    // port fails loudly instead of moving.
    port: Number(process.env.WATCHLOG_WEB_PORT ?? 4088),
    strictPort: true,
    proxy: {
      '/api': { target: process.env.WATCHLOG_API_URL ?? 'http://127.0.0.1:4080' },
      // MCP clients may use the dashboard origin, as the token reveal's snippets do.
      '/mcp': { target: process.env.WATCHLOG_API_URL ?? 'http://127.0.0.1:4080' },
      // Agents may use the dashboard origin as WATCHLOG_ENDPOINT in development.
      '/ingest': { target: process.env.WATCHLOG_API_URL ?? 'http://127.0.0.1:4080' },
    },
  },
  test: {
    environment: 'happy-dom',
    // e2e/ is Playwright's (pnpm test:responsive).
    include: ['test/**/*.test.ts'],
    // Fails a test that renders an i18n key en.json doesn't have.
    setupFiles: ['test/setup.ts'],
  },
});
