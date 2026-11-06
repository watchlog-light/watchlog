// SPDX-License-Identifier: AGPL-3.0-only
// Responsive layout checks and screenshots (e2e/responsive.spec.ts) against a running
// dashboard with data: `pnpm dev` and a cluster reporting to it (deploy/test/demo-up.sh).
// Uses the installed Google Chrome; no browser download.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 10 * 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.WATCHLOG_E2E_URL ?? 'http://localhost:4088',
    channel: 'chrome',
    colorScheme: 'dark',
    actionTimeout: 5_000,
  },
});
