// SPDX-License-Identifier: AGPL-3.0-only
// Traefik on the service map (ADR-165): its numbers where eBPF has none, the requests
// it answered itself with no server up, and its entrypoints. The series' shapes are
// Traefik 3.6's, as measured on kind and Docker (labels renamed by the collector:
// service = the integration, traefik_service = Traefik's own).
import { describe, expect, it } from 'vitest';
import type { QuerySeries } from '../src/lib/victoria.js';
import {
  resolveTraefikService,
  type BackendIndex,
} from '../src/modules/integrations/traefik-backends.js';
import type { MapEdge, MapNode } from '../src/modules/servicemap/graph.js';
import { addProxies, type ProxyResults } from '../src/modules/servicemap/proxies.js';

const ID = 'int-traefik';
const s = (labels: Record<string, string>, v: number): QuerySeries => ({
  labels: { service: ID, ...labels },
  points: [[1_800_000_000, v]],
});

const traefik: MapNode = {
  id: 'w:kube-system/Deployment/traefik',
  kind: 'workload',
  name: 'traefik',
  namespace: 'kube-system',
  workloadKind: 'Deployment',
};
const api: MapNode = {
  id: 'w:shop/Deployment/api',
  kind: 'workload',
  name: 'api',
  namespace: 'shop',
  workloadKind: 'Deployment',
};
const web: MapNode = { ...api, id: 'w:shop/Deployment/web', name: 'web' };

const idx = (ready: Record<string, number>): BackendIndex => ({
  namespaces: new Set(['shop', 'kube-system']),
  containers: [],
  workloads: new Map(),
  services: new Map(
    Object.entries(ready).map(([name, n]) => [
      `shop/${name}`,
      {
        namespace: 'shop',
        name,
        workloads: [{ kind: 'Deployment', name }],
        readyEndpoints: n,
      },
    ]),
  ),
});

function edge(target: MapNode, http: MapEdge['http'] = null): MapEdge {
  return {
    id: `${traefik.id}>${target.id}:9898`,
    source: traefik.id,
    target: target.id,
    port: 9898,
    service: target.name,
    connectionsPerSecond: 0.2,
    failedPerSecond: 0,
    failedRatio: 0,
    latencyMeanSeconds: 0.001,
    latencyP95Seconds: 0.002,
    bytesSentPerSecond: 100,
    bytesReceivedPerSecond: 400,
    retransmitsPerSecond: 0,
    http,
    health: 'ok',
  };
}

const empty: ProxyResults = {
  serviceByCode: [],
  p50: [],
  p95: [],
  p99: [],
  entrypointByCode: [],
  entrypointTls: [],
  seen: [],
  serverUp: [],
};

describe('Traefik on the service map (ADR-165)', () => {
  it("fills an edge eBPF can't read with Traefik's numbers, marked as Traefik's", () => {
    const out = addProxies(
      { nodes: [traefik, web], edges: [edge(web)] },
      [{ integrationId: ID, node: traefik }],
      {
        ...empty,
        serviceByCode: [
          s({ traefik_service: 'shop-web-9898@kubernetes', code: '200' }, 9),
          s({ traefik_service: 'shop-web-9898@kubernetes', code: '502' }, 1),
          s({ traefik_service: 'api@internal', code: '200' }, 5),
        ],
        p95: [s({ traefik_service: 'shop-web-9898@kubernetes' }, 0.25)],
      },
      (n) => resolveTraefikService(n, idx({ web: 1 })),
    );
    const e = out.edges[0]!;
    expect(e.httpSource).toBe('traefik');
    expect(e.http).toMatchObject({
      requestsPerSecond: 10,
      serverErrorsPerSecond: 1,
      serverErrorRatio: 0.1,
      p95Seconds: 0.25,
    });
    expect(e.health).toBe('critical');
  });

  it('keeps eBPF as the source where it has HTTP: nothing is added, no double count', () => {
    const ebpf = {
      requestsPerSecond: 4,
      clientErrorsPerSecond: 0,
      serverErrorsPerSecond: 0,
      serverErrorRatio: 0,
      p50Seconds: 0.01,
      p95Seconds: 0.02,
      p99Seconds: 0.03,
    };
    const out = addProxies(
      { nodes: [traefik, web], edges: [edge(web, ebpf)] },
      [{ integrationId: ID, node: traefik }],
      {
        ...empty,
        serviceByCode: [s({ traefik_service: 'shop-web-9898@kubernetes', code: '200' }, 4)],
      },
      (n) => resolveTraefikService(n, idx({ web: 1 })),
    );
    expect(out.edges[0]!.http).toEqual(ebpf);
    expect(out.edges[0]!.httpSource).toBe('ebpf');
  });

  it('puts the 503s Traefik answered itself on the edge to the backend with no ready endpoint', () => {
    const out = addProxies(
      { nodes: [traefik], edges: [] },
      [{ integrationId: ID, node: traefik }],
      {
        ...empty,
        // Measured: 503 "no available server" is on the entrypoint, never on the service.
        entrypointByCode: [
          s({ entrypoint: 'web', code: '503' }, 2),
          s({ entrypoint: 'websecure', code: '200' }, 3),
          s({ entrypoint: 'metrics', code: '200' }, 0.1),
        ],
        entrypointTls: [s({ entrypoint: 'websecure' }, 3)],
        seen: [
          s({ traefik_service: 'shop-api-9898@kubernetes' }, 120),
          s({ traefik_service: 'shop-web-9898@kubernetes' }, 80),
        ],
      },
      (n) => resolveTraefikService(n, idx({ api: 0, web: 2 })),
    );
    expect(out.edges).toHaveLength(1);
    const e = out.edges[0]!;
    expect(e.source).toBe(traefik.id);
    expect(e.target).toBe(api.id);
    expect(e.answeredByProxy).toEqual({
      perSecond: 2,
      reason: 'no_server_up',
      proxy: traefik.id,
      shared: false,
    });
    expect(e.health).toBe('critical');
    expect(out.nodes.map((n) => n.id)).toEqual([traefik.id, api.id]);
    expect(out.proxies).toEqual([
      {
        node: traefik.id,
        integrationId: ID,
        answeredPerSecond: 2,
        entrypoints: [
          { name: 'web', requestsPerSecond: 2, serverErrorsPerSecond: 2, tlsRequestsPerSecond: 0 },
          {
            name: 'websecure',
            requestsPerSecond: 3,
            serverErrorsPerSecond: 0,
            tlsRequestsPerSecond: 3,
          },
        ],
      },
    ]);
  });

  it("subtracts the services' own 503s, and marks a figure shared by several down backends", () => {
    const out = addProxies(
      { nodes: [traefik, api, web], edges: [edge(api), edge(web)] },
      [{ integrationId: ID, node: traefik }],
      {
        ...empty,
        entrypointByCode: [s({ entrypoint: 'web', code: '503' }, 5)],
        serviceByCode: [s({ traefik_service: 'shop-web-9898@kubernetes', code: '503' }, 1)],
        serverUp: [
          s({ traefik_service: 'shop-api-9898@kubernetes' }, 0),
          s({ traefik_service: 'shop-web-9898@kubernetes' }, 0),
        ],
      },
      (n) => resolveTraefikService(n, idx({ api: 1, web: 1 })),
    );
    for (const e of out.edges) {
      expect(e.answeredByProxy).toMatchObject({ perSecond: 4, shared: true });
    }
  });

  it('adds nothing when no backend is down, and no edge outside the selected namespaces', () => {
    const out = addProxies(
      { nodes: [traefik], edges: [] },
      [{ integrationId: ID, node: traefik }],
      {
        ...empty,
        entrypointByCode: [s({ entrypoint: 'web', code: '503' }, 2)],
        seen: [s({ traefik_service: 'shop-api-9898@kubernetes' }, 10)],
      },
      (n) => resolveTraefikService(n, idx({ api: 0 })),
      ['billing'],
    );
    expect(out.edges).toEqual([]);
    expect(out.proxies[0]!.answeredPerSecond).toBe(2);
  });
});

describe("Traefik's service names to backends (measured on Traefik 3.6)", () => {
  const index: BackendIndex = {
    namespaces: new Set(['traefik-e2e', 'my-shop']),
    services: new Map([
      [
        'traefik-e2e/api',
        { namespace: 'traefik-e2e', name: 'api', workloads: [], readyEndpoints: 0 },
      ],
      [
        'my-shop/cart-api',
        {
          namespace: 'my-shop',
          name: 'cart-api',
          workloads: [{ kind: 'Deployment', name: 'cart' }],
          readyEndpoints: 0,
        },
      ],
    ]),
    containers: [
      {
        name: 'traefik-e2e-web-1',
        ips: ['172.24.0.2'],
        project: 'traefik-e2e',
        composeService: 'web',
        state: 'running',
      },
      {
        name: 'causes-e2e-api-1',
        ips: [],
        project: 'causes-e2e',
        composeService: 'api',
        state: 'exited',
      },
      {
        name: 'traefik-e2e-api-1',
        ips: ['172.24.0.3'],
        project: 'traefik-e2e',
        composeService: 'api',
        state: 'exited',
      },
    ],
    workloads: new Map([['traefik-e2e/api', 'Deployment']]),
  };

  it('a Service scaled to 0 lists no workload: the same-named one stands in (measured)', () => {
    expect(resolveTraefikService('traefik-e2e-api-9898@kubernetes', index)).toMatchObject({
      label: 'traefik-e2e/api',
      kind: 'workload',
      mapNode: 'w:traefik-e2e/Deployment/api',
      readyEndpoints: 0,
    });
  });

  it("a label's name shared by several projects: the server's address, then Traefik's project", () => {
    expect(resolveTraefikService('api@docker', index, { ips: ['172.24.0.3'] }).mapNode).toBe(
      'c:traefik-e2e-api-1',
    );
    expect(resolveTraefikService('api@docker', index, { projects: ['traefik-e2e'] }).mapNode).toBe(
      'c:traefik-e2e-api-1',
    );
  });

  it('splits dashed namespaces and Services against the objects', () => {
    expect(resolveTraefikService('my-shop-cart-api-8080@kubernetes', index)).toMatchObject({
      label: 'my-shop/cart-api',
      mapNode: 'w:my-shop/Deployment/cart',
      readyEndpoints: 0,
    });
  });

  it("reads an IngressRoute's hashed name as its namespace and route", () => {
    expect(
      resolveTraefikService('traefik-e2e-shop-8c0bca002bcbea5f8d05@kubernetescrd', index),
    ).toMatchObject({ kind: 'route', namespace: 'traefik-e2e', name: 'shop', mapNode: null });
  });

  it('maps Compose names, default and labelled, to their containers', () => {
    expect(resolveTraefikService('web-traefik-e2e@docker', index)).toMatchObject({
      mapNode: 'c:traefik-e2e-web-1',
      label: 'web (traefik-e2e)',
    });
    expect(resolveTraefikService('api@docker', index, { projects: ['traefik-e2e'] })).toMatchObject(
      {
        mapNode: 'c:traefik-e2e-api-1',
        state: 'exited',
      },
    );
    expect(resolveTraefikService('nope@file', index).kind).toBe('unknown');
  });
});
