// SPDX-License-Identifier: AGPL-3.0-only
// What an alert is about in messages and MCP (ADR-229): a monitored service's rule names the
// service, a pod metric the pod, a server's unit and process group the server and the unit;
// a rule over a namespace or the whole cluster never reads "node" with no name.
import { describe, expect, it } from 'vitest';
import { alertSubject, where } from '../src/modules/alerts/render.js';

const SERVICE = '01a1d459-7a48-70a0-8e07-e3e8da652ba8';

describe('where (messages) and alertSubject (MCP)', () => {
  it('a monitored service: product and name, on either kind', () => {
    const l = { service: SERVICE, service_name: 'traefik/traefik', service_type: 'traefik' };
    expect(where(l)).toBe('Traefik traefik/traefik');
    expect(alertSubject(l)).toEqual({ kind: 'service', name: 'traefik/traefik', type: 'Traefik' });
    const redis = {
      member: 'redis-0',
      service: SERVICE,
      service_name: 'shop/redis',
      service_type: 'redis',
    };
    expect(alertSubject(redis)).toMatchObject({ kind: 'service', type: 'Redis' });
    const onServer = {
      service: SERVICE,
      service_name: 'web-01/postgres',
      service_type: 'postgres',
    };
    expect(where(onServer)).toBe('PostgreSQL web-01/postgres');
  });

  it('a pod metric: the pod', () => {
    const l = { pod: 'mongodb-0', namespace: 'shop' };
    expect(where(l)).toBe('shop/mongodb-0 (Pod)');
    expect(alertSubject(l)).toEqual({ kind: 'pod', name: 'shop/mongodb-0' });
  });

  it('a workload with its pod: the workload', () => {
    const l = { pod: 'api-1', workload: 'api', namespace: 'shop', workload_kind: 'Deployment' };
    expect(where(l)).toBe('shop/api (Deployment)');
    expect(alertSubject(l)).toEqual({ kind: 'workload', name: 'shop/api', type: 'Deployment' });
  });

  it("a node, a server's unit, process group and container", () => {
    expect(alertSubject({ node: 'worker-1' })).toEqual({ kind: 'node', name: 'worker-1' });
    expect(where({ node: 'web-01', unit: 'orders.service' })).toBe('web-01 › orders.service');
    expect(alertSubject({ node: 'web-01', unit: 'orders.service' })).toEqual({
      kind: 'unit',
      name: 'web-01/orders.service',
    });
    expect(alertSubject({ node: 'web-01', group: 'api' })).toEqual({
      kind: 'process-group',
      name: 'web-01/api',
    });
    expect(alertSubject({ node: 'web-01', container: 'redis' })).toEqual({
      kind: 'container',
      name: 'web-01/redis',
    });
  });

  it('a namespace, and the whole cluster', () => {
    expect(where({ namespace: 'shop' })).toBe('namespace shop');
    expect(alertSubject({ namespace: 'shop' })).toEqual({ kind: 'namespace', name: 'shop' });
    expect(alertSubject({})).toEqual({ kind: 'cluster', name: '' });
  });
});
