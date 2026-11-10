// SPDX-License-Identifier: AGPL-3.0-only
// The engine over a fake API (ADR-146): the subject resolved, the evidence gathered, no rule
// → no clear cause with its checks; a rule at the far end of a failing edge → the edge put in
// front of its chain (the two-hop walk), likely, with the rule's headline.
import { describe, expect, it } from 'vitest';
import { explain } from '../src/modules/causes/engine.js';
import type { Reader } from '../src/modules/causes/evidence.js';
import { parseSubject } from '../src/modules/causes/subject.js';
import { dependenciesOf, fitChain, throughEdge } from '../src/modules/causes/walk.js';
import { ApiReadError } from '../src/modules/mcp/reader.js';
import { candidate, evidence, fakeRule, step } from './support/causes.js';

const CLUSTER = {
  id: '00000000-0000-4000-8000-00000000000a',
  name: 'kind',
  kind: 'kubernetes' as const,
};
const NOW = Date.parse('2026-11-10T10:10:00.000Z');

/** The kind fixture's web → api, as the API answers: api has 0 ready pods; the edge fails. */
function api(failing: boolean): Reader {
  const healthy = evidence('kube-workload-healthy');
  const workload = (name: string, ready: number) => ({
    ...healthy.workload!,
    name,
    ready,
    podStates: ready ? ['ready'] : [],
  });
  const edge = {
    ...healthy.map.outgoing[0]!,
    ...(failing ? { failedRatio: 0.38, failedLastMinute: 15, health: 'critical' } : {}),
  };
  const routes: Record<string, unknown> = {
    [`/clusters/${CLUSTER.id}/workloads`]: { workloads: [workload('web', 1), workload('api', 0)] },
    [`/clusters/${CLUSTER.id}/events`]: { events: [] },
    [`/clusters/${CLUSTER.id}/change-markers`]: {
      markers: [
        {
          kind: 'scale',
          target: 'Deployment/causes-e2e/api',
          namespace: 'causes-e2e',
          details: { from: 1, to: 0 },
          ts: '2026-11-10T10:00:12.000Z',
        },
      ],
    },
    [`/clusters/${CLUSTER.id}/service-map`]: {
      mode: 'flows',
      agents: healthy.map.agents,
      nodes: healthy.map.nodes,
      edges: [edge],
      dns: healthy.map.dns,
    },
    [`/clusters/${CLUSTER.id}/overview`]: { problems: { items: [] } },
    '/alerts': { alerts: [] },
  };
  return {
    async get<T>(path: string, query: Record<string, unknown> = {}) {
      if (path === `/clusters/${CLUSTER.id}/pods`)
        return { pods: query.workload === 'web' ? healthy.pods : [] } as T;
      if (path.startsWith(`/clusters/${CLUSTER.id}/nodes/`)) return { node: healthy.nodes[0] } as T;
      if (path in routes) return routes[path] as T;
      throw new ApiReadError(404, `no fake for ${path}`);
    },
  };
}

const apiDown = fakeRule('dependency_down', (ev) =>
  ev.workload?.name === 'api'
    ? {
        code: 'dependency_down',
        since: '2026-11-10T10:00:12.000Z',
        chain: [
          step({ code: 'no_ready_pods', next: 'because' }),
          step({ code: 'scaled_to_zero', source: 'change_marker' }),
        ],
        headline: { code: 'dependency_down', facts: { name: 'web', target: 'api' } },
        explains: ['dependencies'],
      }
    : null,
);

describe('explain', () => {
  it('no rule: no clear cause, with what was checked', async () => {
    const a = await explain(api(false), CLUSTER, parseSubject('workload:causes-e2e/web'), {
      rules: [],
      now: NOW,
    });
    expect(a).toMatchObject({
      subject: { kind: 'workload', ref: 'causes-e2e/Deployment/web', platform: 'kubernetes' },
      state: 'none',
      causes: [],
      symptomSince: null,
      resolvedAt: null,
      checkedAt: new Date(NOW).toISOString(),
      window: { from: '2026-11-10T09:10:00.000Z', to: '2026-11-10T10:10:00.000Z' },
      headline: { code: 'none_no_changes' },
      flowsOff: null,
    });
    expect(a.checks.map((c) => c.topic)).toEqual([
      'self',
      'events',
      'changes',
      'node',
      'cpu',
      'dependencies',
      'dns',
    ]);
  });

  it('follows the failing edge: the cause at api, with the edge in front', async () => {
    const a = await explain(api(true), CLUSTER, parseSubject('workload:causes-e2e/web'), {
      rules: [apiDown],
      now: NOW,
    });
    expect(a.state).toBe('likely');
    expect(a.headline).toEqual({ code: 'dependency_down', facts: { name: 'web', target: 'api' } });
    expect(a.causes).toHaveLength(1);
    const [edge, ...rest] = a.causes[0]!.chain;
    expect(edge).toMatchObject({
      object: { kind: 'edge', ref: 'w:causes-e2e/Deployment/web>w:causes-e2e/Deployment/api:9898' },
      source: 'service_map',
      code: 'edge_failed',
      facts: { pct: 38, port: 9898 },
      next: 'calls',
    });
    expect(rest.map((s) => s.code)).toEqual(['no_ready_pods', 'scaled_to_zero']);
    expect(a.checks.find((c) => c.topic === 'dependencies')!.result).toBe('explains');
  });

  it('does not follow edges that are fine', async () => {
    let asked = 0;
    const rule = fakeRule('dependency_down', () => {
      asked++;
      return null;
    });
    await explain(api(false), CLUSTER, parseSubject('workload:causes-e2e/web'), {
      rules: [rule],
      now: NOW,
    });
    expect(asked).toBe(1);
  });
});

describe('walk', () => {
  it('only failing or slow edges to a workload or container, worst first, at most three', () => {
    const ev = evidence('kube-workload-healthy', (e) => {
      const base = e.map.outgoing[0]!;
      e.map.outgoing = [
        { ...base, id: 'a', target: 'w:x/Deployment/a', failedRatio: 0.02, failedLastMinute: 3 },
        { ...base, id: 'b', target: 'w:x/Deployment/b', failedRatio: 0.5, failedLastMinute: 9 },
        {
          ...base,
          id: 'c',
          target: 'x:db.example.com:5432',
          failedRatio: 0.9,
          failedLastMinute: 9,
        },
        { ...base, id: 'd', target: 'w:x/Deployment/d', http: { ...base.http!, p95Seconds: 2.4 } },
        {
          ...base,
          id: 'e',
          target: 'c:shop-api-1',
          http: { ...base.http!, serverErrorRatio: 0.2 },
        },
        { ...base, id: 'f', target: 'w:x/Deployment/f' },
      ];
    });
    expect(dependenciesOf(ev).map((d) => d.edge.id)).toEqual(['b', 'a', 'e']);
  });

  it('keeps the symptom and where it starts when a chain grows past three steps', () => {
    const chain = [1, 2, 3, 4].map((i) => step({ code: `s${i}` }));
    expect(fitChain(chain).map((s) => s.code)).toEqual(['s1', 's3', 's4']);
    const ev = evidence('kube-workload-healthy');
    const dep = {
      edge: { ...ev.map.outgoing[0]!, failedRatio: 0.5, failedLastMinute: 9 },
      target: 'w:causes-e2e/Deployment/api',
    };
    const c = throughEdge(ev, dep, candidate({ hops: 1, chain: chain.slice(0, 2) }));
    expect(c.hops).toBe(2);
    expect(c.chain.map((s) => s.code)).toEqual(['edge_failed', 's1', 's2']);
  });
});
