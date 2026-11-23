#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm ee:build` and `pnpm ee:typecheck` (ADR-232): ee/backend compiled with the root's
// TypeScript to ee/backend/dist, where the backend looks for it. Without ee/ (the core on its
// own, CI's "core without ee"), both do nothing and succeed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const cmd = process.argv[2];
if (!existsSync('ee/backend/tsconfig.json')) {
  console.log('ee/backend: not here, nothing to do');
  process.exit(0);
}
const args = ['exec', 'tsc', '-p', 'ee/backend/tsconfig.json'];
if (cmd === 'typecheck') args.push('--noEmit');
else if (cmd !== 'build') {
  console.error('usage: ee.mjs build|typecheck');
  process.exit(2);
}
const r = spawnSync('pnpm', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
