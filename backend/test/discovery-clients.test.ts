// SPDX-License-Identifier: AGPL-3.0-only
// Discovery leaves out pods and containers that run a server's image only for its client.
import { describe, expect, it } from 'vitest';
import {
  containerKey,
  flowQueries,
  flowSides,
  looksLikeClient,
  workloadKey,
} from '../src/modules/integrations/clients.js';

const s = (labels: Record<string, string>) => ({ labels, points: [] as [number, number][] });

// Label sets as measured on the e2e stack (kind and Docker, slice 10a).
const out = [
  s({ namespace: 'shop', workload_kind: 'Deployment', workload: 'orders', dst_port: '5432' }),
  s({
    namespace: 'mongodb-e2e',
    workload_kind: 'StatefulSet',
    workload: 'mongo',
    dst_port: '27017',
  }),
  s({ compose_project: 'mysql-e2e', container: 'mysql-e2e-locker-1', dst_port: '3306' }),
  s({ container: 'mongodb-e2e-mongo-b-1', dst_port: '27017' }),
  s({ container: 'traefik-1', dst_port: '80' }),
];
const inbound = [
  s({
    dst_kind: 'workload',
    dst_namespace: 'shop',
    dst_workload_kind: 'StatefulSet',
    dst_workload: 'postgres',
    dst_port: '5432',
  }),
  s({
    dst_kind: 'workload',
    dst_namespace: 'mongodb-e2e',
    dst_workload_kind: 'StatefulSet',
    dst_workload: 'mongo',
    dst_port: '27017',
  }),
  s({ dst_kind: 'container', dst: 'mysql-e2e-mariadb-1', dst_port: '3306' }),
  s({ dst_kind: 'container', dst: 'mongodb-e2e-mongo-b-1', dst_port: '27017' }),
  s({ dst_kind: 'service', dst_namespace: 'shop', dst_service: 'postgres', dst_port: '5432' }),
];
const sides = flowSides(out, inbound);

describe('client check', () => {
  it('leaves out a pod that only connects to the port', () => {
    expect(looksLikeClient(sides, workloadKey('shop', 'Deployment', 'orders'), [5432], [])).toBe(
      true,
    );
    expect(looksLikeClient(sides, containerKey('mysql-e2e-locker-1'), [3306], [3306])).toBe(false);
    expect(looksLikeClient(sides, containerKey('mysql-e2e-locker-1'), [3306], [])).toBe(true);
  });

  it('keeps servers: reached on the port, even when they also connect out (replica sets)', () => {
    expect(looksLikeClient(sides, workloadKey('shop', 'StatefulSet', 'postgres'), [5432], [])).toBe(
      false,
    );
    expect(
      looksLikeClient(sides, workloadKey('mongodb-e2e', 'StatefulSet', 'mongo'), [27017], []),
    ).toBe(false);
    expect(looksLikeClient(sides, containerKey('mongodb-e2e-mongo-b-1'), [27017], [])).toBe(false);
    expect(looksLikeClient(sides, containerKey('mysql-e2e-mariadb-1'), [3306], [])).toBe(false);
  });

  it('keeps what it can not tell: no flows, or a port it declares or publishes', () => {
    expect(looksLikeClient(sides, workloadKey('shop', 'Deployment', 'idle'), [5432], [])).toBe(
      false,
    );
    // A proxy connects out on the ports it serves: published there, it stays.
    expect(looksLikeClient(sides, containerKey('traefik-1'), [80, 8000, 443], [443, 80])).toBe(
      false,
    );
    expect(looksLikeClient(flowSides([], []), containerKey('traefik-1'), [80], [])).toBe(false);
  });

  it('queries every port once, connections out and established ones in', () => {
    const q = flowQueries([5432, 3306, 5432]);
    expect(q.out).toContain('dst_port=~"3306|5432"');
    expect(q.out).toContain('watchlog_flow_connections_total');
    expect(q.in).toContain('watchlog_flow_connect_latency_seconds_count');
    expect(q.in).toContain('watchlog_flow_bytes_total');
  });
});
