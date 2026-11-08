// SPDX-License-Identifier: AGPL-3.0-only
// Writes the full OpenAPI document (every route, for the dashboard's types) to
// packages/api-types/openapi.json. The public spec's snapshot has its own command,
// `pnpm openapi:snapshot` (ADR-126).
import { writeFileSync } from 'node:fs';
import { appSpec } from './app-spec.js';

const out = new URL('../../packages/api-types/openapi.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(await appSpec(), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
