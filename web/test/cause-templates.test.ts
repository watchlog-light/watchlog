// SPDX-License-Identifier: AGPL-3.0-only
// Every probable-cause sentence (ADR-147) with the facts the backend sends: the sentence
// exists, every placeholder in it has a value, and nothing renders as a raw key, `{name}`,
// null or undefined — as for findings (finding-templates.test.ts). Rules add their codes
// here (slices 2–4): CAUSES, STEPS and HEADLINES below.
import type { CauseCheck, CauseStep } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { createAppI18n } from '@/i18n';
import {
  causeLine,
  checkLine,
  connectorKey,
  headlineLine,
  objectLink,
  sourceKey,
  stepLine,
  type Line,
} from '@/lib/causes';

type Facts = Record<string, string | number | null>;

/** Headlines: [code, facts] as engine.ts sends them. */
const HEADLINES: [string, Facts][] = [
  ['none_no_changes', { name: 'web', n: 6, minutes: 60 }],
  ['none_found', { name: 'crasher', n: 4, found: 3 }],
  ['none_flows_off', { name: 'frontend' }],
  ['possible', { name: 'checkout', n: 2 }],
  // Slice 2: the rules on the object itself (facts as rules/*.ts send them, measured live).
  ['oom_limit', { name: 'causes-e2e-hog-1', limitBytes: 50331648, n: 16 }],
  ['oom_limit', { name: 'causes-e2e-hog-1', limitBytes: 50331648, n: 1 }],
  ['oom_limit_restarts', { name: 'hog', limitBytes: 50331648, n: 6 }],
  ['oom_limit_last', { name: 'hog', limitBytes: 50331648 }],
  ['crash_exit', { name: 'crasher', exitCode: 3, n: 7 }],
  ['crash_exit_every', { name: 'crasher', exitCode: 3, everyS: 123, n: 7 }],
  ['crash_exit_once', { name: 'causes-e2e-batch-1', exitCode: 2 }],
  ['bad_change_crash', { name: 'release', exitCode: 1 }],
  ['bad_change_oom', { name: 'api', limitBytes: 268435456 }],
  ['bad_change', { name: 'api' }],
  ['image_pull', { name: 'release', image: 'busybox:0.0-causes-e2e-missing' }],
  ['image_pull_change', { name: 'release', image: 'busybox:0.0-causes-e2e-missing' }],
  ['unschedulable_cpu', { name: 'greedy', n: 2, nodes: 3, requestCores: 64 }],
  ['unschedulable_memory', { name: 'greedy', n: 2, nodes: 3, requestBytes: 68719476736 }],
  ['unschedulable_resource', { name: 'greedy', n: 2, nodes: 3, resource: 'nvidia.com/gpu' }],
  ['unschedulable_selector', { name: 'picky', n: 2, nodes: 3 }],
  ['unschedulable_taint', { name: 'picky', n: 3, nodes: 3 }],
  ['unschedulable_cordoned', { name: 'pinned', n: 1, nodes: 3 }],
  [
    'unschedulable_other',
    {
      name: 'pinned',
      message: '0/3 nodes are available: 3 node(s) had volume node affinity conflict',
    },
  ],
  ['job_failed_exit', { name: 'report', job: 'report-e2e-1794332238', exitCode: 2 }],
  ['job_failed', { name: 'report', job: 'report-29001' }],
  // Slice 3: the rules across the map (measured on the kind and Docker e2e demos).
  ['dependency_down', { name: 'web', target: 'api' }],
  ['dependency_down_scaled', { name: 'web', target: 'api' }],
  ['dependency_down_oom', { name: 'web', target: 'api', limitBytes: 268435456 }],
  ['dependency_down_crash', { name: 'web', target: 'api', exitCode: 3 }],
  ['dependency_down_change', { name: 'web', target: 'api' }],
  ['dependency_down_pull', { name: 'web', target: 'api', image: 'podinfo:0.0-missing' }],
  ['dependency_down_stopped', { name: 'web', target: 'causes-e2e-api-1', exitCode: 0 }],
  ['connection_refused', { name: 'dialer', target: 'web', port: 9899 }],
  ['connection_refused_noport', { name: 'dialer', target: 'web' }],
  ['dns_nxdomain', { name: 'typo', perMinute: 24 }],
  ['dns_nxdomain_change', { name: 'typo', perMinute: 24 }],
  ['bad_change_slow', { name: 'front', target: 'slow', p95Ms: 2425 }],
  ['bad_change_errors', { name: 'front', target: 'slow', pct: 12.5 }],
  [
    'app_consumer_oom',
    { queue: 'orders', consumer: 'rabbitmq-e2e/consumer', limitBytes: 402653184 },
  ],
  ['app_consumer_crash', { queue: 'orders', consumer: 'rabbitmq-e2e-consumer-1', exitCode: 1 }],
  ['app_consumer_change', { queue: 'orders', consumer: 'rabbitmq-e2e/consumer' }],
  [
    'app_consumer_ended',
    { queue: 'orders', consumer: 'rabbitmq-e2e-consumer-1', how: 'Exited (0)' },
  ],
  ['app_pg_held', { name: 'causes-e2e/pg', pct: 93, holder: 'causes-e2e/leak', n: 37 }],
  ['app_pg_held', { name: 'causes-e2e/pg', pct: 98, holder: 'shop/report', n: 1 }],
  [
    'app_finding_caller',
    {
      name: 'web',
      app: 'shop/redis',
      finding: 'memory_near_max',
      type: 'redis',
      pct: 95,
      member: null,
    },
  ],
  // The application's own finding: its sentence from "What WatchLog sees".
  [
    'app_finding',
    { name: 'shop/redis', finding: 'memory_near_max', type: 'redis', pct: 95, member: 'redis-0' },
  ],
  ['app_finding', { name: 'shop/nginx', finding: 'latency_high', type: 'nginx', p95: '1.40 s' }],
];

/** Checks: [topic, code, facts] as checks.ts sends them, nullable facts both ways. */
const CHECKS: [CauseCheck['topic'], string, Facts][] = [
  ['self', 'self_ok', { name: 'web' }],
  ['self', 'self_restarts', { name: 'web', n: 3 }],
  ['self', 'self_restarts_exit', { name: 'crasher', n: 7, reason: 'Error', exitCode: 3 }],
  ['self', 'self_restarts_code', { name: 'crasher', n: 77, exitCode: 3 }],
  ['self', 'self_oom_killed', { name: 'hog', n: null }],
  ['self', 'self_oom_killed', { name: 'causes-e2e-hog-1', n: 18 }],
  ['self', 'self_failing', { name: 'crasher', reason: 'CrashLoopBackOff' }],
  ['self', 'self_pending', { name: 'pinned', pod: 'pinned-84d487d85-2rnrx' }],
  ['self', 'self_not_ready', { name: 'api', ready: 0, desired: 2 }],
  ['self', 'self_stopped', { name: 'causes-e2e-api-1', exitCode: 0 }],
  ['self', 'self_not_running', { name: 'api', running: 0, total: 1 }],
  ['self', 'self_unhealthy', { name: 'fx-unhealthy', streak: null }],
  ['self', 'self_gone', { name: 'hog-76cf876d44-psvtk' }],
  ['self', 'self_no_object', { name: 'Backend CPU busy' }],
  ['events', 'events_none', { name: 'web', minutes: 60 }],
  ['events', 'events_warnings', { name: 'crasher', n: 22, reason: 'BackOff' }],
  ['changes', 'changes_none', { name: 'web', minutes: 60 }],
  ['changes', 'changes_own', { name: 'crasher', n: 5, minutes: 60 }],
  ['changes', 'changes_cluster', { n: 12, minutes: 60 }],
  ['changes', 'changes_cluster_none', { minutes: 60 }],
  ['node', 'node_ok', { node: 'demo-worker' }],
  ['node', 'node_not_ready', { node: 'demo-worker', status: 'Unknown' }],
  ['node', 'node_pressure', { node: 'demo-worker', condition: 'MemoryPressure' }],
  ['node', 'node_unschedulable', { node: 'demo-worker2' }],
  ['node', 'node_none', { name: 'pinned' }],
  ['host', 'host_ok', { host: 'docker-01' }],
  ['host', 'host_silent', { host: 'docker-01', minutes: 5 }],
  ['host', 'host_never', { host: 'docker-01' }],
  ['host', 'host_memory', { host: 'docker-01', pct: 93 }],
  ['host', 'host_disk', { host: 'docker-01', pct: 95 }],
  ['dependencies', 'dependencies_ok', { name: 'web', n: 1 }],
  ['dependencies', 'dependencies_failing', { name: 'web', n: 1, target: 'api' }],
  ['dependencies', 'dependencies_none', { name: 'crasher' }],
  ['dependencies', 'dependencies_quiet', { name: 'web', n: 1 }],
  ['dependencies', 'dependencies_quiet', { name: 'web', n: 2 }],
  ['dependencies', 'dependencies_no_node', { name: 'oom' }],
  ['dependencies', 'dependencies_flows_off', { name: 'web' }],
  ['dependencies', 'dependencies_unavailable', { name: 'web' }],
  ['dns', 'dns_ok', { name: 'web' }],
  ['dns', 'dns_errors', { name: 'typo', perMinute: 8, nxdomainPerMinute: 8 }],
  ['dns', 'dns_none', { name: 'crasher' }],
  ['dns', 'dns_flows_off', { name: 'web' }],
  ['dns', 'dns_unavailable', { name: 'web' }],
  ['application', 'application_ok', { name: 'causes-e2e/pg' }],
  ['application', 'application_findings', { name: 'causes-e2e/pg', n: 1 }],
  ['application', 'application_unreachable', { name: 'shop/postgres' }],
  ['edge', 'edge_ok', { port: 9898 }],
  ['edge', 'edge_failed', { pct: 38, port: 9898 }],
  ['edge', 'edge_failed', { pct: 38, port: null }],
  ['edge', 'edge_errors', { pct: 12.5 }],
  ['edge', 'edge_slow', { p95Ms: 2350 }],
];

/** Steps the engine itself adds (the walk's edge step) and the rules' steps. */
const STEPS: [string, Facts][] = [
  ['edge_failed', { pct: 38, port: 9898 }],
  ['edge_errors', { pct: 5.5 }],
  ['edge_slow', { p95Ms: 420 }],
  ['edge_ok', {}],
  ['oom_killed_restarts', { container: 'hog', limitBytes: 50331648, n: 6 }],
  ['oom_killed_kills', { limitBytes: 50331648, n: 16 }],
  ['oom_killed', { container: 'hog', limitBytes: 50331648 }],
  ['memory_climbs', { limitBytes: 50331648, perMinuteBytes: 53941589, minutes: 1 }],
  ['restarts_backoff', { n: 7 }],
  ['restarts', { n: 1 }],
  ['restarts_policy', { n: 183 }],
  ['exit_code', { container: 'crasher', exitCode: 3, reason: 'Error' }],
  ['exit_code_every', { container: 'crasher', exitCode: 3, reason: 'Error', everyS: 123 }],
  ['exit_code_docker', { exitCode: 3 }],
  ['exit_code_docker_every', { exitCode: 3, everyS: 19 }],
  ['exited_code', { exitCode: 2 }],
  ['last_event', { reason: 'Unhealthy', message: 'Liveness probe failed: HTTP probe failed' }],
  ['new_version_crash', { exitCode: 1, reason: 'Error' }],
  ['new_container_crash', { exitCode: 1 }],
  ['new_version_oom', { limitBytes: 268435456 }],
  ['new_version_oom_no_limit', {}],
  ['changed_image', { from: 'busybox:latest', to: 'busybox:1.36' }],
  ['rolled_out', { from: '1', to: '2' }],
  ['recreated', { image: 'busybox:1.37' }],
  ['compose_up', { project: 'causes-e2e' }],
  ['pull_not_found', { image: 'busybox:0.0-causes-e2e-missing' }],
  ['pull_denied', { image: 'registry.example.com/private/api:1.2' }],
  ['pull_unreachable', { image: 'registry.example.com/api:1.2' }],
  ['pull_invalid', { image: 'Busybox::1' }],
  ['pull_failed', { image: 'busybox:1.37', reason: 'ErrImagePull' }],
  ['pending_unscheduled', {}],
  ['scheduling_cpu', { n: 2, nodes: 3, requestCores: 0.5 }],
  ['scheduling_memory', { n: 2, nodes: 3, requestBytes: 68719476736 }],
  ['scheduling_resource', { n: 2, nodes: 3, resource: 'nvidia.com/gpu' }],
  ['scheduling_selector', { n: 2, nodes: 3 }],
  ['scheduling_taint', { n: 1, nodes: 3 }],
  ['scheduling_cordoned', { n: 1, nodes: 3 }],
  [
    'scheduling_other',
    { message: '0/3 nodes are available: 3 node(s) had volume node affinity conflict' },
  ],
  ['job_backoff_limit', { job: 'report-e2e-1794332238' }],
  ['job_deadline', { job: 'report-29001' }],
  ['job_run_failed', { job: 'report-29001' }],
  ['job_pod_exit', { exitCode: 2, reason: 'Error', n: 2 }],
  // Slice 3.
  ['edge_gone', {}],
  ['edge_gone_dns', { perMinute: 238 }],
  ['no_pods', {}],
  ['no_ready_pods', { n: 1 }],
  ['no_ready_pods', { n: 3 }],
  ['scaled', { from: 1, to: 0 }],
  ['container_stopped', { exitCode: 0 }],
  ['no_listener_ready', { port: 9899, ready: 1, n: 1 }],
  ['no_listener_ready', { port: 9899, ready: 2, n: 3 }],
  ['no_listener_running', { port: 9899 }],
  ['nxdomain', { perMinute: 24 }],
  ['new_version_slow', { fromMs: 1, p95Ms: 2425 }],
  ['new_version_slow_now', { p95Ms: 2425 }],
  ['new_version_errors', { pct: 12.5 }],
  ['queue_no_consumers', { queue: 'orders', ready: 803, perMin: 65 }],
  ['consumer_ended', { how: 'OOMKilled' }],
  ['pg_connections', { pct: 93, n: 37, max: 40 }],
  ['holds_connections', { n: 37 }],
  ['holds_connections', { n: 1 }],
  [
    'app_finding',
    {
      finding: 'connections_near_max',
      type: 'postgres',
      n: 92,
      max: 100,
      pct: 92,
      top: 'shop/x (85)',
    },
  ],
  ['app_finding', { finding: 'evicting', type: 'redis', n: 120 }],
];

/** Causes of the catalog's rules: the short line (Needs attention, notifications). */
const CAUSES: [string, Facts][] = [
  [
    'oom_limit',
    { name: 'hog', container: 'hog', limitBytes: 50331648, n: null, platform: 'kubernetes' },
  ],
  ['crash_exit', { name: 'crasher', exitCode: 3, reason: null, n: 7, everyS: null }],
  [
    'bad_change',
    {
      name: 'release',
      change: 'image',
      target: 'Container/docker-01/causes-e2e-release-1',
      failure: 'crash',
    },
  ],
  [
    'image_pull',
    { name: 'release', image: 'busybox:0.0-x', reason: 'ImagePullBackOff', registry: 'not_found' },
  ],
  ['unschedulable', { name: 'greedy', reason: 'cpu', pod: 'greedy-1', message: '0/3 nodes…' }],
  ['job_failed', { name: 'report', job: 'report-1', why: null, exitCode: null, attempts: 2 }],
  ['dependency_down', { name: 'web', target: 'api', platform: 'kubernetes', ready: 0, desired: 0 }],
  ['dependency_down', { name: 'web', target: 'causes-e2e-api-1', platform: 'docker', exitCode: 0 }],
  ['connection_refused', { name: 'dialer', target: 'web', port: 9899, pct: 100 }],
  ['connection_refused', { name: 'dialer', target: 'web', port: null, pct: 100 }],
  ['dns_nxdomain', { name: 'typo', perMinute: 24 }],
  [
    'application_finding',
    {
      name: 'causes-e2e/pg',
      finding: 'connections_near_max',
      holder: 'causes-e2e/leak',
      n: 37,
      pct: 93,
    },
  ],
  [
    'application_finding',
    {
      name: 'rabbitmq-e2e/rabbitmq',
      finding: 'queue_no_consumers',
      queue: 'orders',
      consumer: 'c',
      how: 'OOMKilled',
    },
  ],
];

const raw = (key: string): string | undefined =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as
    string | undefined;

describe('cause sentences', () => {
  const { global: i18n } = createAppI18n();
  const problems: string[] = [];
  const verify = (label: string, { key, values, plural }: Line) => {
    const template = raw(key);
    if (typeof template !== 'string') return void problems.push(`${label}: no sentence at ${key}`);
    for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
      const v = values[name!];
      if (v === null || v === undefined || v === '')
        problems.push(`${label}: {${name}} would render empty in "${template}"`);
    }
    const text = plural === undefined ? i18n.t(key, values) : i18n.t(key, values, plural);
    if (/\{\w+\}|\bnull\b|\bundefined\b|causes\.|\|/.test(text))
      problems.push(`${label}: rendered "${text}"`);
  };

  it('every headline, check, step and cause has its words, every placeholder filled', () => {
    problems.length = 0;
    for (const [code, facts] of HEADLINES)
      verify(`headline ${code}`, headlineLine({ headline: { code, facts } }));
    for (const [topic, code, facts] of CHECKS) {
      const { what, result } = checkLine({ topic, code, facts });
      verify(`check ${code} (what) ${JSON.stringify(facts)}`, what);
      verify(`check ${code} ${JSON.stringify(facts)}`, result);
    }
    for (const [code, facts] of STEPS) verify(`step ${code}`, stepLine({ code, facts }));
    for (const [code, facts] of CAUSES) verify(`cause ${code}`, causeLine({ code, facts }));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('every check code in en.json is in the list above', () => {
    const listed = new Set(CHECKS.map(([, code]) => code));
    const words = Object.keys(
      (en as { causes: { check: { result: object } } }).causes.check.result,
    );
    expect(words.filter((w) => !listed.has(w))).toEqual([]);
  });

  it('every headline, step and cause in en.json is in the lists above', () => {
    const words = (en as { causes: Record<string, object> }).causes;
    const missing = (part: string, listed: string[]) =>
      Object.keys(words[part]!).filter((w) => !listed.includes(w));
    expect(
      missing(
        'headline',
        HEADLINES.map(([c]) => c),
      ),
    ).toEqual([]);
    expect(
      missing(
        'step',
        STEPS.map(([c]) => c),
      ),
    ).toEqual([]);
    expect(
      missing(
        'cause',
        CAUSES.map(([c]) => c),
      ),
    ).toEqual([]);
  });

  it('connectors and sources have words', () => {
    for (const next of ['calls', 'because', 'consumed_by', 'looks_up', 'after'] as const)
      expect(i18n.t(connectorKey({ next })!)).not.toMatch(/causes\./);
    expect(connectorKey({ next: null })).toBeNull();
    for (const source of [
      'service_map',
      'kubernetes',
      'docker',
      'change_marker',
      'metrics',
      'dns',
      'application',
    ] as CauseStep['source'][])
      expect(i18n.t(sourceKey({ source }))).not.toMatch(/causes\./);
  });

  it('renders counts, limits, requests and intervals in their words and units', () => {
    const say = ({ key, values, plural }: Line) =>
      plural === undefined ? i18n.t(key, values) : i18n.t(key, values, plural);
    expect(
      say(
        headlineLine({
          headline: { code: 'oom_limit', facts: { name: 'hog', limitBytes: 50331648, n: 1 } },
        }),
      ),
    ).toBe('hog is OOM-killed when it reaches its 48 MiB memory limit: once in the last hour.');
    expect(say(stepLine({ code: 'restarts_backoff', facts: { n: 7 } }))).toBe(
      'Restarting with back-off: 7 restarts in the last hour.',
    );
    expect(
      say(stepLine({ code: 'exit_code_docker_every', facts: { exitCode: 3, everyS: 123 } })),
    ).toBe('It exits with code 3 about every 2 min.');
    expect(
      say(stepLine({ code: 'scheduling_cpu', facts: { n: 2, nodes: 3, requestCores: 0.25 } })),
    ).toBe('It requests 250m CPU, more than 2 of the 3 nodes have free.');
  });

  it('renders the rules across the map in their words', () => {
    const say = ({ key, values, plural }: Line) =>
      plural === undefined ? i18n.t(key, values) : i18n.t(key, values, plural);
    expect(
      say(
        headlineLine({
          headline: { code: 'dependency_down_scaled', facts: { name: 'web', target: 'api' } },
        }),
      ),
    ).toBe('web fails because api was scaled to 0: nothing answers its calls.');
    expect(say(stepLine({ code: 'no_ready_pods', facts: { n: 1 } }))).toBe(
      "Its only pod isn't ready.",
    );
    expect(say(stepLine({ code: 'new_version_slow', facts: { fromMs: 2, p95Ms: 2425 } }))).toBe(
      'Its calls slowed from 2 ms to 2.42 s at p95.',
    );
    expect(
      say(
        headlineLine({
          headline: { code: 'app_pg_held', facts: { name: 'pg', pct: 93, holder: 'leak', n: 37 } },
        }),
      ),
    ).toBe('pg is at 93 % of max_connections: leak holds 37 of them.');
    // A finding's own sentence, as "What WatchLog sees" words it.
    expect(
      say(
        stepLine({
          code: 'app_finding',
          facts: { finding: 'evicting', type: 'redis', n: 120 },
        }),
      ),
    ).not.toMatch(/causes\.|\{/);
  });

  it('says a slow call in milliseconds or seconds', () => {
    const { key, values } = stepLine({ code: 'edge_slow', facts: { p95Ms: 2350 } });
    expect(i18n.t(key, values)).toBe('Its HTTP calls take 2.35 s at p95.');
  });
});

describe('objectLink', () => {
  const C = 'c1';
  const o = (kind: string, ref: string) =>
    ({ kind, ref, name: ref, platform: 'kubernetes' }) as Parameters<typeof objectLink>[0];
  it('links every object to its page, Kubernetes and Docker', () => {
    expect(objectLink(o('pod', 'shop/cart-1'), C)).toMatchObject({
      name: 'pod',
      params: { namespace: 'shop', name: 'cart-1' },
    });
    expect(objectLink(o('workload', 'shop/Deployment/cart'), C)).toMatchObject({
      name: 'workloads',
      query: { wns: 'shop', wkind: 'Deployment', wname: 'cart' },
    });
    expect(objectLink(o('container', 'docker-01/shop-api-1'), C)).toMatchObject({
      name: 'docker-container',
      params: { host: 'docker-01', name: 'shop-api-1' },
    });
    expect(objectLink(o('compose_service', 'shop/api'), C)).toMatchObject({
      name: 'containers',
      query: { project: 'shop' },
    });
    expect(objectLink(o('edge', 'w:a/Deployment/b>w:a/Deployment/c:80'), C)).toMatchObject({
      name: 'service-map',
      query: { edge: 'w:a/Deployment/b>w:a/Deployment/c:80' },
    });
    expect(objectLink(o('change', 'Deployment/shop/api'), C)).toMatchObject({ name: 'workloads' });
    expect(objectLink(o('change', 'Container/docker-01/shop-api-1'), C)).toMatchObject({
      name: 'docker-container',
    });
    expect(objectLink(o('host', 'docker-01'), C)).toMatchObject({ name: 'docker-host' });
    expect(objectLink(o('node', 'demo-worker'), C)).toMatchObject({ name: 'node' });
    expect(objectLink(o('application', 'id'), C)).toMatchObject({ name: 'application' });
    expect(objectLink(o('alert', 'id'), C)).toMatchObject({ name: 'alert' });
    expect(objectLink(o('cluster', 'c1'), C)).toBeUndefined();
  });
});
