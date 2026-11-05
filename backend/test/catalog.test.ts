// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  buildQuery,
  chooseStep,
  escapeLabelValue,
  METRIC_KEYS,
  rateWindow,
} from '../src/modules/query/catalog.js';

describe('metric catalog', () => {
  it('renders scope only as escaped label matchers', () => {
    const q = buildQuery(
      'container.cpu.usage',
      { host: 'web-01', container: 'a"}) or vector(1) #' },
      15,
    );
    expect(q.expr).toBe(
      'sum by (host, container) (rate(watchlog_container_cpu_seconds_total{host="web-01",container="a\\"}) or vector(1) #"}[60s]))',
    );
    expect(escapeLabelValue('a\\b\n"c"')).toBe('a\\\\b\\n\\"c\\"');
  });

  it('builds valid selectors without a scope', () => {
    expect(buildQuery('host.load1', {}, 15).expr).toBe('max by (host) (watchlog_node_load1{})');
    expect(buildQuery('host.cpu.utilization', {}, 15).expr).toContain('{mode!="idle"}');
  });

  it('lets the caller choose the aggregation', () => {
    expect(
      buildQuery('container.memory.working_set', { composeProject: 'demo' }, 15, 'max').expr,
    ).toBe(
      'max by (host, container) (watchlog_container_memory_working_set_bytes{compose_project="demo"})',
    );
  });

  it('scopes Kubernetes keys by node, pod, workload and namespaces (ADR-062)', () => {
    expect(
      buildQuery('pod.container.memory.working_set', { namespace: 'wl-test', pod: 'web-1' }, 15)
        .expr,
    ).toBe(
      'sum by (namespace, pod, container) (watchlog_container_memory_working_set_bytes{pod!="",namespace="wl-test",pod="web-1"})',
    );
    expect(buildQuery('node.condition', { node: 'worker' }, 15).expr).toBe(
      'max by (node, condition) (watchlog_kube_node_condition{status="true",node="worker"} or watchlog_kube_node_condition{status!="true",node="worker"} * 0)',
    );
    expect(buildQuery('node.load1', { node: 'worker' }, 15).expr).toBe(
      'max by (node) (watchlog_node_load1{node="worker"})',
    );
    expect(
      buildQuery('workload.cpu.usage', { workloadKind: 'Deployment', workload: 'web' }, 15).expr,
    ).toContain('{pod!="",workload_kind="Deployment",workload="web"}');
    // Values become an escaped alternation: no regex or quote injection.
    expect(
      buildQuery('namespace.cpu.usage', { namespaces: ['a.b', 'c|d', 'e"f'] }, 15).expr,
    ).toContain('namespace=~"a\\\\.b|c\\\\|d|e\\"f"');
  });

  it('never mentions cluster_id (VictoriaMetrics enforces it)', () => {
    for (const key of METRIC_KEYS)
      expect(buildQuery(key, { host: 'h' }, 15).expr).not.toContain('cluster_id');
  });

  it('chooses steps of at least 15 s and at most ~1,000 points', () => {
    expect(chooseStep(3600)).toBe(15);
    expect(chooseStep(7 * 86400)).toBe(615);
    expect(chooseStep(3600, 7)).toBe(15);
    expect(chooseStep(3600, 61)).toBe(75);
    expect(rateWindow(15)).toBe('60s');
    expect(rateWindow(615)).toBe('1230s');
  });
});
