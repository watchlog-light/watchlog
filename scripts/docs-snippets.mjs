#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Fills the code a user copies into the docs from @watchlog/snippets, the same source the Add
// a source page uses (1.0.3): every `<!-- snippet:id -->…<!-- /snippet -->` in docs/site/*.md.
//   pnpm docs:snippets          write
//   pnpm docs:snippets --check  fail when a page is stale (web/test/docs-snippets.test.ts too)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fillDocSnippets } from '../packages/snippets/index.js';

const dir = fileURLToPath(new URL('../docs/site/', import.meta.url));
const check = process.argv.includes('--check');
let stale = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
  const before = readFileSync(dir + name, 'utf8');
  const after = fillDocSnippets(before);
  if (after === before) continue;
  stale++;
  if (check) console.error(`docs/site/${name}: its snippets differ from packages/snippets`);
  else {
    writeFileSync(dir + name, after);
    console.log(`docs/site/${name}: snippets written`);
  }
}
if (check && stale) process.exit(1);
