// SPDX-License-Identifier: AGPL-3.0-only
// What changed (0.8.0) end to end, Kubernetes and Docker (ADR-124, ADR-195 to ADR-204), with
// no wait for the wall clock: 15 days of history are generated from a stored past range of
// real agent data, the anomaly-worker's own jobs learn and score it on an injectable clock at
// full speed, and the running backends answer the checks over HTTP.
//
//   seed:  SRC_VM_URL=… SRC_KUBE=<id> SRC_DOCKER=<id> SRC_FROM=<ISO> SRC_TO=<ISO> \
//          VM_URL=… DATABASE_SYSTEM_URL=… DATABASE_URL=… STATE=<file> \
//          npx tsx scripts/what-changed-e2e.ts seed
//     SRC_*: a past range (10–60 min) of a real cluster's and a real fleet's series, read
//     from the e2e stack's VictoriaMetrics (read only). VM_URL and the two database URLs are
//     an empty Cloud stack's (WATCHLOG_EDITION=cloud, migrated): a Pro org and a Free org
//     are made, each with a cluster and a fleet, and the Pro org's two get 15 days up to now:
//       - the real range, every minute, tiled (counters carried on, so rates are the range's);
//       - the demo kit's showcase drift (ADR-203 as built, slice 7b): search-client → search,
//         p95 10 ms, 800 ms from 03:50 UTC, 1 s from 04:00, back at 04:10; also 11:50, 19:50;
//       - a chaos: report-worker at 0.5 cores (usual 0.02) 14:00–14:40 UTC every day, under
//         a firing alert each time, so its minutes are left out of the baselines (ADR-196).
//     Then the worker's jobs (src/modules/anomaly/jobs.ts) as the worker runs them: the
//     look-back's 168 buckets up to 24 hours ago, then every minute of the last 24 hours with
//     the hourly recompute at :05. STATE (mode 0600) gets the ids and the sessions' tokens.
//   check: WATCHLOG_URL=<the Cloud backend> COMMUNITY_URL=<a Community backend>
//          COMMUNITY_EMAIL=… COMMUNITY_PASSWORD=… DATABASE_SYSTEM_URL=… STATE=<file> \
//          npx tsx scripts/what-changed-e2e.ts check
//     GET /api/v1/what-changed for the cluster and the fleet over the last 24 hours (the
//     drifts listed, edge and workload/container p95, the chaos listed with its usual range
//     learned without it, nothing else; not learning), around the chaos alert (the alert
//     card), Free 403 `pro-feature`, Community 404, the Free org's baselines empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { createDb } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import { createSession } from '../src/modules/auth/sessions.js';
import {
  runAnomalyHour,
  runAnomalyLookBack,
  runAnomalyMinute,
  syncOrgs,
  type AnomalyDeps,
  type LookBackState,
} from '../src/modules/anomaly/jobs.js';
import { BUCKETS } from '../src/modules/anomaly/stats.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAYS = 15;
const env = (k: string) => process.env[k] ?? (console.error(`${k} is required`), process.exit(2));

// The keys' metrics (src/modules/anomaly/keys.ts and the catalog): nothing else is copied.
const METRICS = [
  'node_cpu_seconds_total',
  'node_memory_bytes',
  'node_network_bytes_total',
  'node_disk_io_bytes_total',
  'container_cpu_seconds_total',
  'container_memory_working_set_bytes',
  'container_network_bytes_total',
  'http_requests_total',
  'http_request_duration_seconds_bucket',
  'flow_connections_total',
].map((m) => `watchlog_${m}`);
const COUNTER = /_(total|bucket|count|sum)$/;
const LE = ['0.0005', '0.001', '0.0025', '0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5'];
const LE_ALL = [...LE, '1', '2.5', '5', '10', '+Inf'];

type Labels = Record<string, string>;
interface Series {
  metric: Labels;
  values: number[];
  timestamps: number[];
}

/** The showcase's p95 at time t (ms): the demo kit's search CGI (manifests/drift.yaml). */
function searchDelay(t: number): number {
  const inDay = t % DAY;
  for (const h of [3, 11, 19]) {
    const s = h * HOUR + 50 * MIN;
    if (inDay >= s && inDay < s + 10 * MIN) return 0.8;
    if (inDay >= s + 10 * MIN && inDay < s + 20 * MIN) return 1;
  }
  return 0.01;
}
/** The chaos: report-worker's cores at t. */
const chaosOn = (t: number) => t % DAY >= 14 * HOUR && t % DAY < 14 * HOUR + 40 * MIN;
const reportCores = (t: number) => (chaosOn(t) ? 0.5 : 0.02);

async function exportRange(vm: string, match: string, from: number, to: number) {
  const q = new URLSearchParams({
    'match[]': match,
    start: String(from / 1000),
    end: String(to / 1000),
  });
  const res = await fetch(`${vm}/api/v1/export?${q}`);
  if (!res.ok) throw new Error(`export: ${res.status} ${await res.text()}`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Series);
}

async function importLines(vm: string, lines: string[]) {
  for (let i = 0; i < lines.length; i += 200) {
    const res = await fetch(`${vm}/api/v1/import`, {
      method: 'POST',
      body: lines.slice(i, i + 200).join('\n'),
    });
    if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  }
}

/** One minute value per template minute: the last sample at or before it. */
function perMinute(s: Series, from: number, minutes: number): number[] | null {
  const out: number[] = [];
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < minutes; i++) {
    const at = from + (i + 1) * MIN;
    while (j < s.timestamps.length && s.timestamps[j]! <= at) last = s.values[j++]!;
    if (last === null) return null; // starts inside the range: not a steady series
    out.push(last);
  }
  return out;
}

async function seed() {
  const srcVm = env('SRC_VM_URL');
  const vm = env('VM_URL');
  const from = Date.parse(env('SRC_FROM'));
  const to = Date.parse(env('SRC_TO'));
  const minutes = Math.round((to - from) / MIN);
  if (!(minutes >= 10 && minutes <= 60)) throw new Error('SRC_FROM..SRC_TO: 10 to 60 minutes');
  const system = createDb(env('DATABASE_SYSTEM_URL'));
  const app = createDb(env('DATABASE_URL'), { orgScoped: true });
  const end = Math.floor(Date.now() / MIN) * MIN;
  const r0 = end - DAYS * DAY;

  // Orgs, owners, sessions, clusters (Pro and Free), as the isolation suite makes them.
  const state: Record<string, string> = { end: new Date(end).toISOString() };
  for (const plan of ['pro', 'free'] as const) {
    const orgId = newId();
    const userId = newId();
    const tag = `wc-${plan}-${orgId.slice(-8)}`;
    await system
      .insertInto('orgs')
      .values({ id: orgId, name: `${tag}`, slug: tag, plan })
      .execute();
    await system
      .insertInto('users')
      .values({
        id: userId,
        email: `${tag}@example.com`,
        name: `${plan} owner`,
        password_hash: 'x',
      })
      .execute();
    await system
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
      .execute();
    if (plan === 'pro') {
      await system
        .insertInto('entitlements')
        .values({
          org_id: orgId,
          plan: 'pro',
          source: 'staff',
          users: 10,
          retention_days: 30,
          pro_features: true,
        })
        .execute();
    }
    state[`${plan}Org`] = orgId;
    state[`${plan}Session`] = (await createSession(system, userId, { orgId })).token;
    for (const kind of ['kubernetes', 'docker'] as const) {
      const id = newId();
      await system
        .insertInto('clusters')
        .values({
          id,
          org_id: orgId,
          name: `${tag}-${kind === 'kubernetes' ? 'cluster' : 'fleet'}`,
          kind,
          status: 'active',
          first_seen_at: new Date(r0),
          last_seen_at: new Date(end),
        })
        .execute();
      state[`${plan}${kind === 'kubernetes' ? 'Kube' : 'Docker'}`] = id;
    }
  }

  // 15 days from the real range, every minute, under the Pro org's ids.
  const match = `{__name__=~"${METRICS.join('|')}"}`;
  let series = 0;
  let points = 0;
  for (const [src, dest] of [
    [env('SRC_KUBE'), state.proKube!],
    [env('SRC_DOCKER'), state.proDocker!],
  ] as const) {
    const rows = await exportRange(srcVm, match.replace('{', `{cluster_id="${src}",`), from, to);
    const lines: string[] = [];
    for (const row of rows) {
      const v = perMinute(row, from, minutes);
      if (!v) continue;
      const counter = COUNTER.test(row.metric.__name__ ?? '');
      const perTile = counter ? v.at(-1)! - v[0]! + (v.at(-1)! - v[0]!) / (minutes - 1) : 0;
      const ts: number[] = [];
      const vs: number[] = [];
      for (let t = r0, n = 0; t < end; t += MIN, n++) {
        ts.push(t);
        vs.push(v[n % minutes]! + Math.floor(n / minutes) * perTile);
      }
      lines.push(
        JSON.stringify({ metric: { ...row.metric, cluster_id: dest }, values: vs, timestamps: ts }),
      );
      series++;
      points += ts.length;
      if (lines.length >= 50) await importLines(vm, lines.splice(0));
    }
    await importLines(vm, lines);
  }

  // The showcase and the chaos, generated: one request a second, every request in the
  // first bucket at or above its delay; report-worker's CPU seconds.
  const kubeEdge = {
    cluster_id: state.proKube!,
    namespace: 'shop',
    node: 'demo-worker',
    workload: 'search-client',
    workload_kind: 'Deployment',
    dst_kind: 'workload',
    dst_namespace: 'shop',
    dst_port: '8080',
    dst_service: 'search',
    dst_workload: 'search',
    dst_workload_kind: 'Deployment',
  };
  const dockerEdge = {
    cluster_id: state.proDocker!,
    host: 'wc-host',
    compose_project: 'demo',
    compose_service: 'search-client',
    container: 'demo-search-client-1',
    dst: 'demo-search-1',
    dst_kind: 'container',
    dst_port: '8080',
  };
  const kubeWorker = {
    cluster_id: state.proKube!,
    namespace: 'shop',
    workload: 'report-worker',
    workload_kind: 'Deployment',
    pod: 'report-worker-6d8f9c7b5-x2k4p',
    container: 'worker',
    node: 'demo-worker',
  };
  const dockerWorker = {
    cluster_id: state.proDocker!,
    host: 'wc-host',
    compose_project: 'demo',
    compose_service: 'report-worker',
    container: 'demo-report-worker-1',
    image: 'busybox:1.37',
  };
  const gen: string[] = [];
  const ts: number[] = [];
  for (let t = r0; t < end; t += MIN) ts.push(t);
  for (const edge of [kubeEdge, dockerEdge]) {
    const counts = new Map<string, number[]>(LE_ALL.map((le) => [le, []]));
    const reqs: number[] = [];
    let total = 0;
    const acc = new Map<string, number>(LE_ALL.map((le) => [le, 0]));
    for (const t of ts) {
      const d = searchDelay(t);
      total += 60;
      for (const le of LE_ALL) {
        if (le === '+Inf' || Number(le) >= d) acc.set(le, acc.get(le)! + 60);
        counts.get(le)!.push(acc.get(le)!);
      }
      reqs.push(total);
    }
    for (const le of LE_ALL) {
      gen.push(
        JSON.stringify({
          metric: { __name__: 'watchlog_http_request_duration_seconds_bucket', ...edge, le },
          values: counts.get(le),
          timestamps: ts,
        }),
      );
    }
    gen.push(
      JSON.stringify({
        metric: { __name__: 'watchlog_http_requests_total', ...edge, class: '2xx', code: '200' },
        values: reqs,
        timestamps: ts,
      }),
    );
  }
  for (const worker of [kubeWorker, dockerWorker]) {
    let cpu = 0;
    const vs = ts.map((t) => (cpu += reportCores(t) * 60));
    gen.push(
      JSON.stringify({
        metric: { __name__: 'watchlog_container_cpu_seconds_total', ...worker },
        values: vs,
        timestamps: ts,
      }),
    );
    gen.push(
      JSON.stringify({
        metric: { __name__: 'watchlog_container_memory_working_set_bytes', ...worker },
        values: ts.map(() => 48 * 1024 * 1024),
        timestamps: ts,
      }),
    );
  }
  await importLines(vm, gen);
  series += gen.length;
  points += gen.length * ts.length;
  await fetch(`${vm}/internal/resetRollupResultCache`);
  console.log(
    `imported ${series} series, ${points} points, ${new Date(r0).toISOString()} to ${state.end}`,
  );

  // The chaos's alert, every day, firing on report-worker (Kubernetes and Docker words).
  const ruleId = newId();
  await system
    .insertInto('alert_rules')
    .values({
      id: ruleId,
      org_id: state.proOrg!,
      name: 'Report worker CPU high',
      type: 'threshold',
      severity: 'warning',
      metric: 'workload.cpu.usage',
    })
    .execute();
  let lastAlert: Record<'kubernetes' | 'docker', string> = { kubernetes: '', docker: '' };
  for (let day = Math.floor(r0 / DAY) * DAY; day < end; day += DAY) {
    const start = day + 14 * HOUR;
    if (start < r0 || start + 41 * MIN > end) continue;
    for (const [kind, cid, labels] of [
      [
        'kubernetes',
        state.proKube!,
        { namespace: 'shop', workload_kind: 'Deployment', workload: 'report-worker' },
      ],
      [
        'docker',
        state.proDocker!,
        {
          container: 'demo-report-worker-1',
          compose_project: 'demo',
          compose_service: 'report-worker',
        },
      ],
    ] as const) {
      const id = newId();
      await system
        .insertInto('alert_states')
        .values({
          id,
          org_id: state.proOrg!,
          rule_id: ruleId,
          cluster_id: cid,
          fingerprint: `${kind}:report-worker:${start}`,
          labels: JSON.stringify(labels),
          severity: 'warning',
          state: 'resolved',
          started_at: new Date(start),
          fired_at: new Date(start + 2 * MIN),
          resolved_at: new Date(start + 41 * MIN),
        })
        .execute();
      lastAlert = { ...lastAlert, [kind]: id };
    }
  }
  state.kubeAlert = lastAlert.kubernetes;
  state.dockerAlert = lastAlert.docker;

  // The worker's jobs: learning from r0 (the org "became Pro" 15 days ago), the 168 buckets
  // before the last 24 hours, then every minute of them with the hourly recompute at :05.
  const victoria = new VictoriaQueryClient(vm, 30_000, 30_000);
  const free = state.freeOrg!;
  const deps: AnomalyDeps = {
    db: app,
    systemDb: system,
    victoria,
    orgs: async () => {
      const rows = await system
        .selectFrom('entitlements')
        .select('org_id')
        .where('pro_features', '=', true)
        .execute();
      return rows.map((r) => r.org_id);
    },
    log: { warn: (o, m) => console.warn(m, JSON.stringify(o)) },
  };
  await syncOrgs(deps, r0);
  const began = Date.now();
  const scoreFrom = end - DAY;
  const look: LookBackState = new Map();
  const lb = { ...deps, lookBackDays: 14 };
  for (let i = 0; i < BUCKETS / 24; i++) {
    const r = await runAnomalyLookBack(lb, scoreFrom, look);
    if (r.errors.length) throw new Error(`look-back: ${r.errors.join('; ')}`);
  }
  console.log(`look-back: 168 buckets a cluster in ${Math.round((Date.now() - began) / 1000)} s`);
  let opened = 0;
  for (let m = scoreFrom; m <= end; m += MIN) {
    const r = await runAnomalyMinute(deps, m);
    if (r.errors.length)
      throw new Error(`minute ${new Date(m).toISOString()}: ${r.errors.join('; ')}`);
    opened += r.opened;
    if (m % HOUR === 5 * MIN) {
      const h = await runAnomalyHour(deps, m);
      if (h.errors.length) throw new Error(`hour: ${h.errors.join('; ')}`);
    }
  }
  console.log(
    `scored 1,441 minutes in ${Math.round((Date.now() - began) / 1000)} s: ${opened} periods opened; ` +
      `Free org ${free} never listed by the worker's orgs()`,
  );
  writeFileSync(env('STATE'), JSON.stringify(state), { mode: 0o600 });
  await app.destroy();
  await system.destroy();
}

// ------------------------------------------------------------------------------ check

let failed = 0;
let passed = 0;
function ok(cond: boolean, what: string, detail?: unknown) {
  if (cond) passed++;
  else failed++;
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${what}${!cond && detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 600)}` : ''}`,
  );
}

async function check() {
  const url = env('WATCHLOG_URL');
  const state = JSON.parse(readFileSync(env('STATE'), 'utf8')) as Record<string, string>;
  const end = Date.parse(state.end!);
  const get = async (base: string, path: string, cookie: string) => {
    const res = await fetch(`${base}/api/v1${path}`, { headers: { cookie } });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  };
  const pro = `wl_session=${state.proSession}`;
  const freeCookie = `wl_session=${state.freeSession}`;
  const from = Math.floor((end - DAY) / 1000) + 60;
  const to = Math.floor(end / 1000);
  interface Row {
    key: string;
    since: string;
    until: string | null;
    object: { kind: string; name: string; namespace?: string; composeService?: string };
    peer: string | null;
    usualHigh: number;
    value: number;
    peakScore: number;
  }
  const drifts: number[] = [];
  for (let d = Math.floor((end - DAY) / DAY) * DAY; d < end; d += DAY)
    for (const h of [3, 11, 19]) {
      const s = d + h * HOUR + 50 * MIN;
      if (s >= end - DAY + 15 * MIN && s + 30 * MIN <= end) drifts.push(s);
    }
  const chaos = [Math.floor((end - DAY) / DAY) * DAY, Math.floor(end / DAY) * DAY]
    .map((d) => d + 14 * HOUR)
    .filter((s) => s >= end - DAY && s + 41 * MIN <= end);

  for (const kind of ['kubernetes', 'docker'] as const) {
    const cid = kind === 'kubernetes' ? state.proKube! : state.proDocker!;
    const r = await get(url, `/what-changed?cluster=${cid}&from=${from}&to=${to}&sort=first`, pro);
    ok(r.status === 200, `${kind}: Pro reads What changed for the last 24 hours (200)`, r);
    const body = r.body as {
      rows: Row[];
      total: number;
      learning: { learning: boolean };
      chart: { counts: number[] };
      cluster: { kind: string };
    };
    if (r.status !== 200) continue;
    ok(
      body.cluster.kind === kind && body.learning.learning === false,
      `${kind}: not learning (15 days of history)`,
      body.learning,
    );
    const near = (row: Row, s: number) => Math.abs(Date.parse(row.since) - s) <= 15 * MIN;
    const isSearch = (row: Row) =>
      row.key === 'workload.http.latency.p95' &&
      row.object.name === (kind === 'kubernetes' ? 'search' : 'demo-search-1');
    const isEdge = (row: Row) => row.key === 'edge.http.latency.p95';
    const isChaos = (row: Row) =>
      row.key === (kind === 'kubernetes' ? 'workload.cpu.usage' : 'container.cpu.usage') &&
      (kind === 'kubernetes'
        ? row.object.name === 'report-worker'
        : row.object.name === 'demo-report-worker-1');
    for (const s of drifts) {
      const p = body.rows.find((row) => isSearch(row) && near(row, s));
      ok(
        !!p && p.until !== null && p.usualHigh < 0.2 && p.value > 0.7,
        `${kind}: the showcase drift at ${new Date(s).toISOString().slice(11, 16)} UTC is listed (search p95: usual up to ${p ? Math.round(p.usualHigh * 1000) : '?'} ms, out ${p ? Math.round(p.value * 1000) : '?'} ms, ended)`,
        p ?? body.rows.map((x) => [x.key, x.object.name, x.since]),
      );
      ok(!!body.rows.find((row) => isEdge(row) && near(row, s)), `${kind}: and its map edge's p95`);
    }
    for (const s of chaos) {
      const c = body.rows.find((row) => isChaos(row) && near(row, s));
      ok(
        !!c && c.usualHigh < 0.2 && c.value > 0.4,
        `${kind}: the chaos at 14:00 UTC is listed, its usual range learned without its minutes (usual high ${c ? c.usualHigh.toFixed(3) : '?'} cores)`,
        c ?? body.rows.map((x) => [x.key, x.object.name, x.since]),
      );
    }
    const other = body.rows.filter((row) => !isSearch(row) && !isEdge(row) && !isChaos(row));
    ok(
      other.length === 0,
      `${kind}: nothing else listed (the tiled real series stay usual)`,
      other.map((x) => [x.key, x.object, x.since]),
    );
    ok(
      body.chart.counts.some((n) => n > 0),
      `${kind}: the chart counts the unusual series`,
    );

    // The alert card: "What changed around it" for the last chaos alert.
    const alertId = kind === 'kubernetes' ? state.kubeAlert! : state.dockerAlert!;
    const a = await get(url, `/what-changed?cluster=${cid}&alert=${alertId}`, pro);
    const ab = a.body as { rows?: Row[]; window?: { alert: { id: string } | null } };
    ok(
      a.status === 200 && ab.window?.alert?.id === alertId && !!ab.rows?.some(isChaos),
      `${kind}: the alert's card lists the chaos around the alert`,
      a,
    );

    // Free: 403 pro-feature, for its own cluster.
    const fid = kind === 'kubernetes' ? state.freeKube! : state.freeDocker!;
    const f = await get(url, `/what-changed?cluster=${fid}`, freeCookie);
    ok(
      f.status === 403 && JSON.stringify(f.body).includes('pro-feature'),
      `${kind}: a Free org gets 403 pro-feature`,
      f,
    );
  }

  // Nothing learned or listed for the Free org (the worker never reads it).
  const system = createDb(env('DATABASE_SYSTEM_URL'));
  for (const table of ['anomaly_baselines', 'anomaly_periods', 'anomaly_orgs'] as const) {
    const n = await system
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('org_id', '=', state.freeOrg!)
      .executeTakeFirstOrThrow();
    ok(Number(n.n) === 0, `Free org: no ${table} rows`, n);
  }
  const proBase = await system
    .selectFrom('anomaly_baselines')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', state.proOrg!)
    .executeTakeFirstOrThrow();
  ok(Number(proBase.n) > 0, `Pro org: ${proBase.n} baselines`);
  await system.destroy();

  // Community: the route isn't there (404).
  const community = process.env.COMMUNITY_URL;
  if (community) {
    const login = await fetch(`${community}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: env('COMMUNITY_EMAIL'), password: env('COMMUNITY_PASSWORD') }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const clusters = (await get(community, '/clusters', cookie)).body as {
      clusters: { id: string; kind: string }[];
    };
    for (const kind of ['kubernetes', 'docker'] as const) {
      const c = clusters.clusters.find((x) => x.kind === kind);
      if (!c) {
        ok(false, `Community: a ${kind} cluster to ask about`);
        continue;
      }
      const r = await get(community, `/what-changed?cluster=${c.id}`, cookie);
      ok(r.status === 404, `Community ${kind}: GET /what-changed answers 404`, r);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const mode = process.argv[2];
if (mode === 'seed') await seed();
else if (mode === 'check') await check();
else {
  console.error('usage: what-changed-e2e.ts seed|check (see the header)');
  process.exit(2);
}
