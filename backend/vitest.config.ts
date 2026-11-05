// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one PostgreSQL database; run files one at a time.
    fileParallelism: false,
  },
});
