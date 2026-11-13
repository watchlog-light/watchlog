// SPDX-License-Identifier: AGPL-3.0-only
// The Traefik page (v0.5 slice 3, SPEC §4.12, ADR-165): its tabs from Traefik's own
// series as the collector writes them (shapes from Traefik 3.6 on the e2e VM: the service
// label renamed traefik_service), the backend with no server up found from the Service's
// ready endpoints when there are no health checks, Traefik's own 503s (counted on the
// entrypoint, never on a service), probable cause's link to the backend, and metrics_off.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import type { Evidence } from '../src/modules/causes/evidence.js';
import { linksOf } from '../src/modules/causes/rules/application-finding.js';
import { reasonSentence } from '../src/modules/mcp/tools/applications.js';
import {
  TEST_VM_URL,
  closeTestContext,
  createTestContext,
  setupAdmin,
  type TestContext,
} from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `traefik-page-${Date.now()}`;
const MIN = 60_000;
const NOW = Math.floor(Date.now() / 15_000) * 15_000;
const vm = new VictoriaQueryClient(TEST_VM_URL);

let ctx: TestContext;
let cookie: string;

const api = (method: string, url: string, payload?: object) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: cookie },
    ...(payload ? { payload } : {}),
  });

beforeEach(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
});
afterEach(() => closeTestContext(ctx));
afterAll(async () => {
  await fetch(
    `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
    { method: 'POST' },
  );
});

async function cluster(name: string, kind: 'kubernetes' | 'docker') {
  const res = await api('POST', '/clusters', { name, kind });
  return { id: res.json().cluster.id as string, token: res.json().token.value as string };
}

/** 30 minutes of a series, every 15 s, from `value(i)` (i = 0…120). */
async function write(
  clusterId: string,
  name: string,
  labels: Record<string, string>,
  value: (i: number) => number | null,
) {
  const series: TestSeries[] = [];
  for (let i = 0, t = NOW - 30 * MIN; t <= NOW; i++, t += 15_000) {
    const v = value(i);
    if (v === null) continue;
    series.push({ labels: { __name__: name, run: RUN, ...labels }, value: v, timestampMs: t });
  }
  await vm.write({ clusterId }, encode(series));
}

async function status(token: string, host: string, targets: object[]) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/ingest/v1/integrations/status',
    headers: { authorization: `Bearer ${token}`, 'x-watchlog-agent': 'integrations' },
    payload: {
      host,
      mode: host ? 'docker' : 'kubernetes',
      version: 't',
      config_version: '',
      self: {},
      targets,
    },
  });
  expect(r.statusCode, r.body).toBe(204);
}

async function service(clusterId: string, ns: string, name: string, ready: number) {
  await ctx.db
    .insertInto('objects')
    .values({
      id: newId(),
      cluster_id: clusterId,
      source: 'kubernetes',
      kind: 'Service',
      namespace: ns,
      name,
      uid: newId(),
      node: '',
      spec_summary: JSON.stringify({}),
      status_summary: JSON.stringify({
        ready_endpoints: ready,
        workloads: [{ kind: 'Deployment', name }],
      }),
    })
    .execute();
}

type Panel = { id: string; state: string; [k: string]: unknown };

describe('the Traefik page', () => {
  it('fills its tabs and names the backend with no server up (Kubernetes, 3.6)', async () => {
    const k8s = await cluster('prod', 'kubernetes');
    // api was scaled to 0 ten minutes ago; web still answers.
    await service(k8s.id, 'shop', 'api', 0);
    await service(k8s.id, 'shop', 'web', 1);
    const id = (
      await api('POST', '/applications', {
        clusterId: k8s.id,
        type: 'traefik',
        target: {
          kind: 'workload',
          namespace: 'kube-system',
          workload_kind: 'Deployment',
          workload: 'traefik',
          port: 8000,
        },
        defaultAlerts: ['traefik_no_server_up'],
      })
    ).json().application.id as string;
    await status(k8s.token, '', [
      {
        id,
        state: 'ok',
        service_version: '3.6.25',
        product: 'traefik',
        members: [{ name: 'traefik-5cf77f8d77-w6qdr', up: true }],
        extra: {
          traefik: [
            { metrics: true, metrics_at: ':9100/metrics', routers: false, health_checks: false },
          ],
        },
      },
    ]);
    const s = (extra: Record<string, string>) => ({
      service: id,
      service_type: 'traefik',
      member: 'traefik-5cf77f8d77-w6qdr',
      ...extra,
    });
    const DOWN_AT = 80; // i = 80: 10 minutes before NOW
    await Promise.all([
      write(
        k8s.id,
        'traefik_entrypoint_requests_total',
        s({ entrypoint: 'web', code: '200' }),
        (i) => i * 20,
      ),
      write(
        k8s.id,
        'traefik_entrypoint_requests_total',
        s({ entrypoint: 'websecure', code: '200' }),
        (i) => i * 10,
      ),
      // Traefik's own 503s: on the entrypoint only.
      write(
        k8s.id,
        'traefik_entrypoint_requests_total',
        s({ entrypoint: 'web', code: '503' }),
        (i) => (i < DOWN_AT ? 0 : (i - DOWN_AT) * 15),
      ),
      write(
        k8s.id,
        'traefik_entrypoint_requests_total',
        s({ entrypoint: 'metrics', code: '200' }),
        (i) => i,
      ),
      write(
        k8s.id,
        'traefik_entrypoint_requests_tls_total',
        s({ entrypoint: 'websecure' }),
        (i) => i * 10,
      ),
      write(
        k8s.id,
        'traefik_service_requests_total',
        s({ traefik_service: 'shop-web-80@kubernetes', code: '200' }),
        (i) => i * 20,
      ),
      write(
        k8s.id,
        'traefik_service_requests_total',
        s({ traefik_service: 'shop-api-80@kubernetes', code: '200' }),
        (i) => (i < DOWN_AT ? i * 10 : null),
      ),
      ...['0.1', '0.3', '1.2', '5', '+Inf'].map((le, j) =>
        write(
          k8s.id,
          'traefik_entrypoint_request_duration_seconds_bucket',
          s({ entrypoint: 'web', le }),
          (i) => i * (25 + j),
        ),
      ),
      ...['0.1', '0.3', '1.2', '5', '+Inf'].map((le, j) =>
        write(
          k8s.id,
          'traefik_service_request_duration_seconds_bucket',
          s({ traefik_service: 'shop-web-80@kubernetes', le }),
          (i) => i * (18 + j),
        ),
      ),
      write(k8s.id, 'traefik_open_connections', s({ entrypoint: 'web' }), () => 7),
      write(k8s.id, 'traefik_open_connections', s({ entrypoint: 'metrics' }), () => 1),
      write(
        k8s.id,
        'traefik_tls_certs_not_after',
        s({ cn: 'shop.example.com' }),
        () => NOW / 1000 + 5 * 86_400,
      ),
      write(k8s.id, 'traefik_config_reloads_total', s({}), () => 2),
      write(k8s.id, 'traefik_config_last_reload_success', s({}), () => NOW / 1000 - 3600),
    ]);
    await fetch(`${TEST_VM_URL}/internal/force_flush`);

    const d = (await api('GET', `/applications/${id}`)).json();
    expect(d.page.id).toBe('traefik');
    expect(d.page.tabs.map((t: { id: string }) => t.id)).toEqual([
      'overview',
      'services',
      'entrypoints',
      'connection',
    ]);
    const reasons = d.reasons as {
      code: string;
      facts: Record<string, unknown>;
      links?: { kind: string; id: string }[];
    }[];
    const none = reasons.find((r) => r.code === 'no_server_up')!;
    expect(none.facts).toMatchObject({
      service: 'shop-api-80@kubernetes',
      backend: 'shop/api',
      ready: 0,
    });
    expect(none.facts.answered as number).toBeGreaterThan(0.5);
    expect(none.links).toEqual([{ kind: 'workload', id: 'shop/Deployment/api', name: 'api' }]);
    expect(reasons.find((r) => r.code === 'certificate_expiring')!.facts).toMatchObject({
      host: 'shop.example.com',
    });
    expect(
      reasons.find((r) => r.code === 'certificate_expiring')!.facts.days as number,
    ).toBeGreaterThanOrEqual(4);
    expect(reasons.some((r) => r.code === 'metrics_off')).toBe(false);
    for (const r of reasons) expect(reasonSentence(r), r.code).not.toBe('See the facts.');
    expect(reasonSentence(none)).toContain('503');

    const panels = async (tab: string) =>
      (await api('GET', `/applications/${id}/panels?tab=${tab}`)).json().panels as Panel[];
    const tiles = (await panels('overview')).find((p) => p.id === 'summary')!.tiles as {
      id: string;
      value: unknown;
      severity?: string;
    }[];
    expect(tiles.find((t) => t.id === 'services')).toMatchObject({
      value: '1 / 2',
      severity: 'critical',
    });
    expect(tiles.find((t) => t.id === 'connections')!.value).toBe(7);
    const table = (await panels('services')).find((p) => p.id === 'services') as unknown as {
      rows: { cells: unknown[]; severity?: string }[];
    };
    expect(table.rows.map((r) => [r.cells[0], r.cells[1], r.severity])).toEqual([
      ['shop-api-80@kubernetes', 'shop/api', 'critical'],
      ['shop-web-80@kubernetes', 'shop/web', undefined],
    ]);
    const eps = await panels('entrypoints');
    const byEp = eps.find((p) => p.id === 'by-entrypoint') as unknown as {
      series: { name: string }[];
    };
    expect(byEp.series.map((x) => x.name).sort()).toEqual(['web', 'websecure']);
    expect(eps.find((p) => p.id === 'certificates')!.state).toBe('ok');
  });

  it('metrics off: the setting for a Compose Traefik, the three flags', async () => {
    const docker = await cluster('edge', 'docker');
    const id = (
      await api('POST', '/applications', {
        clusterId: docker.id,
        type: 'traefik',
        target: {
          kind: 'compose',
          host: 'h1',
          compose_project: 'edge',
          compose_service: 'proxy',
          port: 80,
        },
        defaultAlerts: [],
      })
    ).json().application.id as string;
    await status(docker.token, 'h1', [
      {
        id,
        state: 'ok',
        members: [{ name: 'edge-proxy-1', up: true }],
        extra: {
          traefik: [
            {
              metrics: false,
              metrics_at: '',
              tried:
                ':9100/metrics: connection refused; :8080/metrics: connection refused; :8082/metrics: connection refused',
            },
          ],
        },
      },
    ]);
    const d = (await api('GET', `/applications/${id}`)).json();
    const off = (d.reasons as { code: string; facts: Record<string, unknown> }[]).find(
      (r) => r.code === 'metrics_off',
    )!;
    expect(off.facts.how).toBe('flags');
    expect(off.facts.command).toContain('--metrics.prometheus.entrypoint=metrics');
    expect(off.facts.tried).toContain(':9100/metrics');
  });
});

describe('probable cause follows no_server_up to the backend', () => {
  const ev = (platform: string, links: { kind: string; id: string; name: string }[]) =>
    ({
      platform,
      application: {
        id: 'a',
        type: 'traefik',
        name: 'kube-system/traefik',
        health: 'critical',
        reason: { code: 'connected', facts: {} },
        target: {},
        reasons: [
          { severity: 'critical', code: 'no_server_up', facts: { backend: 'shop/api' }, links },
        ],
      },
    }) as unknown as Evidence;

  it('the workload on Kubernetes, the container on Docker, nothing without a backend', () => {
    expect(
      linksOf(ev('kubernetes', [{ kind: 'workload', id: 'shop/Deployment/api', name: 'api' }]))[0],
    ).toMatchObject({
      finding: 'no_server_up',
      target: { kind: 'workload', namespace: 'shop', name: 'api', workloadKind: 'Deployment' },
    });
    expect(
      linksOf(
        ev('docker', [{ kind: 'container', id: 'traefik-e2e-api-1', name: 'traefik-e2e-api-1' }]),
      )[0],
    ).toMatchObject({ target: { kind: 'container', name: 'traefik-e2e-api-1' } });
    expect(linksOf(ev('kubernetes', []))).toEqual([]);
  });
});
