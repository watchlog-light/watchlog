// SPDX-License-Identifier: AGPL-3.0-only
// What changed (0.8.0), slice 1: the cost of 14 days of baselines, measured on synthetic series
// (ADR-196, ADR-197, ADR-198). Nothing here is product code.
//
//   npx tsx scripts/anomaly-baseline-bench.ts                      # compute only
//   PG_URL=postgres://u:p@127.0.0.1:55422/db npx tsx scripts/anomaly-baseline-bench.ts
//   VM_URL=http://127.0.0.1:18422 npx tsx scripts/anomaly-baseline-bench.ts
//
// SERIES (default 2,000) series get 14 days of minute values ending at NOW (an injectable
// clock, default 2026-11-16T00:00Z): a daily and weekly shape, noise, and one incident hour.
// It times the 168 buckets' median and MAD (the full recompute) and one bucket (the hourly
// recompute), then, when given, writes PG_ROWS (default 20,000) baseline rows in PostgreSQL
// (two real[168] and a smallint[168] a row) and times the hourly update of one element per
// row, and writes the same baselines to VictoriaMetrics as two series each, hourly samples.
import pg from 'pg';

const SERIES = Number(process.env.SERIES ?? 2000);
const PG_ROWS = Number(process.env.PG_ROWS ?? 20000);
const VM_SERIES = Number(process.env.VM_SERIES ?? 20000);
const NOW = Date.parse(process.env.NOW ?? '2026-11-16T00:00:00Z');
const DAYS = 14;
const MIN = 60_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** 14 days of minute values for one series, oldest first. */
function synth(i: number): Float64Array {
  const r = rng(i + 1);
  const n = DAYS * 1440;
  const out = new Float64Array(n);
  const base = 0.05 + r() * 2;
  const incident = Math.floor(r() * n);
  const start = NOW - n * MIN;
  for (let m = 0; m < n; m++) {
    const d = new Date(start + m * MIN);
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.6 : 1;
    const shape = 1 + 0.5 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
    let v = base * shape * weekend * (1 + (r() - 0.5) * 0.2);
    if (m >= incident && m < incident + 60) v *= 5;
    out[m] = v;
  }
  return out;
}

function median(a: Float64Array): number {
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function bucketStats(vals: Float64Array): [number, number] {
  const med = median(vals);
  const dev = new Float64Array(vals.length);
  for (let i = 0; i < vals.length; i++) dev[i] = Math.abs(vals[i]! - med);
  return [med, median(dev)];
}

/** The 168 hour-of-week buckets (UTC) of a series ending at NOW. */
function full(series: Float64Array) {
  const start = NOW - series.length * MIN;
  const buckets: number[][] = Array.from({ length: 168 }, () => []);
  for (let m = 0; m < series.length; m++) {
    const d = new Date(start + m * MIN);
    buckets[d.getUTCDay() * 24 + d.getUTCHours()]!.push(series[m]!);
  }
  return buckets.map((b) => bucketStats(Float64Array.from(b)));
}

function stat(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const med = s[s.length >> 1]!;
  const mad = [...s.map((x) => Math.abs(x - med))].sort((a, b) => a - b)[s.length >> 1]!;
  return { median: +med.toFixed(4), mad: +mad.toFixed(4) };
}

function compute() {
  const t0 = performance.now();
  const data = Array.from({ length: SERIES }, (_, i) => synth(i));
  const genMs = performance.now() - t0;
  const fullMs: number[] = [];
  const hourMs: number[] = [];
  const scoreMs: number[] = [];
  for (const s of data) {
    let t = performance.now();
    const b = full(s);
    fullMs.push(performance.now() - t);
    // The hourly recompute: the bucket that just ended, two occurrences of 60 minutes.
    t = performance.now();
    const two = new Float64Array(120);
    two.set(s.subarray(s.length - 60), 0);
    two.set(s.subarray(s.length - 7 * 1440 - 60, s.length - 7 * 1440), 60);
    bucketStats(two);
    hourMs.push(performance.now() - t);
    // The minute's scoring of the last 11 minutes against the bucket.
    t = performance.now();
    const [med, mad] = b[0]!;
    let run = 0;
    for (let m = s.length - 11; m < s.length; m++) {
      const sc = Math.abs(s[m]! - med) / Math.max(1.4826 * mad, 0.05 * Math.abs(med), 1e-3);
      run = sc > 4 ? run + 1 : 0;
    }
    scoreMs.push(performance.now() - t);
  }
  return {
    series: SERIES,
    generateMs: Math.round(genMs),
    fullRecomputeMsPerSeries: stat(fullMs),
    hourlyRecomputeMsPerSeries: stat(hourMs),
    scoreMsPerSeries: stat(scoreMs),
    rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
  };
}

async function postgres(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS bench_anomaly_baselines');
  await c.query(`CREATE TABLE bench_anomaly_baselines (
    org_id uuid NOT NULL, cluster_id uuid NOT NULL, metric text NOT NULL, subject jsonb NOT NULL,
    series_hash bytea NOT NULL, medians real[] NOT NULL, spreads real[] NOT NULL,
    minutes smallint[] NOT NULL, first_seen timestamptz NOT NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, cluster_id, series_hash))`);
  const org = '01a1c446-0000-7000-8000-000000000001';
  const r = rng(7);
  const t0 = performance.now();
  // Random medians and spreads, generated in the database (ARRAY(...) is evaluated per row).
  const rnd = (scale: number) =>
    `ARRAY(SELECT (random() * ${scale})::real FROM generate_series(1, 168) WHERE i > 0)`;
  await c.query(
    `INSERT INTO bench_anomaly_baselines
     SELECT $1::uuid, ('01a1c446-0000-7000-8000-' || lpad((i % 250)::text, 12, '0'))::uuid,
            'workload.cpu.usage', jsonb_build_object('namespace', 'shop-' || (i % 9),
              'workloadKind', 'Deployment', 'workload', 'checkout-api-' || i),
            sha256(i::text::bytea), ${rnd(2)}, ${rnd(0.1)},
            ARRAY(SELECT 120::smallint FROM generate_series(1, 168) WHERE i > 0),
            now() - interval '14 days', now()
     FROM generate_series(1, $2::int) AS i`,
    [org, PG_ROWS],
  );
  const insertMs = performance.now() - t0;
  await c.query('VACUUM ANALYZE bench_anomaly_baselines');
  const size = async () =>
    (
      await c.query(
        `SELECT pg_total_relation_size('bench_anomaly_baselines')::bigint AS total,
                pg_relation_size('bench_anomaly_baselines')::bigint AS heap,
                pg_indexes_size('bench_anomaly_baselines')::bigint AS idx,
                (SELECT avg(pg_column_size(t.*)) FROM bench_anomaly_baselines t)::int AS row`,
      )
    ).rows[0] as { total: string; heap: string; idx: string; row: number };
  const before = await size();
  // The hourly recompute: one element of each array, for every row, 1,000 rows a statement.
  const lsn0 = (await c.query('SELECT pg_current_wal_lsn() AS l')).rows[0].l as string;
  const h = 37;
  const keys = (await c.query('SELECT series_hash FROM bench_anomaly_baselines')).rows.map(
    (x) => x.series_hash as Buffer,
  );
  const t1 = performance.now();
  for (let off = 0; off < keys.length; off += 1000) {
    const part = keys.slice(off, off + 1000);
    await c.query(
      `UPDATE bench_anomaly_baselines b SET medians[${h + 1}] = u.m, spreads[${h + 1}] = u.s,
         minutes[${h + 1}] = 120, updated_at = now()
       FROM unnest($1::bytea[], $2::real[], $3::real[]) AS u(k, m, s)
       WHERE b.org_id = $4 AND b.series_hash = u.k`,
      [part, part.map(() => r() * 2), part.map(() => r() * 0.1), org],
    );
  }
  const updateMs = performance.now() - t1;
  const lsn1 = (await c.query('SELECT pg_current_wal_lsn() AS l')).rows[0].l as string;
  const wal = (await c.query('SELECT pg_wal_lsn_diff($1, $2)::bigint AS d', [lsn1, lsn0])).rows[0]
    .d as string;
  const afterUpdate = await size();
  // Reading one cluster's baselines for the minute's scoring (the current bucket only).
  const t2 = performance.now();
  await c.query(
    `SELECT series_hash, medians[${h + 1}], spreads[${h + 1}] FROM bench_anomaly_baselines
     WHERE org_id = $1 AND cluster_id = '01a1c446-0000-7000-8000-000000000007'`,
    [org],
  );
  const readMs = performance.now() - t2;
  await c.query('DROP TABLE bench_anomaly_baselines');
  await c.end();
  return {
    rows: PG_ROWS,
    insertMs: Math.round(insertMs),
    bytesPerRow: Math.round(Number(before.total) / PG_ROWS),
    rowBytes: before.row,
    heapMiB: +(Number(before.heap) / 2 ** 20).toFixed(1),
    indexMiB: +(Number(before.idx) / 2 ** 20).toFixed(1),
    hourlyUpdateMs: Math.round(updateMs),
    hourlyUpdateWalBytesPerRow: Math.round(Number(wal) / PG_ROWS),
    totalMiBAfterOneUpdate: +(Number(afterUpdate.total) / 2 ** 20).toFixed(1),
    readOneClusterBucketMs: +readMs.toFixed(1),
  };
}

async function victoria(url: string) {
  const metrics = async () => {
    const t = await (await fetch(`${url}/metrics`)).text();
    const get = (name: string) =>
      t
        .split('\n')
        .filter((l) => l.startsWith(name))
        .reduce((a, l) => a + Number(l.split(' ').pop()), 0);
    return {
      dataBytes: get('vm_data_size_bytes'),
      rss: get('process_resident_memory_bytes'),
    };
  };
  const m0 = await metrics();
  const hours = DAYS * 24;
  const t0 = performance.now();
  // Two series per catalog series (median, spread), one sample an hour for 14 days.
  for (let off = 0; off < VM_SERIES; off += 500) {
    const lines: string[] = [];
    for (let i = off; i < Math.min(VM_SERIES, off + 500); i++) {
      const labels = `cluster_id="01a1c446-0000-7000-8000-${String(i % 250).padStart(12, '0')}",metric="workload.cpu.usage",namespace="shop-${i % 9}",workload_kind="Deployment",workload="checkout-api-${i}"`;
      for (let h = 0; h < hours; h++) {
        const ts = NOW - (hours - h) * 3_600_000;
        lines.push(`watchlog_baseline_median{${labels}} ${(1 + (h % 24) / 24).toFixed(3)} ${ts}`);
        lines.push(
          `watchlog_baseline_spread{${labels}} ${(0.05 + (h % 7) / 100).toFixed(3)} ${ts}`,
        );
      }
    }
    const r = await fetch(`${url}/api/v1/import/prometheus`, {
      method: 'POST',
      body: lines.join('\n'),
    });
    if (!r.ok) throw new Error(`import ${r.status}`);
  }
  const importMs = performance.now() - t0;
  await fetch(`${url}/internal/force_flush`);
  await new Promise((res) => setTimeout(res, 3000));
  const m1 = await metrics();
  return {
    series: VM_SERIES * 2,
    samples: VM_SERIES * 2 * hours,
    importMs: Math.round(importMs),
    dataBytesPerSeries: Math.round((m1.dataBytes - m0.dataBytes) / (VM_SERIES * 2)),
    rssMiBDelta: Math.round((m1.rss - m0.rss) / 2 ** 20),
  };
}

const out: Record<string, unknown> = { now: new Date(NOW).toISOString(), compute: compute() };
if (process.env.PG_URL) out.postgres = await postgres(process.env.PG_URL);
if (process.env.VM_URL) out.victoriametrics = await victoria(process.env.VM_URL);
console.log(JSON.stringify(out, null, 2));
