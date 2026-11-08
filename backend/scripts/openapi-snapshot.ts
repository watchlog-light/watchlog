// SPDX-License-Identifier: AGPL-3.0-only
// Updates the committed snapshot of the public API (ADR-126),
// packages/api-types/openapi.public.json. Additions are written at once. A breaking change
// is refused unless `--breaking` is given: it needs /api/v2 or a deprecation that lasted
// two minor versions, and a note in the release.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { breakingChanges } from '../src/openapi/compat.js';
import { publicSpec, SNAPSHOT_PATH, snapshotOf } from '../src/openapi/public.js';
import { appSpec } from './app-spec.js';

const file = new URL(`../${SNAPSHOT_PATH}`, import.meta.url);
const next = snapshotOf(publicSpec(await appSpec()));
const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { paths: {} };
const breaking = breakingChanges(old, next);
if (breaking.length && !process.argv.includes('--breaking')) {
  console.error(
    'Breaking changes to the public API (ADR-126):\n' +
      breaking.map((b) => `  - ${b}`).join('\n') +
      '\nThey need /api/v2 or a deprecation that lasted two minor versions. ' +
      'If that is the case, run again with --breaking.',
  );
  process.exit(1);
}
// Formatted as the repository's format check expects.
const path = fileURLToPath(file);
const options = { ...(await resolveConfig(path)), filepath: path };
writeFileSync(file, await format(JSON.stringify(next), options));
console.log(`wrote ${file.pathname}${breaking.length ? ` (${breaking.length} breaking)` : ''}`);
