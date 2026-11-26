#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The own-metrics push step test (1.0.3, ADR-242): pushes are raised in steps across many
// tokens and orgs while agents' ingest runs at its normal rate beside them, against a backend
// sized like Cloud's. For each step it records the pushes accepted and refused (by answer),
// the p95 latency of a push and of an agent's write, the backend container's CPU and memory,
// and whether any agent data was refused or missing in VictoriaMetrics afterwards.
//
//   node run.mjs --ingest http://127.0.0.1:4380 --state state.json --vm http://127.0.0.1:8496 \
//     --container wl-load-backend --steps 50,200,500,1000,2000 --step-seconds 100 --out result.json
//
// The run passes when every agent call is taken at every step and the backend never restarts
// or runs out of memory, however many pushes are refused. No dependency: Node's own http.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ingest = new URL(arg('ingest', 'http://127.0.0.1:4380'));
const vm = arg('vm', '');
const container = arg('container', '');
const steps = arg('steps', '50,200,500,1000,2000').split(',').map(Number);
const stepSeconds = Number(arg('step-seconds', '100'));
const agentEvery = Number(arg('agent-every', '5'));
const out = arg('out', '');
const { orgs } = JSON.parse(readFileSync(arg('state', 'state.json'), 'utf8'));
const run = `ownpush${Date.now()}`;

const pushAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const agentAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** One request; resolves with its status (0: no answer) and how long it took. */
function send(path, headers, body, agent) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request(
      {
        host: ingest.hostname,
        port: ingest.port,
        path,
        method: 'POST',
        agent,
        headers: { ...headers, 'content-length': body.length },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0 }));
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, ms: performance.now() - t0 }));
    req.end(body);
  });
}

// ----------------------------------------------------- remote write, by hand (as an agent)
function varint(n) {
  const o = [];
  while (n >= 0x80) {
    o.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  o.push(n);
  return o;
}
const field = (n, data) => [...varint((n << 3) | 2), ...varint(data.length), ...data];
const text = (s) => [...Buffer.from(s)];
function remoteWrite(series, at) {
  const body = [];
  for (const s of series) {
    const ts = [];
    const names = Object.keys(s.labels).sort((a, b) =>
      a === '__name__' ? -1 : b === '__name__' ? 1 : a.localeCompare(b),
    );
    for (const k of names)
      ts.push(...field(1, [...field(1, text(k)), ...field(2, text(s.labels[k]))]));
    const value = Buffer.alloc(8);
    value.writeDoubleLE(s.value);
    ts.push(...field(2, [0x09, ...value, ...varint(2 << 3), ...varint(at)]));
    body.push(...field(1, ts));
  }
  // Snappy: the length, then literals of at most 60 bytes.
  const o = [...varint(body.length)];
  for (let i = 0; i < body.length; i += 60) {
    const chunk = body.slice(i, i + 60);
    o.push((chunk.length - 1) << 2, ...chunk);
  }
  return Buffer.from(o);
}

// ----------------------------------------------------- what is counted
const p95 = (list) => {
  if (list.length === 0) return null;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]);
};
const fresh = () => ({
  sent: 0,
  ok: 0,
  limited: 0,
  shed: 0,
  other: 0,
  none: 0,
  ms: [],
  pending: new Set(),
});
const freshAgents = () => ({
  sent: 0,
  ok: 0,
  refused: 0,
  statuses: {},
  ms: [],
  pending: new Set(),
});
let push = fresh();
let agents = freshAgents();
let samples = [];
const sequence = new Map(orgs.map((o) => [o.host, 0]));
const acknowledged = new Map(orgs.map((o) => [o.host, 0]));

/** The container's own counters (cgroup v2): CPU time used so far, and memory now. */
function stats() {
  if (!container) return null;
  try {
    const text = execFileSync(
      'docker',
      [
        'exec',
        container,
        'sh',
        '-c',
        'head -1 /sys/fs/cgroup/cpu.stat; cat /sys/fs/cgroup/memory.current',
      ],
      { encoding: 'utf8' },
    );
    const [cpu, mem] = text.trim().split('\n');
    return {
      at: performance.now(),
      cpuUs: Number(cpu.split(' ')[1]),
      memMiB: Number(mem) / 1048576,
    };
  } catch {
    return null;
  }
}
/** CPU as a share of one core, between two readings: 200% is both of the container's two. */
const cpuBetween = (a, b) =>
  a && b ? Math.round(((b.cpuUs - a.cpuUs) / 1000 / (b.at - a.at)) * 100) : null;

// ----------------------------------------------------- the load
const NAMES = ['orders_total', 'queue_jobs_waiting', 'payments_failed_total'];
let n = 0;
function onePush() {
  const o = orgs[n % orgs.length];
  const token = o.tokens[Math.floor(n / orgs.length) % o.tokens.length];
  const name = NAMES[n % NAMES.length];
  n++;
  const body = Buffer.from(JSON.stringify({ name, value: 1, server: o.host }));
  // Counted in the step it was sent in, whenever its answer comes.
  const step = push;
  step.sent++;
  const p = send(
    '/ingest/v1/metrics',
    { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    pushAgent,
  ).then((r) => {
    step.ms.push(r.ms);
    if (r.status === 200) step.ok++;
    else if (r.status === 429) step.limited++;
    else if (r.status === 503) step.shed++;
    else if (r.status === 0) step.none++;
    else step.other++;
    step.pending.delete(p);
  });
  step.pending.add(p);
}
async function oneAgent(o) {
  const at = Date.now();
  const seq = sequence.get(o.host) + 1;
  sequence.set(o.host, seq);
  const headers = { authorization: `Bearer ${o.clusterToken}`, 'x-watchlog-agent': o.host };
  const series = [{ labels: { __name__: 'load_probe_sequence', host: o.host, run }, value: seq }];
  for (let i = 0; i < 20; i++)
    series.push({
      labels: { __name__: 'load_probe_gauge', host: o.host, run, part: String(i) },
      value: Math.random(),
    });
  const step = agents;
  step.sent += 2;
  let done;
  const p = new Promise((r) => (done = r));
  step.pending.add(p);
  const [w, h] = await Promise.all([
    send(
      '/ingest/v1/write',
      { ...headers, 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy' },
      remoteWrite(series, at),
      agentAgent,
    ),
    send(
      '/ingest/v1/heartbeat',
      { ...headers, 'content-type': 'application/json' },
      Buffer.from(
        JSON.stringify({
          agent_version: 'load',
          mode: 'docker',
          node: o.host,
          capabilities: {},
          series: 21,
        }),
      ),
      agentAgent,
    ),
  ]);
  for (const r of [w, h]) {
    step.ms.push(r.ms);
    if (r.status >= 200 && r.status < 300) step.ok++;
    else {
      step.refused++;
      step.statuses[r.status] = (step.statuses[r.status] ?? 0) + 1;
    }
  }
  if (w.status >= 200 && w.status < 300) acknowledged.set(o.host, acknowledged.get(o.host) + 1);
  step.pending.delete(p);
  done();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// Agents, as real ones: each writes and heartbeats every `agentEvery` seconds, spread out.
const agentTimers = orgs.map((o, i) =>
  setTimeout(
    () => {
      void oneAgent(o);
      agentTimers[i] = setInterval(() => void oneAgent(o), agentEvery * 1000);
    },
    (i / orgs.length) * agentEvery * 1000,
  ),
);
const sampler = setInterval(() => {
  const s = stats();
  if (s) samples.push(s);
}, 10_000);

console.error(
  `${orgs.length} orgs, ${orgs.reduce((a, o) => a + o.tokens.length, 0)} tokens; steps ${steps.join(', ')} pushes a second, ${stepSeconds} s each`,
);
await sleep(agentEvery * 1000);
for (const rate of steps) {
  const p = (push = fresh());
  const a = (agents = freshAgents());
  samples = [];
  const before = stats();
  const started = performance.now();
  let due = 0;
  // An open loop: what should have been sent by now is sent, whatever the answers do.
  while (performance.now() - started < stepSeconds * 1000) {
    const want = Math.floor(((performance.now() - started) / 1000) * rate);
    for (; due < want; due++) onePush();
    await sleep(5);
  }
  const after = stats();
  // The next step's calls go to their own counters; this step's are waited for.
  push = fresh();
  agents = freshAgents();
  await Promise.all([...p.pending, ...a.pending]);
  // What the agents sent while this step's answers were awaited belongs to the idle moment.
  const idle = agents;
  await Promise.all([...idle.pending]);
  a.sent += idle.sent;
  a.ok += idle.ok;
  a.refused += idle.refused;
  a.ms.push(...idle.ms);
  for (const [k, v] of Object.entries(idle.statuses)) a.statuses[k] = (a.statuses[k] ?? 0) + v;
  const row = {
    rate,
    sent: p.sent,
    accepted: p.ok,
    limited429: p.limited,
    shed503: p.shed,
    other: p.other,
    noAnswer: p.none,
    pushP95ms: p95(p.ms),
    agentCalls: a.sent,
    agentRefused: a.refused,
    agentStatuses: a.statuses,
    agentP95ms: p95(a.ms),
    cpuPercent: cpuBetween(before, after),
    memMaxMiB: samples.length
      ? Math.round(Math.max(...samples.map((s) => s.memMiB), after?.memMiB ?? 0))
      : after
        ? Math.round(after.memMiB)
        : null,
  };
  results.push(row);
  console.error(JSON.stringify(row));
}
for (const t of agentTimers) {
  clearTimeout(t);
  clearInterval(t);
}
clearInterval(sampler);
await sleep(3000);

// Was every acknowledged agent write stored? Each carried the next number of its host's sequence.
let missing = null;
if (vm) {
  await fetch(`${vm}/internal/force_flush`).catch(() => undefined);
  await sleep(1500);
  const end = Math.floor(Date.now() / 1000) + 60;
  const q = encodeURIComponent(`{__name__="load_probe_sequence",run="${run}"}`);
  const res = await fetch(`${vm}/api/v1/export?match[]=${q}&start=${end - 3600}&end=${end}`);
  const stored = new Map();
  for (const line of (await res.text()).split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    stored.set(row.metric.host, (stored.get(row.metric.host) ?? 0) + new Set(row.values).size);
  }
  missing = 0;
  for (const [host, n] of acknowledged) missing += Math.max(0, n - (stored.get(host) ?? 0));
}
let restarts = null;
let oom = null;
if (container) {
  try {
    const s = execFileSync(
      'docker',
      ['inspect', '-f', '{{.RestartCount}} {{.State.OOMKilled}} {{.State.Running}}', container],
      { encoding: 'utf8' },
    )
      .trim()
      .split(' ');
    restarts = Number(s[0]);
    oom = s[1] === 'true' || s[2] !== 'true';
  } catch {
    // no container to ask
  }
}
const noRefusals = results
  .filter((r) => r.limited429 + r.shed503 + r.other + r.noAnswer === 0)
  .map((r) => r.rate);
const summary = {
  run,
  orgs: orgs.length,
  tokens: orgs.reduce((a, o) => a + o.tokens.length, 0),
  stepSeconds,
  steps: results,
  agentWritesAcknowledged: [...acknowledged.values()].reduce((a, b) => a + b, 0),
  agentWritesMissingInStorage: missing,
  backendRestarts: restarts,
  backendOutOfMemoryOrStopped: oom,
  highestRateWithoutRefusals: noRefusals.length ? Math.max(...noRefusals) : 0,
  passed:
    results.every((r) => r.agentRefused === 0) &&
    (missing ?? 0) === 0 &&
    (restarts ?? 0) === 0 &&
    oom !== true,
};
if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(
  '| Pushes a second | Sent | Accepted | 429 | 503 (shed) | Other / no answer | Push p95 | Agent calls | Agent refused | Agent p95 | CPU (of 200%) | Memory max |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results)
  console.log(
    `| ${r.rate} | ${r.sent} | ${r.accepted} | ${r.limited429} | ${r.shed503} | ${r.other + r.noAnswer} | ${r.pushP95ms} ms | ${r.agentCalls} | ${r.agentRefused} | ${r.agentP95ms} ms | ${r.cpuPercent ?? '–'}% | ${r.memMaxMiB ?? '–'} MiB |`,
  );
console.log(
  `\nagent writes acknowledged: ${summary.agentWritesAcknowledged}; missing in storage: ${missing ?? 'not checked'}; backend restarts: ${restarts ?? 'not checked'}; out of memory or stopped: ${oom ?? 'not checked'}`,
);
console.log(
  `highest rate served without a refusal: ${summary.highestRateWithoutRefusals} a second; ${summary.passed ? 'PASSED' : 'FAILED'}`,
);
process.exit(summary.passed ? 0 : 1);
