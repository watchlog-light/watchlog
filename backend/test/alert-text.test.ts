// SPDX-License-Identifier: AGPL-3.0-only
// The words of every alert (alerts redesign item 6, ADR-095).
import { describe, expect, it } from 'vitest';
import { fullIn } from '../src/modules/alerts/metric-rules.js';
import { DEFAULT_RULES } from '../src/modules/alerts/rules.js';
import { alertText, type AlertTextInput } from '../src/modules/alerts/text.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const min = (n: number) => new Date(NOW - n * 60_000).toISOString();
const text = (
  ruleKey: string | null,
  labels: Record<string, string>,
  details: Record<string, unknown>,
  over: Partial<AlertTextInput> = {},
) =>
  alertText({
    ruleKey,
    ruleName: 'Rule',
    labels,
    details,
    cluster: { name: 'prod-eu' },
    now: NOW,
    ...over,
  });
const pod = {
  namespace: 'payments',
  workload: 'payments-api',
  workload_kind: 'Deployment',
  pod: 'payments-api-1',
  node: 'w1',
};

describe('alert titles and "why" lines', () => {
  const cases: [string, Record<string, string>, Record<string, unknown>, string, string | null][] =
    [
      [
        'network.connections.failed',
        {
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'frontend',
          dst_kind: 'workload',
          dst_namespace: 'shop',
          dst_workload: 'cart',
          dst_service: 'cart',
        },
        { value: 0.42, threshold: 0.05 },
        'frontend cannot reach cart',
        '42% of connections failed · threshold 5%',
      ],
      [
        'k8s.pod.crashloop',
        pod,
        { reason: 'Error', exitCode: 1, restarts: 9 },
        'payments-api is crash-looping',
        'last exit: Error (code 1) · 9 restarts',
      ],
      [
        'k8s.container.oomkilled',
        { ...pod, workload: 'report-worker' },
        { killedAt: min(3), limit: '512Mi', restarts: 1 },
        'report-worker was killed for using too much memory',
        'OOMKilled 3 min ago · limit 512Mi · 1 restart',
      ],
      [
        'k8s.pod.pending',
        pod,
        { reason: 'Unschedulable', message: '0/3 nodes are available' },
        'payments-api is stuck in Pending',
        'Unschedulable: 0/3 nodes are available',
      ],
      [
        'k8s.pod.imagepull',
        pod,
        { reason: 'ImagePullBackOff', image: 'ghcr.io/acme/api:1.2' },
        'payments-api cannot pull its image',
        'ghcr.io/acme/api:1.2 · ImagePullBackOff',
      ],
      [
        'k8s.node.notready',
        { node: 'worker-07', condition: 'Ready' },
        {
          status: 'Unknown',
          reason: 'NodeStatusUnknown',
          message: 'Kubelet stopped posting node status.',
        },
        'Node worker-07 is not ready',
        'Ready: Unknown · NodeStatusUnknown · Kubelet stopped posting node status.',
      ],
      [
        'k8s.node.pressure',
        { node: 'worker-07', condition: 'DiskPressure' },
        { message: 'kubelet has disk pressure' },
        'Node worker-07 is under disk pressure',
        'kubelet has disk pressure',
      ],
      [
        'k8s.deployment.unavailable',
        { namespace: 'shop', workload: 'checkout', workload_kind: 'Deployment' },
        { ready: 1, desired: 3 },
        'checkout has 1 of 3 replicas ready',
        '2 replicas unavailable',
      ],
      [
        'docker.container.unhealthy',
        { node: 'db-01', container: 'postgres' },
        { streak: 3, output: 'pg_isready: no response' },
        'postgres container is unhealthy',
        'health check failing 3× · pg_isready: no response',
      ],
      [
        'docker.container.restarts',
        { node: 'db-01', container: 'worker' },
        { value: 5 },
        'worker keeps restarting',
        '5 restarts in 10 min',
      ],
      [
        'agent.not_reporting',
        { agent: 'all' },
        { agents: 3, lastSeen: min(18) },
        'prod-eu stopped reporting',
        'all 3 agents are silent · last data 18 min ago',
      ],
      [
        'agent.not_reporting',
        { node: 'worker-2', agent: 'node' },
        { lastSeen: min(4) },
        'The agent on node worker-2 stopped reporting',
        'last heartbeat 4 min ago',
      ],
      [
        'agent.not_reporting',
        { node: 'cluster-agent', agent: 'cluster' },
        { lastSeen: min(4) },
        'The cluster-agent stopped reporting',
        'last heartbeat 4 min ago',
      ],
      [
        'watchlog.ingest.failing',
        {},
        {
          since: min(7),
          endpoints: [
            { endpoint: 'objects', status: 500 },
            { endpoint: 'events', status: 413 },
          ],
        },
        'WatchLog cannot store data from prod-eu',
        'objects answered 500, events answered 413 · failing for 7 min',
      ],
      // Servers (ADR-208).
      [
        'server.unit.failed',
        { node: 'app-1', unit: 'billing.service' },
        { value: 1 },
        'billing.service failed on app-1',
        'systemd marked it failed',
      ],
      [
        'server.unit.crashloop',
        { node: 'app-1', unit: 'orders.service' },
        { value: 7 },
        'orders.service is crash-looping on app-1',
        '7 crashes or restarts in 10 min',
      ],
      [
        'server.process.crashloop',
        { node: 'app-1', group: 'api', unit: 'pm2-deploy.service' },
        { value: 12 },
        'api is crash-looping on app-1',
        '12 failed exits in 10 min · in pm2-deploy.service',
      ],
      [
        'server.unit.oom',
        { node: 'app-1', unit: 'orders.service' },
        { value: 1 },
        'orders.service was killed for using too much memory on app-1',
        '1 OOM kill in 10 min',
      ],
      [
        'server.process.oom',
        { node: 'app-1', group: 'worker' },
        { value: 2 },
        'worker was killed for using too much memory on app-1',
        '2 OOM kills in 10 min',
      ],
      [
        'server.process.gone',
        { node: 'app-1', group: 'sync.py' },
        { value: 1 },
        'sync.py has no process left on app-1',
        'every instance exited · not under systemd: nothing restarts it',
      ],
      [
        'server.unit.memory',
        { node: 'db-1', unit: 'postgresql@16-main.service' },
        { value: 0.93, threshold: 0.9 },
        'postgresql@16-main.service is near its memory limit on db-1',
        '93% of MemoryMax · threshold 90%',
      ],
      [
        'server.unit.throttling',
        { node: 'app-1', unit: 'orders.service' },
        { value: 0.4, threshold: 0.25 },
        'orders.service is CPU-throttled on app-1',
        'throttled 40% of the time at its CPUQuota · threshold 25%',
      ],
      [
        'server.memory.high',
        { node: 'db-1' },
        { value: 0.95, threshold: 0.9, forSeconds: 600 },
        'Memory on db-1 is at 95%',
        'threshold 90% · for 10 min',
      ],
      [
        'node.cpu.high',
        { node: 'worker-07' },
        { value: 0.94, threshold: 0.9, forSeconds: 600 },
        'CPU on worker-07 is at 94%',
        'threshold 90% · for 10 min',
      ],
      [
        'node.disk.usage',
        { node: 'worker-07', mount: '/var/lib/containerd' },
        { value: 0.88, threshold: 0.85, risePerHour: 2, fullInSeconds: 6 * 3600 },
        'Disk on worker-07 is 88% full',
        'threshold 85% · mount /var/lib/containerd · rising 2% per hour · full in ~6 h',
      ],
      [
        'node.disk.usage',
        { node: 'worker-07', mount: '/' },
        { value: 0.9, threshold: 0.85 },
        'Disk on worker-07 is 90% full',
        'threshold 85%',
      ],
      [
        'k8s.pvc.usage',
        { namespace: 'db', pvc: 'data-pg-0' },
        { value: 0.87, threshold: 0.85 },
        'Volume db/data-pg-0 is 87% full',
        'threshold 85%',
      ],
      [
        'k8s.container.throttling',
        { namespace: 'shop', workload: 'checkout', workload_kind: 'Deployment', container: 'app' },
        { value: 0.4, threshold: 0.25 },
        'checkout is CPU-throttled',
        'app: throttled 40% of the time · threshold 25%',
      ],
      [
        'docker.container.throttling',
        { node: 'docker-01', container: 'causes-e2e-hot-1' },
        // An alert that fired before ADR-160 holds throttled ÷ used: shown at most 100%.
        { value: 15.77, threshold: 0.25 },
        'causes-e2e-hot-1 is CPU-throttled',
        'throttled 100% of the time · threshold 25%',
      ],
      // Egress (ADR-187): the source in its platform's words, the destination with its port.
      [
        'egress.new_destination',
        {
          namespace: 'shop',
          workload_kind: 'Deployment',
          workload: 'orders',
          destination: 'cdn-update-check.xyz',
          port: '443',
        },
        { destination: 'cdn-update-check.xyz', port: 443, firstSeen: min(3), others: 0 },
        'orders started talking to cdn-update-check.xyz:443',
        'first connection at 11:57 UTC · nothing else in the cluster talks to it',
      ],
      [
        'egress.raw_ip',
        { compose_project: 'shop', compose_service: 'api', destination: '1.1.1.0/24', port: '443' },
        { destination: '1.1.1.0/24', port: 443, connections: 5 },
        'shop/api connects to 1.1.1.0/24:443 by IP address',
        '5 connections in 10 min · no DNS name behind it',
      ],
      [
        'egress.large_upload_new',
        { node: 'docker-01', container: 'backup', destination: 'files.example.org', port: '443' },
        {
          destination: 'files.example.org',
          port: 443,
          sentBytes: 125_829_120,
          threshold: 104_857_600,
          firstSeen: min(120),
        },
        'backup sent 120 MiB to files.example.org:443',
        'in the last hour · threshold 100 MiB · first seen at 10:00 UTC',
      ],
      // Certificates and scheduled jobs (0.10, ADR-225).
      [
        'cert.expiring',
        { node: 'web-1', certificate: 'shop.wl.test' },
        {
          value: -2 * 86_400,
          notAfter: '2026-11-17T10:00:00.000Z',
          servedAt: ['nginx.service :443'],
          issuer: "Let's Encrypt",
        },
        'The certificate for shop.wl.test expired 2 days ago',
        "expired 17 Nov 2026 · served at nginx.service :443 · issued by Let's Encrypt · renew it, or check the job that renews it",
      ],
      [
        'cert.problem',
        { certificate: 'shop.wl.test', problem: 'chain' },
        { value: 1 },
        'The certificate chain for shop.wl.test is incomplete',
        "the intermediate certificate isn't sent · some clients and browsers refuse it: serve the full chain",
      ],
      [
        'job.failed',
        { node: 'worker-1', job: 'backup.timer' },
        { value: 3, streak: 3, exitCode: 2, lastGood: min(3 * 24 * 60) },
        'backup.timer failed 3 times in a row on worker-1',
        "exit code 2 · last good run 3 d ago · its runs are on the job's page",
      ],
      [
        'job.missed',
        { namespace: 'shop', workload: 'nightly', workload_kind: 'CronJob' },
        { value: 1, expectedAt: min(30), schedule: '0 3 * * *' },
        'nightly missed its run in shop',
        'expected 30 min ago · schedule 0 3 * * *',
      ],
      [
        'job.slow',
        { node: 'worker-1', job: 'export.php' },
        { value: 1, running: true, seconds: 1800, usualSeconds: 60 },
        'export.php is running far longer than usual on worker-1',
        'running for 30 min · usually 60 s',
      ],
    ];
  it.each(cases)('%s: %s', (key, labels, details, title, why) => {
    const t = text(key, labels, details);
    expect({ title: t.title, why: t.why }).toEqual({ title, why });
  });

  it('covers every default rule', () => {
    const covered = new Set(cases.map(([k]) => k));
    expect(DEFAULT_RULES.map((r) => r.key).filter((k) => !covered.has(k))).toEqual([]);
  });

  it('describes custom threshold rules in their metric unit', () => {
    expect(
      text(
        null,
        { namespace: 'wl-test', pod: 'web-0' },
        { value: 900 * 2 ** 20, threshold: 500 * 2 ** 20, op: '>', forSeconds: 300 },
        {
          ruleName: 'Web memory',
          metric: 'pod.memory.working_set',
        },
      ),
    ).toEqual({ title: 'Web memory: web-0 at 900 MiB', why: 'above 500 MiB · for 5 min' });
  });

  it('falls back to the rule name and the stored summary for older alerts', () => {
    expect(text('k8s.pod.crashloop', pod, { summary: 'main: Error (exit 1), 6 restarts' })).toEqual(
      {
        title: 'payments-api is crash-looping',
        why: 'main: Error (exit 1), 6 restarts',
      },
    );
    expect(text('something.new', {}, { summary: 'x' }, { ruleName: 'Something' })).toEqual({
      title: 'Something',
      why: 'x',
    });
  });

  it('never shows raw ISO times: older agent alerts say how long ago they last reported', () => {
    // Rows written before `lastSeen` existed (measured in the dev database).
    const old = { summary: `cluster-agent on cluster-agent: last heartbeat ${min(18)}` };
    expect(text('agent.not_reporting', { node: 'cluster-agent', agent: 'cluster' }, old)).toEqual({
      title: 'The cluster-agent stopped reporting',
      why: 'last heartbeat 18 min ago',
    });
    const other = text('something.new', {}, { summary: `stale since ${min(45)}` });
    expect(other.why).toBe('stale since 45 min ago');
    expect(JSON.stringify(other)).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });
});

describe('"full in ~N" only when a linear trend means something', () => {
  it('projects a steady rise, rounded', () => {
    // 88 % rising 2 points an hour: full in 6 h.
    expect(fullIn(0.88, 0.02 / 3600)).toEqual({ fullInSeconds: 6 * 3600, risePerHour: 2 });
    // 97 % rising 6 points an hour: 30 min, in 10-minute steps.
    expect(fullIn(0.97, 0.06 / 3600)).toEqual({ fullInSeconds: 1800, risePerHour: 6 });
  });
  it('says nothing for a flat, falling, too slow or too fast trend', () => {
    expect(fullIn(0.88, 0)).toBeUndefined();
    expect(fullIn(0.88, -0.01 / 3600)).toBeUndefined();
    expect(fullIn(0.88, 0.001 / 3600)).toBeUndefined(); // 0.1 points an hour
    expect(fullIn(0.1, 0.005 / 3600)).toBeUndefined(); // 180 h away: more than a week
    expect(fullIn(0.999, 0.5 / 3600)).toBeUndefined(); // under 10 min: already full
  });
});
