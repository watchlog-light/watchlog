// SPDX-License-Identifier: AGPL-3.0-only
// SPEC §14: the overview answers within 1.5 s (p95) for a 100-node cluster. Seeds 100
// nodes, 3,000 pods in 300 workloads, 2,000 warning events, change markers, a firing
// alert, and an hour of node, pod and flow series, then times the overview call.
// Runs only with WATCHLOG_BENCH=1 (it writes about a million samples).
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { VictoriaQueryClient } from '../src/lib/victoria.js';
import { closeTestContext, createTestContext, setupAdmin, TEST_VM_URL } from './helpers.js';
import { encode, type TestSeries } from './support/remote-write.js';

const RUN = `ovscale-${Date.now()}`;
const NODES = 100;
const PODS_PER_NODE = 30;
const STEP = 60_000;
const NOW = Math.floor(Date.now() / STEP) * STEP;

describe.runIf(process.env.WATCHLOG_BENCH === '1')('overview at 100 nodes', () => {
  afterAll(async () => {
    await fetch(
      `${TEST_VM_URL}/api/v1/admin/tsdb/delete_series?match[]=${encodeURIComponent(`{run="${RUN}"}`)}`,
      { method: 'POST' },
    );
  });

  it('answers within 1.5 s at p95', { timeout: 600_000 }, async () => {
    const ctx = await createTestContext();
    try {
      const cookie = await setupAdmin(ctx.app);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/clusters',
        cookies: { wl_session: cookie },
        payload: { name: 'scale', kind: 'kubernetes' },
      });
      const clusterId = res.json().cluster.id as string;
      const orgId =
        res.json().cluster.orgId ??
        (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id;

      // Objects: nodes, workloads, pods (a few crash-looping), events, markers.
      const rows: Record<string, unknown>[] = [];
      const obj = (
        kind: string,
        ns: string,
        name: string,
        node: string,
        spec: object,
        status: object,
      ) =>
        rows.push({
          id: newId(),
          cluster_id: clusterId,
          source: 'kubernetes',
          kind,
          uid: `${kind}-${ns}-${name}`,
          namespace: ns,
          name,
          node,
          spec_summary: JSON.stringify(spec),
          status_summary: JSON.stringify(status),
        });
      for (let n = 0; n < NODES; n++)
        obj(
          'Node',
          '',
          `node-${n}`,
          `node-${n}`,
          { roles: n < 3 ? ['control-plane'] : [] },
          {
            allocatable: { cpu: '32', memory: '256Gi' },
            conditions: [{ type: 'Ready', status: 'True' }],
            info: { kubelet_version: 'v1.37.0' },
          },
        );
      for (let w = 0; w < 300; w++)
        obj(
          'Deployment',
          `ns-${w % 20}`,
          `app-${w}`,
          '',
          { replicas: 10, containers: [{ name: 'app', image: 'app:1' }] },
          { ready: 10 },
        );
      for (let p = 0; p < NODES * PODS_PER_NODE; p++) {
        const w = p % 300;
        const crash = p % 500 === 0;
        obj(
          'Pod',
          `ns-${w % 20}`,
          `app-${w}-abc-${p}`,
          `node-${p % NODES}`,
          {
            workload: { kind: 'Deployment', name: `app-${w}` },
            containers: [
              { name: 'app', image: 'app:1', requests: { cpu: '100m', memory: '128Mi' } },
            ],
          },
          {
            phase: 'Running',
            containers: [
              crash
                ? {
                    name: 'app',
                    state: 'waiting',
                    reason: 'CrashLoopBackOff',
                    restart_count: 9,
                    last_termination: { reason: 'Error', exit_code: 1 },
                  }
                : { name: 'app', state: 'running', restart_count: 0 },
            ],
          },
        );
      }
      for (let i = 0; i < rows.length; i += 1000)
        await ctx.db
          .insertInto('objects')
          .values(rows.slice(i, i + 1000) as never)
          .execute();
      const events = Array.from({ length: 2000 }, (_, i) => ({
        cluster_id: clusterId,
        day: new Date(NOW).toISOString().slice(0, 10),
        involved_key: `Pod/ns-${i % 20}/app-${i % 300}-abc-${i}`,
        reason: i % 3 ? 'BackOff' : 'Unhealthy',
        namespace: `ns-${i % 20}`,
        involved_kind: 'Pod',
        involved_name: `app-${i % 300}-abc-${i}`,
        involved_uid: `u${i}`,
        type: 'Warning',
        message: `Back-off restarting failed container app in pod app_ns(1d4c5622-c34e-4beb-9c6c-f266104c9d31)`,
        count: 3,
        event_counts: JSON.stringify({}),
        first_ts: new Date(NOW - 50 * 60_000),
        last_ts: new Date(NOW - (i % 50) * 60_000),
      }));
      for (let i = 0; i < events.length; i += 500)
        await ctx.db
          .insertInto('k8s_events')
          .values(events.slice(i, i + 500) as never)
          .execute();
      await ctx.db
        .insertInto('change_markers')
        .values(
          Array.from({ length: 300 }, (_, i) => ({
            id: newId(),
            cluster_id: clusterId,
            kind: 'rollout',
            target: `Deployment/ns-${i % 20}/app-${i}`,
            namespace: `ns-${i % 20}`,
            details: JSON.stringify({ from: 1, to: 2 }),
            ts: new Date(NOW - i * 10_000),
          })) as never,
        )
        .execute();
      void orgId;

      // An hour of series for every node and pod.
      const vm = new VictoriaQueryClient(TEST_VM_URL);
      const write = async (gen: (t: number, i: number) => TestSeries[], count: number) => {
        for (let start = 0; start < count; start += 500) {
          const batch: TestSeries[] = [];
          for (let i = start; i < Math.min(count, start + 500); i++)
            for (let t = NOW - 3600_000; t <= NOW; t += STEP) batch.push(...gen(t, i));
          await vm.write({ clusterId }, encode(batch));
        }
      };
      const s = (labels: Record<string, string>, v: number, t: number): TestSeries => ({
        labels: { run: RUN, ...labels },
        value: v,
        timestampMs: t,
      });
      const k = (t: number) => (t - (NOW - 3600_000)) / 1000;
      await write(
        (t, n) => [
          s(
            {
              __name__: 'watchlog_node_cpu_seconds_total',
              node: `node-${n}`,
              mode: 'user',
              cpu: '0',
            },
            k(t) * 4,
            t,
          ),
          s(
            {
              __name__: 'watchlog_node_cpu_seconds_total',
              node: `node-${n}`,
              mode: 'idle',
              cpu: '0',
            },
            k(t) * 28,
            t,
          ),
          s(
            { __name__: 'watchlog_node_memory_bytes', node: `node-${n}`, state: 'total' },
            256e9,
            t,
          ),
          s(
            { __name__: 'watchlog_node_memory_bytes', node: `node-${n}`, state: 'available' },
            180e9,
            t,
          ),
          s(
            {
              __name__: 'watchlog_node_network_bytes_total',
              node: `node-${n}`,
              dir: 'rx',
              iface: 'eth0',
            },
            k(t) * 1e6,
            t,
          ),
          s(
            {
              __name__: 'watchlog_node_network_bytes_total',
              node: `node-${n}`,
              dir: 'tx',
              iface: 'eth0',
            },
            k(t) * 5e5,
            t,
          ),
          s(
            {
              __name__: 'watchlog_kube_node_condition',
              node: `node-${n}`,
              condition: 'Ready',
              status: 'true',
            },
            1,
            t,
          ),
        ],
        NODES,
      );
      await write((t, p) => {
        const w = p % 300;
        const l = {
          namespace: `ns-${w % 20}`,
          pod: `app-${w}-abc-${p}`,
          workload: `app-${w}`,
          workload_kind: 'Deployment',
        };
        return [
          s({ __name__: 'watchlog_kube_pod_status_phase', phase: 'Running', ...l }, 1, t),
          s(
            { __name__: 'watchlog_container_cpu_seconds_total', container: 'app', ...l },
            k(t) * 0.05,
            t,
          ),
          s(
            { __name__: 'watchlog_container_memory_working_set_bytes', container: 'app', ...l },
            1e8,
            t,
          ),
          s(
            { __name__: 'watchlog_kube_pod_container_restarts_total', container: 'app', ...l },
            p % 500 === 0 ? k(t) / 600 : 0,
            t,
          ),
        ];
      }, NODES * PODS_PER_NODE);
      await fetch(`${TEST_VM_URL}/internal/force_flush`);

      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        const r = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/clusters/${clusterId}/overview?range=3600`,
          cookies: { wl_session: cookie },
        });
        times.push(performance.now() - t0);
        expect(r.statusCode, r.body).toBe(200);
        if (i === 0) {
          const o = r.json();
          expect(o.kpis.nodes.total).toBe(NODES);
          expect(o.kpis.pods.total).toBe(NODES * PODS_PER_NODE);
          expect(o.problems.items.length).toBeGreaterThan(0);
          expect(o.kpis.cpu.usage).toBeGreaterThan(0);
        }
      }
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)]!;
      const p95 = times[Math.floor(times.length * 0.95)]!;
      console.log(
        `overview at ${NODES} nodes / ${NODES * PODS_PER_NODE} pods: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
      );
      expect(p95).toBeLessThan(1500);
    } finally {
      await closeTestContext(ctx);
    }
  });
});
