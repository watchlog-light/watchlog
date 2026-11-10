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

/** Steps the engine itself adds (the walk's edge step); rules add theirs. */
const STEPS: [string, Facts][] = [
  ['edge_failed', { pct: 38, port: 9898 }],
  ['edge_errors', { pct: 5.5 }],
  ['edge_slow', { p95Ms: 420 }],
  ['edge_ok', {}],
];

/** Causes of the catalog's rules (none in slice 1). */
const CAUSES: [string, Facts][] = [];

const raw = (key: string): string | undefined =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en) as
    string | undefined;

describe('cause sentences', () => {
  const { global: i18n } = createAppI18n();
  const problems: string[] = [];
  const verify = (label: string, { key, values }: Line) => {
    const template = raw(key);
    if (typeof template !== 'string') return void problems.push(`${label}: no sentence at ${key}`);
    for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
      const v = values[name!];
      if (v === null || v === undefined || v === '')
        problems.push(`${label}: {${name}} would render empty in "${template}"`);
    }
    const text = i18n.t(key, values);
    if (/\{\w+\}|\bnull\b|\bundefined\b|causes\./.test(text))
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
