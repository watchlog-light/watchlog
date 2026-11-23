// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backend's tests, and ee/backend's when ee/ is there (ADR-232).
    include: ['test/**/*.test.ts', '../ee/backend/test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one PostgreSQL database; run files one at a time.
    fileParallelism: false,
  },
});
