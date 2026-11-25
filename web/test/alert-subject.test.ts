// SPDX-License-Identifier: AGPL-3.0-only
// What an alert is about (ADR-229): one case per subject the rule builder offers, on
// Kubernetes clusters and Server fleets. A rule on a monitored service's metric names the
// service ("Traefik service traefik/traefik"), a pod metric the pod; nothing falls back to
// "Node" with no name.
import { describe, expect, it } from 'vitest';
import { alertScope, alertTarget, alertTargetName, alertWhere } from '@/lib/alerts';

const kube = { id: 'c1', name: 'prod', kind: 'kubernetes' as const };
const fleet = { id: 'c2', name: 'web-servers', kind: 'server' as const };
const alert = (labels: Record<string, string>, cluster: typeof kube | typeof fleet = kube) => ({
  labels,
  cluster,
  podCount: 0,
});

const SERVICE = '01a1d459-7a48-70a0-8e07-e3e8da652ba8';

describe('alertScope, alertWhere and alertTarget per subject', () => {
  it('a monitored service on Kubernetes (Traefik, Redis)', () => {
    const traefik = alert({
      service: SERVICE,
      service_name: 'traefik/traefik',
      service_type: 'traefik',
    });
    expect(alertScope(traefik)).toEqual({
      kind: 'service',
      type: 'Traefik',
      name: 'traefik/traefik',
      extra: null,
    });
    expect(alertWhere(traefik)).toBe('Traefik traefik/traefik');
    expect(alertTarget(traefik)).toEqual({ name: 'application', params: { id: SERVICE } });
    expect(alertTargetName(traefik)).toBe('traefik/traefik');
    // Redis's memory rule also names a member pod: still the service.
    const redis = alert({
      member: 'redis-5856889fc5-jw9bq',
      service: SERVICE,
      service_name: 'shop/redis',
      service_type: 'redis',
    });
    expect(alertScope(redis)).toMatchObject({ kind: 'service', type: 'Redis', name: 'shop/redis' });
  });

  it('a monitored service on a Server fleet', () => {
    const pg = alert(
      { service: SERVICE, service_name: 'web-01/postgres', service_type: 'postgres' },
      fleet,
    );
    expect(alertScope(pg)).toMatchObject({ kind: 'service', type: 'PostgreSQL' });
    expect(alertTarget(pg)).toEqual({ name: 'application', params: { id: SERVICE } });
  });

  it('a pod metric: the pod, not a node', () => {
    const a = alert({ pod: 'mongodb-0', namespace: 'shop' });
    expect(alertScope(a)).toEqual({ kind: 'Pod', name: 'shop/mongodb-0', extra: null });
    expect(alertWhere(a)).toBe('shop/mongodb-0 (Pod)');
    expect(alertTarget(a)).toEqual({
      name: 'pod',
      params: { namespace: 'shop', name: 'mongodb-0' },
    });
  });

  it('a workload, with its pod: the workload', () => {
    const a = alert({
      pod: 'legacy-importer-76c4c5486b-9xjxq',
      workload: 'legacy-importer',
      namespace: 'shop',
      workload_kind: 'Deployment',
    });
    expect(alertScope(a)).toMatchObject({ kind: 'Deployment', name: 'shop/legacy-importer' });
  });

  it('a namespace, and the whole cluster', () => {
    expect(alertScope(alert({ namespace: 'shop' }))).toEqual({
      kind: 'namespace',
      name: 'shop',
      extra: null,
    });
    expect(alertScope(alert({}))).toEqual({ kind: 'kubernetes', name: 'prod', extra: null });
    expect(alertScope(alert({}, fleet))).toEqual({
      kind: 'server',
      name: 'web-servers',
      extra: null,
    });
  });

  it('a node and a host', () => {
    expect(alertScope(alert({ node: 'worker-1' }))).toMatchObject({
      kind: 'node',
      name: 'worker-1',
    });
    expect(alertScope(alert({ node: 'web-01' }, fleet))).toMatchObject({
      kind: 'host',
      name: 'web-01',
    });
  });

  it("a server's container, systemd service and process group", () => {
    expect(alertScope(alert({ node: 'web-01', container: 'redis' }, fleet))).toEqual({
      kind: 'host',
      name: 'web-01',
      extra: 'redis',
    });
    const unit = alert({ node: 'web-01', unit: 'orders.service' }, fleet);
    expect(alertScope(unit)).toMatchObject({ kind: 'unit', name: 'web-01 › orders.service' });
    expect(alertTarget(unit)).toEqual({
      name: 'server-workload',
      params: { server: 'web-01', workload: 'service:orders.service' },
    });
    const group = alert({ node: 'web-01', group: 'api' }, fleet);
    expect(alertScope(group)).toMatchObject({ kind: 'group', name: 'web-01 › api' });
    expect(alertWhere(group)).toBe('web-01 › api (process group)');
  });

  it("a server's failed-connections alert names the unit and its server, never undefined", () => {
    // The live demo's "demo-load.service cannot reach orders.service" read
    // "Service undefined/demo-load.service": flow series name a unit as a workload.
    const flow = alert(
      {
        node: 'demo-server',
        workload: 'demo-load.service',
        workload_kind: 'Service',
        dst_kind: 'workload',
        dst_workload: 'orders.service',
      },
      fleet,
    );
    expect(alertScope(flow)).toEqual({
      kind: 'unit',
      name: 'demo-server › demo-load.service',
      extra: null,
    });
    expect(alertWhere(flow)).toBe('demo-server › demo-load.service');
    expect(alertTarget(flow)).toEqual({
      name: 'server-workload',
      params: { server: 'demo-server', workload: 'service:demo-load.service' },
    });
    expect(alertTargetName(flow)).toBe('demo-load.service');
    const group = alert({ node: 'web-01', workload: 'api', workload_kind: 'ProcessGroup' }, fleet);
    expect(alertScope(group)).toMatchObject({ kind: 'group', name: 'web-01 › api' });
    // Raised before 1.0.0, without its server: the name alone.
    const old = alert({ workload: 'demo-load.service', workload_kind: 'Service' }, fleet);
    expect(alertScope(old)).toMatchObject({ kind: 'unit', name: 'demo-load.service' });
    expect(alertWhere(old)).toBe('demo-load.service');
  });
});
