// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The network's default alert rules (ADR-233), in the org's alert rules list like the core's:
// editable (thresholds, for how long), silenceable, on channels. Each is evaluated for the
// cluster or fleet whose collector polls the device. One story per device (ADR-229): every
// other rule's alert on a device is held back while "Device unreachable" fires for it.
import type { EeAlertRule, EeHost, Observation } from '../../../../backend/src/ee-contract.js';
import { speedText } from './ingest.js';

type Ctx = Parameters<EeAlertRule['evaluator']['evaluate']>[0];
type Cond = { op?: '>' | '<'; value?: number; critical?: number };

interface Dev {
  id: string;
  name: string;
  status: string;
  failures: number;
  uptime_s: string | number | null;
  error: string | null;
  health: {
    cpu?: number | null;
    memUsed?: number | null;
    memTotal?: number | null;
    temperature?: number | null;
    sensors?: { name: string; celsius: number; threshold?: number }[];
    fans?: { name: string; state: string }[];
    psus?: { name: string; state: string }[];
    optics?: {
      port: string;
      rxDbm?: number;
      txDbm?: number;
      rxLow?: number;
      rxHigh?: number;
      txLow?: number;
      txHigh?: number;
    }[];
    stack?: { number: number; role: string; state: string }[];
    stackExpected?: number;
  };
  polled_at: Date | null;
}

export const UNREACHABLE = 'network.device.unreachable';
const MIN = 60;

/** The devices this cluster's or fleet's collectors poll, read once per org cycle. */
function devices(ctx: Ctx): Promise<Dev[]> {
  return ctx.memo(
    `network:devices:${ctx.cluster.id}`,
    () =>
      ctx.db
        .selectFrom('network_devices')
        .select(['id', 'name', 'status', 'failures', 'uptime_s', 'error', 'health', 'polled_at'])
        .where('org_id', '=', ctx.rule.org_id)
        .where('cluster_id', '=', ctx.cluster.id)
        .where('removed_at', 'is', null)
        .execute() as Promise<Dev[]>,
  );
}

/** Ports with a learnt link to another device, or a WatchLog server or node behind them. */
function linkedPorts(ctx: Ctx): Promise<Map<string, { kind: 'device' | 'host'; to: string }>> {
  return ctx.memo(`network:linked:${ctx.rule.org_id}`, async () => {
    const [links, eps, names] = await Promise.all([
      ctx.db
        .selectFrom('network_links')
        .select(['a_device', 'a_port', 'b_device', 'b_port'])
        .where('org_id', '=', ctx.rule.org_id)
        .execute(),
      ctx.db
        .selectFrom('network_endpoints')
        .select(['device_id', 'port', 'node'])
        .where('org_id', '=', ctx.rule.org_id)
        .where('node', 'is not', null)
        .execute(),
      ctx.db
        .selectFrom('network_devices')
        .select(['id', 'name'])
        .where('org_id', '=', ctx.rule.org_id)
        .execute(),
    ]);
    const name = new Map(names.map((n: { id: string; name: string }) => [n.id, n.name]));
    const out = new Map<string, { kind: 'device' | 'host'; to: string }>();
    for (const l of links) {
      out.set(`${l.a_device}/${l.a_port}`, {
        kind: 'device',
        to: `${name.get(l.b_device) ?? ''} · ${l.b_port}`,
      });
      out.set(`${l.b_device}/${l.b_port}`, {
        kind: 'device',
        to: `${name.get(l.a_device) ?? ''} · ${l.a_port}`,
      });
    }
    for (const e of eps)
      if (!out.has(`${e.device_id}/${e.port}`))
        out.set(`${e.device_id}/${e.port}`, { kind: 'host', to: e.node });
    return out;
  });
}

const labels = (d: Dev, port?: string) => ({
  device_id: d.id,
  device: d.name,
  ...(port ? { port } : {}),
});
const sevOf = (v: number, c: Cond, op: '>' | '<' = '>'): 'warning' | 'critical' =>
  c.critical !== undefined && (op === '>' ? v >= c.critical : v <= c.critical)
    ? 'critical'
    : 'warning';
const cond = (ctx: Ctx, def: Cond): Required<Pick<Cond, 'value'>> & Cond =>
  ({ ...def, ...((ctx.rule.condition ?? {}) as Cond) }) as never;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function deviceRule(
  key: string,
  name: string,
  severity: 'warning' | 'critical',
  forSeconds: number,
  check: (ctx: Ctx, d: Dev) => Observation | Observation[] | null,
  extra: Partial<EeAlertRule> = {},
): EeAlertRule {
  return {
    key,
    name,
    severity,
    forSeconds,
    ...extra,
    evaluator: {
      kinds: ['kubernetes', 'server'],
      async evaluate(ctx) {
        const out: Observation[] = [];
        for (const d of await devices(ctx)) {
          const o = check(ctx, d);
          if (o) out.push(...(Array.isArray(o) ? o : [o]));
        }
        return out;
      },
    },
  };
}

/** Rates of the linked ports' counters, by device and port (the org's poller clusters). */
async function portRates(host: EeHost, ctx: Ctx, expr: string): Promise<Map<string, number>> {
  if (!host.victoria) throw new Error('VictoriaMetrics is not configured');
  const rows = await host.victoria.query(
    ctx.rule.org_id,
    [ctx.cluster.id],
    expr,
    Math.floor(ctx.now / 1000),
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = r.points[0]?.[1];
    if (v != null && r.labels.device && r.labels.ifname)
      out.set(`${r.labels.device}/${r.labels.ifname}`, v);
  }
  return out;
}

export function networkRules(host: EeHost): EeAlertRule[] {
  const held = { heldUnder: UNREACHABLE } as Partial<EeAlertRule>;
  return [
    deviceRule(
      UNREACHABLE,
      'Network device unreachable',
      'critical',
      0,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 3 });
        if (!['unreachable', 'error', 'auth_failed'].includes(d.status) || d.failures < c.value)
          return null;
        return {
          fingerprint: `net:${d.id}`,
          severity: 'critical',
          labels: labels(d),
          details: {
            title: `${d.name} is unreachable`,
            why:
              d.status === 'auth_failed'
                ? 'it refused the credentials'
                : `${d.failures} polls in a row failed${d.error ? ` · ${d.error}` : ''}`,
            value: d.failures,
          },
        };
      },
      { condition: { op: '>', value: 3 }, unit: 'count' },
    ),
    deviceRule(
      'network.device.rebooted',
      'Network device rebooted',
      'warning',
      0,
      (_ctx, d) => {
        const up = d.uptime_s == null ? null : Number(d.uptime_s);
        if (d.status !== 'ok' || up === null || up >= 10 * MIN) return null;
        return {
          fingerprint: `net:${d.id}:reboot`,
          severity: 'warning',
          labels: labels(d),
          details: {
            title: `${d.name} rebooted`,
            why: `up ${Math.max(1, Math.round(up / 60))} min`,
            value: up,
          },
        };
      },
      held,
    ),
    {
      key: 'network.uplink.down',
      name: 'Uplink down',
      severity: 'critical',
      forSeconds: 0,
      heldUnder: UNREACHABLE,
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const devs = (await devices(ctx)).filter((d) => d.status === 'ok');
          if (!devs.length) return [];
          const linked = await linkedPorts(ctx);
          const down = await ctx.db
            .selectFrom('network_interfaces')
            .select(['device_id', 'name', 'changed_at'])
            .where(
              'device_id',
              'in',
              devs.map((d) => d.id),
            )
            .where('admin_up', '=', true)
            .where('oper_up', '=', false)
            .execute();
          const byId = new Map(devs.map((d) => [d.id, d]));
          return down.flatMap((i: { device_id: string; name: string; changed_at: Date | null }) => {
            const l = linked.get(`${i.device_id}/${i.name}`);
            const d = byId.get(i.device_id);
            if (!l || !d) return [];
            return [
              {
                fingerprint: `net:${d.id}/${i.name}:down`,
                severity: 'critical' as const,
                labels: labels(d, i.name),
                details: {
                  title: `${d.name} · ${i.name} is down`,
                  why: l.kind === 'host' ? `${l.to} is behind it` : `the link to ${l.to}`,
                },
                ...(i.changed_at ? { since: new Date(i.changed_at).getTime() } : {}),
              },
            ];
          });
        },
      },
    },
    {
      key: 'network.port.errors',
      name: 'Port errors',
      severity: 'warning',
      forSeconds: 10 * MIN,
      heldUnder: UNREACHABLE,
      condition: { op: '>', value: 1 },
      unit: 'count',
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const devs = await devices(ctx);
          if (!devs.length) return [];
          const c = cond(ctx, { op: '>', value: 1 });
          // Errors and discards per minute (CRC errors are input errors).
          const rates = await portRates(
            host,
            ctx,
            'sum by (device, ifname) (rate(watchlog_net_if_in_errors_total[5m]) + rate(watchlog_net_if_out_errors_total[5m]) + rate(watchlog_net_if_in_discards_total[5m]) + rate(watchlog_net_if_out_discards_total[5m])) * 60',
          );
          const byId = new Map(devs.map((d) => [d.id, d]));
          const out: Observation[] = [];
          for (const [k, v] of rates) {
            const [id, ...port] = k.split('/');
            const d = byId.get(id!);
            if (!d || !(v > c.value)) continue;
            const p = port.join('/');
            out.push({
              fingerprint: `net:${d.id}/${p}:errors`,
              severity: sevOf(v, c),
              labels: labels(d, p),
              details: {
                title: `${d.name} · ${p} has errors`,
                why: `${Math.round(v)} errors or discards a minute`,
                value: v,
                threshold: c.value,
              },
            });
          }
          return out;
        },
      },
    },
    {
      key: 'network.port.speed_dropped',
      name: 'Port speed dropped',
      severity: 'warning',
      forSeconds: 5 * MIN,
      heldUnder: UNREACHABLE,
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const devs = (await devices(ctx)).filter((d) => d.status === 'ok');
          if (!devs.length) return [];
          const linked = await linkedPorts(ctx);
          const rows = await ctx.db
            .selectFrom('network_interfaces')
            .select(['device_id', 'name', 'speed_mbps', 'usual_speed_mbps'])
            .where(
              'device_id',
              'in',
              devs.map((d) => d.id),
            )
            .where('oper_up', '=', true)
            .where(host.sql<boolean>`speed_mbps < usual_speed_mbps`)
            .execute();
          const byId = new Map(devs.map((d) => [d.id, d]));
          return rows.flatMap(
            (i: {
              device_id: string;
              name: string;
              speed_mbps: string;
              usual_speed_mbps: string;
            }) => {
              const d = byId.get(i.device_id);
              if (!d || !linked.has(`${i.device_id}/${i.name}`)) return [];
              return [
                {
                  fingerprint: `net:${d.id}/${i.name}:speed`,
                  severity: 'warning' as const,
                  labels: labels(d, i.name),
                  details: {
                    title: `${d.name} · ${i.name} runs slower than usual`,
                    why: `${speedText(Number(i.speed_mbps))}, usually ${speedText(Number(i.usual_speed_mbps))}`,
                    value: Number(i.speed_mbps),
                  },
                },
              ];
            },
          );
        },
      },
    },
    {
      key: 'network.link.busy',
      name: 'Link busy',
      severity: 'warning',
      forSeconds: 10 * MIN,
      heldUnder: UNREACHABLE,
      condition: { op: '>', value: 0.9 },
      unit: 'ratio',
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const devs = (await devices(ctx)).filter((d) => d.status === 'ok');
          if (!devs.length) return [];
          const c = cond(ctx, { op: '>', value: 0.9 });
          const linked = await linkedPorts(ctx);
          const [inR, outR, speeds] = await Promise.all([
            portRates(
              host,
              ctx,
              'max by (device, ifname) (rate(watchlog_net_if_in_bytes_total[5m])) * 8',
            ),
            portRates(
              host,
              ctx,
              'max by (device, ifname) (rate(watchlog_net_if_out_bytes_total[5m])) * 8',
            ),
            ctx.db
              .selectFrom('network_interfaces')
              .select(['device_id', 'name', 'speed_mbps'])
              .where(
                'device_id',
                'in',
                devs.map((d) => d.id),
              )
              .where('oper_up', '=', true)
              .execute(),
          ]);
          const byId = new Map(devs.map((d) => [d.id, d]));
          const out: Observation[] = [];
          for (const i of speeds as {
            device_id: string;
            name: string;
            speed_mbps: string | null;
          }[]) {
            const k = `${i.device_id}/${i.name}`;
            const bps = Number(i.speed_mbps ?? 0) * 1e6;
            const d = byId.get(i.device_id);
            if (!d || !bps || !linked.has(k)) continue;
            const u = Math.max((inR.get(k) ?? 0) / bps, (outR.get(k) ?? 0) / bps);
            if (!(u > c.value)) continue;
            const dir = (inR.get(k) ?? 0) >= (outR.get(k) ?? 0) ? 'in' : 'out';
            out.push({
              fingerprint: `net:${d.id}/${i.name}:busy`,
              severity: sevOf(u, c),
              labels: labels(d, i.name),
              details: {
                title: `${d.name} · ${i.name} is busy`,
                why: `${pct(u)} of ${speedText(Number(i.speed_mbps))} ${dir}`,
                value: u,
                threshold: c.value,
              },
            });
          }
          return out;
        },
      },
    },
    deviceRule(
      'network.device.cpu',
      'Network device CPU high',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 0.9 });
        const v = d.health.cpu;
        if (d.status !== 'ok' || v == null || !(v > c.value)) return null;
        return {
          fingerprint: `net:${d.id}:cpu`,
          severity: sevOf(v, c),
          labels: labels(d),
          details: {
            title: `${d.name}'s CPU is high`,
            why: `${pct(v)} (threshold ${pct(c.value)})`,
            value: v,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '>', value: 0.9 }, unit: 'ratio' },
    ),
    deviceRule(
      'network.device.memory',
      'Network device memory high',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 0.9 });
        const { memUsed: u, memTotal: t } = d.health;
        if (d.status !== 'ok' || u == null || !t) return null;
        const v = u / t;
        if (!(v > c.value)) return null;
        return {
          fingerprint: `net:${d.id}:memory`,
          severity: sevOf(v, c),
          labels: labels(d),
          details: {
            title: `${d.name}'s memory is nearly full`,
            why: `${pct(v)} used (threshold ${pct(c.value)})`,
            value: v,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '>', value: 0.9 }, unit: 'ratio' },
    ),
    deviceRule(
      'network.device.temperature',
      'Network device too hot',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 70, critical: 80 });
        if (d.status !== 'ok') return null;
        // A sensor over its own threshold, else the hottest over the rule's.
        const over = (d.health.sensors ?? []).find((s) => s.threshold && s.celsius >= s.threshold);
        const v = over?.celsius ?? d.health.temperature;
        if (v == null || (!over && !(v > c.value))) return null;
        return {
          fingerprint: `net:${d.id}:temperature`,
          severity: over ? 'critical' : sevOf(v, c),
          labels: labels(d),
          details: {
            title: `${d.name} is too hot`,
            why: over
              ? `${over.name} ${v} °C, its limit ${over.threshold} °C`
              : `${v} °C (threshold ${c.value} °C)`,
            value: v,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '>', value: 70, critical: 80 }, unit: 'count' },
    ),
    deviceRule(
      'network.device.hardware',
      'Fan or power supply failed',
      'critical',
      0,
      (_ctx, d) => {
        if (d.status !== 'ok') return null;
        const bad = [
          ...(d.health.fans ?? []).map((f) => ({ ...f, what: 'fan' })),
          ...(d.health.psus ?? []).map((p) => ({ ...p, what: 'power supply' })),
        ].filter((c) => c.state === 'failed' || c.state === 'critical' || c.state === 'warning');
        return bad.map((b) => ({
          fingerprint: `net:${d.id}:hw:${b.name}`,
          severity: b.state === 'warning' ? ('warning' as const) : ('critical' as const),
          labels: { ...labels(d), component: b.name },
          details: {
            title: `A ${b.what} of ${d.name} ${b.state === 'warning' ? 'warns' : 'failed'}`,
            why: `${b.name}: ${b.state}`,
          },
        }));
      },
      held,
    ),
    deviceRule(
      'network.port.optics',
      'SFP optics out of range',
      'warning',
      5 * MIN,
      (_ctx, d) => {
        if (d.status !== 'ok') return null;
        const out: Observation[] = [];
        for (const o of d.health.optics ?? []) {
          const bad: string[] = [];
          if (o.rxDbm != null && o.rxLow != null && o.rxDbm < o.rxLow)
            bad.push(`rx ${o.rxDbm} dBm, below ${o.rxLow}`);
          if (o.rxDbm != null && o.rxHigh != null && o.rxDbm > o.rxHigh)
            bad.push(`rx ${o.rxDbm} dBm, above ${o.rxHigh}`);
          if (o.txDbm != null && o.txLow != null && o.txDbm < o.txLow)
            bad.push(`tx ${o.txDbm} dBm, below ${o.txLow}`);
          if (o.txDbm != null && o.txHigh != null && o.txDbm > o.txHigh)
            bad.push(`tx ${o.txDbm} dBm, above ${o.txHigh}`);
          if (bad.length)
            out.push({
              fingerprint: `net:${d.id}/${o.port}:optics`,
              severity: 'warning',
              labels: labels(d, o.port),
              details: {
                title: `The optics of ${d.name} · ${o.port} are out of range`,
                why: bad.join(' · '),
              },
            });
        }
        return out;
      },
      held,
    ),
    deviceRule(
      'network.stack.member_lost',
      'Stack member lost',
      'critical',
      0,
      (_ctx, d) => {
        const s = d.health.stack ?? [];
        const expected = d.health.stackExpected ?? 0;
        if (d.status !== 'ok' || expected < 2) return null;
        const notReady = s.filter((m) => m.state !== 'ready');
        if (s.length >= expected && !notReady.length) return null;
        return {
          fingerprint: `net:${d.id}:stack`,
          severity: 'critical',
          labels: labels(d),
          details: {
            title: `${d.name} lost a stack member`,
            why: notReady.length
              ? notReady.map((m) => `switch ${m.number}: ${m.state}`).join(' · ')
              : `${s.length} of ${expected} switches`,
          },
        };
      },
      held,
    ),
    deviceRule(
      'network.device.cert_changed',
      'Certificate changed on a RouterOS device',
      'critical',
      0,
      (_ctx, d) => {
        if (d.status !== 'cert_changed') return null;
        return {
          fingerprint: `net:${d.id}:cert`,
          severity: 'critical',
          labels: labels(d),
          details: {
            title: `${d.name}'s certificate changed`,
            why: "it isn't polled until an Owner accepts the new certificate on its page",
          },
        };
      },
    ),
  ];
}
