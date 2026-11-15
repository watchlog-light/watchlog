// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly-worker's own environment (ADR-196, ADR-197). The score (4), the minutes (10)
// and the floors are fixed in 0.8.0; tests and the demo can change them here.
//   WATCHLOG_ANOMALY_WORKER_PORT   /livez and /readyz (default 4082)
//   WATCHLOG_ANOMALY_SCORE         past this score is unusual (default 4)
//   WATCHLOG_ANOMALY_MINUTES       for this many minutes (default 10)
//   WATCHLOG_ANOMALY_FLOORS        JSON, e.g. {"cores":0.1}: floors per unit to replace
//   WATCHLOG_ANOMALY_SPREAD_SECONDS  one minute's clusters spread over this (default 40)
import type { Unit } from '../query/catalog.js';
import { DEFAULT_FLOORS, DEFAULT_RULE, type Rule } from './stats.js';

export interface AnomalySettings {
  port: number;
  rule: Rule;
  spreadMs: number;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, ok: (n: number) => boolean) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

export function loadAnomalySettings(env: NodeJS.ProcessEnv = process.env): AnomalySettings {
  const port = num(
    env,
    'WATCHLOG_ANOMALY_WORKER_PORT',
    4082,
    (n) => Number.isInteger(n) && n > 0 && n < 65536,
  );
  const score = num(env, 'WATCHLOG_ANOMALY_SCORE', DEFAULT_RULE.score, (n) => n > 0);
  const minutes = num(
    env,
    'WATCHLOG_ANOMALY_MINUTES',
    DEFAULT_RULE.minutes,
    (n) => Number.isInteger(n) && n >= 1 && n <= 60,
  );
  const spread = num(env, 'WATCHLOG_ANOMALY_SPREAD_SECONDS', 40, (n) => n >= 0 && n <= 55);
  const floors = { ...DEFAULT_FLOORS };
  const raw = env.WATCHLOG_ANOMALY_FLOORS?.trim();
  if (raw) {
    let given: unknown;
    try {
      given = JSON.parse(raw);
    } catch {
      throw new Error('Invalid WATCHLOG_ANOMALY_FLOORS: not JSON');
    }
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      throw new Error('Invalid WATCHLOG_ANOMALY_FLOORS: expected an object of units');
    }
    for (const [unit, v] of Object.entries(given)) {
      if (!(unit in floors) || typeof v !== 'number' || !(v > 0)) {
        throw new Error(`Invalid WATCHLOG_ANOMALY_FLOORS: ${unit}`);
      }
      floors[unit as Unit] = v;
    }
  }
  return { port, rule: { score, minutes, floors }, spreadMs: spread * 1000 };
}
