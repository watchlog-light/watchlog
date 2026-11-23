// SPDX-License-Identifier: AGPL-3.0-only
// When a licensed install's Pro features stopped taking on new places (ADR-232): after 30
// days in a row over the licence's units. Read by the anomaly-worker each minute, cached.
import type { Database } from '../../db/index.js';
import type { LicenseReader } from './service.js';
import { countUnits } from './units.js';

const CACHE_MS = 10 * 60_000;
let cache: { at: number; value: number | null } | null = null;

export async function closedSince(
  license: LicenseReader,
  db: Database,
  nowMs = Date.now(),
): Promise<number | null> {
  if (cache && nowMs - cache.at < CACHE_MS) return cache.value;
  const p = (await license.current()).check?.payload;
  const value = p
    ? countUnits(db, nowMs, p.units).then((u) =>
        u.closedSince ? Date.parse(`${u.closedSince}T00:00:00Z`) : null,
      )
    : Promise.resolve(null);
  cache = { at: nowMs, value: await value };
  return cache.value;
}
