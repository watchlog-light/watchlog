// SPDX-License-Identifier: AGPL-3.0-only
// ADR-226's merge rule: the same alert rule, the same workload name, both open, started within
// 30 minutes of each other, in different clusters or fleets. Near misses stay apart.
import { describe, expect, it } from 'vitest';
import {
  mergeProblems,
  workloadOf,
  type PlacedProblem,
} from '../src/modules/all-clusters/merge.js';

const T0 = Date.parse('2026-11-21T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function p(
  clusterId: string,
  min: number,
  labels: Record<string, string>,
  over: Partial<PlacedProblem> = {},
): PlacedProblem {
  return {
    clusterId,
    clusterKind: 'kubernetes',
    ruleKey: 'k8s.pod.crashloop',
    ruleId: `rule-${clusterId}`,
    labels,
    since: at(min),
    ...over,
  };
}
const sizes = (rows: PlacedProblem[][]) => rows.map((r) => r.map((m) => m.clusterId));

describe('workloadOf', () => {
  it("names each kind's workload, and nothing for nodes or silent servers", () => {
    expect(workloadOf('kubernetes', { namespace: 'shop', workload: 'api', pod: 'api-1' })).toBe(
      'workload:api',
    );
    expect(workloadOf('kubernetes', { node: 'n1' })).toBeNull();
    expect(workloadOf('server', { host: 'web-1', unit: 'nginx.service' })).toBe(
      'unit:nginx.service',
    );
    expect(workloadOf('server', { host: 'web-1', group: 'php-fpm: shop' })).toBe(
      'group:php-fpm: shop',
    );
    expect(
      workloadOf('server', { host: 'web-1', container: 'shop-web-1', compose_service: 'web' }),
    ).toBe('container:web');
    expect(workloadOf('server', { host: 'web-1', container: 'redis' })).toBe('container:redis');
    expect(workloadOf('server', { host: 'mail-01' })).toBeNull();
  });
});

describe('mergeProblems', () => {
  it('merges the same rule and workload in two clusters, whatever the namespace', () => {
    const rows = mergeProblems([
      p('prod', 0, { namespace: 'payments', workload: 'payments-api' }),
      p('staging', 12, { namespace: 'payments-staging', workload: 'payments-api' }),
    ]);
    expect(sizes(rows)).toEqual([['prod', 'staging']]);
  });

  it('merges a custom org-wide rule by its id', () => {
    const custom = { ruleKey: null, ruleId: 'org-wide' };
    const rows = mergeProblems([
      p('a', 0, { workload: 'api' }, custom),
      p('b', 5, { workload: 'api' }, custom),
    ]);
    expect(sizes(rows)).toEqual([['a', 'b']]);
  });

  it('merges server units, process groups and containers across fleets', () => {
    const srv = (c: string, min: number, labels: Record<string, string>, ruleKey: string) =>
      p(c, min, labels, { clusterKind: 'server', ruleKey });
    const rows = mergeProblems([
      srv('db', 0, { host: 'pg-1', unit: 'backup.service' }, 'server.unit.failed'),
      srv('shop', 3, { host: 'web-3', unit: 'backup.service' }, 'server.unit.failed'),
      srv('shop', 0, { host: 'web-1', group: 'php-fpm: shop' }, 'server.process.oom'),
      srv('edge', 9, { host: 'e-1', group: 'php-fpm: shop' }, 'server.process.oom'),
      srv(
        'shop',
        1,
        { host: 'w', container: 'a-web-1', compose_service: 'web' },
        'docker.container.oom',
      ),
      srv(
        'edge',
        2,
        { host: 'e', container: 'b-web-1', compose_service: 'web' },
        'docker.container.oom',
      ),
    ]);
    expect(sizes(rows)).toEqual([
      ['db', 'shop'],
      ['shop', 'edge'],
      ['shop', 'edge'],
    ]);
  });

  describe('near misses stay apart', () => {
    it('31 minutes apart', () => {
      const rows = mergeProblems([
        p('prod', 0, { workload: 'api' }),
        p('staging', 31, { workload: 'api' }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('exactly 30 minutes apart is still one', () => {
      const rows = mergeProblems([
        p('prod', 0, { workload: 'api' }),
        p('staging', 30, { workload: 'api' }),
      ]);
      expect(rows).toHaveLength(1);
    });

    it('a different rule on the same workload', () => {
      const rows = mergeProblems([
        p('prod', 0, { workload: 'api' }),
        p('staging', 1, { workload: 'api' }, { ruleKey: 'k8s.container.oomkilled' }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('a similar but different workload name', () => {
      const rows = mergeProblems([
        p('prod', 0, { workload: 'payments-api' }),
        p('staging', 1, { workload: 'payments-api-v2' }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('two custom rules with the same name but different ids', () => {
      const rows = mergeProblems([
        p('a', 0, { workload: 'api' }, { ruleKey: null, ruleId: 'r1' }),
        p('b', 0, { workload: 'api' }, { ruleKey: null, ruleId: 'r2' }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('a Kubernetes workload and a server unit with the same name', () => {
      const rows = mergeProblems([
        p('k8s', 0, { workload: 'api' }, { ruleKey: 'network.connections.failed' }),
        p(
          'srv',
          0,
          { host: 'h', unit: 'api' },
          { clusterKind: 'server', ruleKey: 'network.connections.failed' },
        ),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('a unit and a process group with the same name', () => {
      const s = { clusterKind: 'server' as const, ruleKey: 'server.process.crashloop' };
      const rows = mergeProblems([
        p('a', 0, { host: 'h', unit: 'worker' }, s),
        p('b', 0, { host: 'h', group: 'worker' }, s),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('two problems in the same cluster', () => {
      const rows = mergeProblems([
        p('prod', 0, { namespace: 'a', workload: 'api' }),
        p('prod', 1, { namespace: 'b', workload: 'api' }),
      ]);
      expect(rows).toHaveLength(2);
    });

    it('problems without a workload: nodes and silent servers', () => {
      const silent = { clusterKind: 'server' as const, ruleKey: 'agent.not_reporting' };
      const rows = mergeProblems([
        p('a', 0, { host: 'mail-01' }, silent),
        p('b', 0, { host: 'mail-01' }, silent),
        p('a', 0, { node: 'n1' }, { ruleKey: 'k8s.node.notready' }),
        p('b', 0, { node: 'n1' }, { ruleKey: 'k8s.node.notready' }),
      ]);
      expect(rows).toHaveLength(4);
    });

    it('an unknown start', () => {
      const rows = mergeProblems([
        p('a', 0, { workload: 'api' }, { since: null }),
        p('b', 0, { workload: 'api' }),
      ]);
      expect(rows).toHaveLength(2);
    });
  });

  it('a third cluster joins only within 30 minutes of every member', () => {
    const rows = mergeProblems([
      p('a', 0, { workload: 'api' }),
      p('b', 25, { workload: 'api' }),
      p('c', 45, { workload: 'api' }),
    ]);
    expect(sizes(rows)).toEqual([['a', 'b'], ['c']]);
  });

  it("keeps the input's order of each row's first member", () => {
    const rows = mergeProblems([
      p('x', 50, { workload: 'other' }, { ruleKey: 'k8s.pod.pending' }),
      p('b', 10, { workload: 'api' }),
      p('a', 0, { workload: 'api' }),
    ]);
    expect(sizes(rows)).toEqual([['x'], ['a', 'b']]);
  });
});
