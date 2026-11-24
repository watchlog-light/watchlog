// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The 0.17 kinds' default alert rules (ADR-234): Wi-Fi, storage, recording and UPSes. Like the
// 0.16 rules: editable, silenceable, one story per device (each waits under its device's
// "unreachable"). "Not recording" is the one that matters most: it fires only after a signal
// has failed for 5 minutes, and a camera going offline is never part of it.
import type { EeAlertRule, EeHost, Observation } from '../../../../backend/src/ee-contract.js';
import {
  cond,
  deviceRule,
  devices,
  labels,
  MIN,
  pct,
  sevOf,
  UNREACHABLE,
  type Ctx,
  type Dev,
} from './alerts.js';
import { smartState, volumeState, WEAK_DBM, type CameraState } from './kinds.js';
import { notRecordingWhy, type RecordingState } from './recording.js';
import type { NAS, Radio, RecorderDisk, UPS } from './report.js';

export const RECORDER_ISCSI_LOST = 'network.recorder.iscsi_lost';
/** An AP with no clients alerts only where it usually has at least this many at this hour. */
export const USUAL_CLIENTS_MIN = 3;
/** Many weak clients: at least this share of the AP's clients, besides the count. */
export const WEAK_SHARE = 0.4;

function kindRule(
  kind: string,
  key: string,
  name: string,
  severity: 'warning' | 'critical',
  forSeconds: number,
  check: (ctx: Ctx, d: Dev) => Observation | Observation[] | null,
  extra: Partial<EeAlertRule> = {},
): EeAlertRule {
  return deviceRule(
    key,
    name,
    severity,
    forSeconds,
    (ctx, d) => (d.kind === kind && d.status === 'ok' ? check(ctx, d) : null),
    extra,
  );
}

/** The 2.4 GHz channel of a radio, or null on another band. */
export function channel24(r: Radio): number | null {
  const f = r.frequencyMhz ?? 0;
  const on24 = (r.band ?? '').startsWith('2ghz') || (f >= 2400 && f < 2500);
  if (!on24) return null;
  if (r.channel) return r.channel;
  if (f === 2484) return 14;
  return f ? Math.round((f - 2407) / 5) : null;
}

/** Pairs of access points of one controller whose 2.4 GHz channels overlap (1–4 apart). */
export function overlaps<
  T extends { id: string; name: string; parent: string | null; radios: Radio[] },
>(aps: T[]): { a: T; b: T; ca: number; cb: number }[] {
  const out: { a: T; b: T; ca: number; cb: number }[] = [];
  const sorted = [...aps].sort((x, y) => x.name.localeCompare(y.name));
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.parent !== b.parent) continue;
      for (const ra of a.radios) {
        const ca = channel24(ra);
        if (ca === null) continue;
        const rb = b.radios.find((r) => {
          const cb = channel24(r);
          return cb !== null && cb !== ca && Math.abs(cb - ca) < 5;
        });
        if (rb) {
          out.push({ a, b, ca, cb: channel24(rb)! });
          break;
        }
      }
    }
  return out;
}

type ApHealth = { ap?: { radios?: Radio[]; clients?: number; state?: string } };
type NasHealth = { nas?: NAS };
type UpsHealth = { ups?: UPS };
type RecHealth = {
  recorder?: {
    disks?: RecorderDisk[];
    cameras?: CameraState[];
    daysLeft?: number | null;
    full?: boolean;
  };
};
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function kindRules(host: EeHost): EeAlertRule[] {
  // Read here, not at the module's top: alerts.ts imports this file (a cycle).
  const held = { heldUnder: UNREACHABLE } as Partial<EeAlertRule>;
  return [
    // ------------------------------------------------------------ Wi-Fi
    {
      key: 'network.ap.disconnected',
      name: 'Access point disconnected',
      severity: 'warning',
      forSeconds: 2 * MIN,
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          return (await devices(ctx))
            .filter((d) => d.kind === 'ap' && d.status !== 'ok')
            .map((d) => ({
              fingerprint: `net:${d.id}:ap`,
              severity: 'warning' as const,
              labels: labels(d),
              details: {
                title: `${d.name} is disconnected from CAPsMAN`,
                why:
                  d.status === 'provisioning'
                    ? 'its provisioning failed'
                    : 'its controller no longer lists it',
              },
              ...(d.status_since ? { since: new Date(d.status_since).getTime() } : {}),
            }));
        },
      },
    },
    {
      key: 'network.ap.no_clients',
      name: 'Access point has no clients',
      severity: 'warning',
      forSeconds: 15 * MIN,
      condition: { op: '>', value: USUAL_CLIENTS_MIN },
      unit: 'count',
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const c = cond(ctx, { op: '>', value: USUAL_CLIENTS_MIN });
          const out: Observation[] = [];
          for (const d of await devices(ctx)) {
            const h = d.health as ApHealth;
            if (d.kind !== 'ap' || d.status !== 'ok' || !d.parent_id || (h.ap?.clients ?? 0) > 0)
              continue;
            // What changed's baseline (ADR-196): this hour of the week over 14 days.
            const expr = `sum(watchlog_net_wifi_clients{device="${esc(d.parent_id)}",ap="${esc(d.name)}"})`;
            const [band] = await host.baseline.bands(
              ctx.rule.org_id,
              [ctx.cluster.id],
              expr,
              ctx.now,
              ctx.now,
              'count',
            );
            if (!band || band.learning || band.median < c.value) continue;
            out.push({
              fingerprint: `net:${d.id}:noclients`,
              severity: 'warning',
              labels: labels(d),
              details: {
                title: `${d.name} has no clients`,
                why: `it usually has ${Math.round(band.median)} at this time of the week`,
                value: 0,
                threshold: c.value,
              },
            });
          }
          return out;
        },
      },
    },
    {
      key: 'network.ap.weak_clients',
      name: 'Many weak Wi-Fi clients',
      severity: 'warning',
      forSeconds: 10 * MIN,
      condition: { op: '>', value: 5 },
      unit: 'count',
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const aps = (await devices(ctx)).filter((d) => d.kind === 'ap' && d.status === 'ok');
          if (!aps.length) return [];
          const c = cond(ctx, { op: '>', value: 5 });
          const rows = await ctx.db
            .selectFrom('network_wifi_clients')
            .select([
              'ap_id',
              ctx.db.fn.countAll().as('n'),
              host.sql<number>`count(*) filter (where signal_dbm < ${WEAK_DBM})`.as('weak'),
            ])
            .where('org_id', '=', ctx.rule.org_id)
            .where(
              'ap_id',
              'in',
              aps.map((a) => a.id),
            )
            .groupBy('ap_id')
            .execute();
          const byId = new Map(aps.map((a) => [a.id, a]));
          const out: Observation[] = [];
          for (const r of rows as { ap_id: string; n: string | number; weak: string | number }[]) {
            const d = byId.get(r.ap_id);
            const n = Number(r.n);
            const weak = Number(r.weak);
            if (!d || weak < c.value || weak < WEAK_SHARE * n) continue;
            out.push({
              fingerprint: `net:${d.id}:weak`,
              severity: 'warning',
              labels: labels(d),
              details: {
                title: `${d.name} has many weak clients`,
                why: `${weak} of ${n} clients below ${WEAK_DBM} dBm`,
                value: weak,
                threshold: c.value,
              },
            });
          }
          return out;
        },
      },
    },
    {
      key: 'network.ap.channel_overlap',
      name: 'Wi-Fi channels overlap (2.4 GHz)',
      severity: 'warning',
      forSeconds: 10 * MIN,
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const aps = (await devices(ctx))
            .filter((d) => d.kind === 'ap' && d.status === 'ok')
            .map((d) => ({
              id: d.id,
              name: d.name,
              parent: d.parent_id,
              radios: (d.health as ApHealth).ap?.radios ?? [],
              dev: d,
            }));
          return overlaps(aps).map(({ a, b, ca, cb }) => ({
            fingerprint: `net:${a.id}:${b.id}:overlap`,
            severity: 'warning' as const,
            labels: { ...labels(b.dev), other: a.name },
            details: {
              title: `${a.name} and ${b.name} overlap on 2.4 GHz`,
              why: `channels ${ca} and ${cb}: use 1, 6 and 11`,
            },
          }));
        },
      },
    },

    // ------------------------------------------------------------ Storage (a NAS)
    kindRule(
      'nas',
      'network.nas.disk_smart',
      'NAS disk SMART not good',
      'warning',
      0,
      (_ctx, d) =>
        ((d.health as NasHealth).nas?.disks ?? []).flatMap((k) => {
          const s = smartState(k.smart);
          if (s === 'good' || s === 'unknown') return [];
          return [
            {
              fingerprint: `net:${d.id}:disk:${k.index}:smart`,
              severity: s === 'bad' ? ('critical' as const) : ('warning' as const),
              labels: { ...labels(d), disk: k.name || String(k.index) },
              details: {
                title: `A disk of ${d.name} reports SMART ${k.smart}`,
                why: `${k.name || `disk ${k.index}`}${k.model ? ` · ${k.model}` : ''}`,
              },
            },
          ];
        }),
      held,
    ),
    kindRule(
      'nas',
      'network.nas.disk_hot',
      'NAS disk hot',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 55, critical: 60 });
        return ((d.health as NasHealth).nas?.disks ?? []).flatMap((k) =>
          k.celsius != null && k.celsius > c.value
            ? [
                {
                  fingerprint: `net:${d.id}:disk:${k.index}:hot`,
                  severity: sevOf(k.celsius, c),
                  labels: { ...labels(d), disk: k.name || String(k.index) },
                  details: {
                    title: `A disk of ${d.name} is hot`,
                    why: `${k.name || `disk ${k.index}`} at ${k.celsius} °C (threshold ${c.value} °C)`,
                    value: k.celsius,
                    threshold: c.value,
                  },
                },
              ]
            : [],
        );
      },
      { ...held, condition: { op: '>', value: 55, critical: 60 }, unit: 'count' },
    ),
    kindRule(
      'nas',
      'network.nas.raid',
      'NAS RAID degraded or rebuilding',
      'critical',
      0,
      (_ctx, d) => {
        const nas = (d.health as NasHealth).nas;
        return [...(nas?.pools ?? []), ...(nas?.volumes ?? [])].flatMap((v) => {
          const st = volumeState(v.status);
          if (st === 'ready' || st === 'other') return [];
          return [
            {
              fingerprint: `net:${d.id}:raid:${v.name}`,
              severity: st === 'rebuilding' ? ('warning' as const) : ('critical' as const),
              labels: { ...labels(d), volume: v.name },
              details: {
                title: `${d.name} · ${v.name} is ${st === 'error' ? 'failing' : st}`,
                why: `${v.raid ? `${v.raid}, ` : ''}the NAS says ${v.status}`,
              },
            },
          ];
        });
      },
      held,
    ),
    kindRule(
      'nas',
      'network.nas.volume_full',
      'NAS volume or LUN over 90%',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 0.9, critical: 0.95 });
        const nas = (d.health as NasHealth).nas;
        const out: Observation[] = [];
        for (const v of nas?.volumes ?? []) {
          if (!v.total) continue;
          const u = 1 - v.free / v.total;
          if (u > c.value)
            out.push({
              fingerprint: `net:${d.id}:vol:${v.name}:full`,
              severity: sevOf(u, c),
              labels: { ...labels(d), volume: v.name },
              details: {
                title: `${d.name} · ${v.name} is ${pct(u)} full`,
                why: `threshold ${pct(c.value)}`,
                value: u,
                threshold: c.value,
              },
            });
        }
        for (const l of nas?.luns ?? []) {
          if (l.usedPercent == null) continue;
          const u = l.usedPercent / 100;
          if (u > c.value)
            out.push({
              fingerprint: `net:${d.id}:lun:${l.name}:full`,
              severity: sevOf(u, c),
              labels: { ...labels(d), lun: l.name },
              details: {
                title: `The LUN ${l.name} on ${d.name} is ${pct(u)} full`,
                why: `threshold ${pct(c.value)}`,
                value: u,
                threshold: c.value,
              },
            });
        }
        return out;
      },
      { ...held, condition: { op: '>', value: 0.9, critical: 0.95 }, unit: 'ratio' },
    ),
    {
      key: 'network.iscsi.session_lost',
      name: 'iSCSI session lost',
      severity: 'critical',
      forSeconds: 2 * MIN,
      // The recorder's own "iSCSI disk lost" says it first; this one tells what only the NAS saw.
      heldUnder: RECORDER_ISCSI_LOST,
      evaluator: {
        kinds: ['kubernetes', 'server'],
        async evaluate(ctx) {
          const recs = (await devices(ctx)).filter((d) => d.kind === 'nvr');
          if (!recs.length) return [];
          const sessions = await ctx.db
            .selectFrom('network_iscsi_sessions as s')
            .leftJoin('network_devices as n', 'n.id', 's.nas_id')
            .select([
              's.recorder_id',
              's.disk',
              's.lun',
              's.target',
              's.connected',
              's.lost_at',
              'n.name as nas',
              'n.health as nas_health',
              'n.status as nas_status',
            ])
            .where('s.org_id', '=', ctx.rule.org_id)
            .where(
              's.recorder_id',
              'in',
              recs.map((r) => r.id),
            )
            .execute();
          const byId = new Map(recs.map((r) => [r.id, r]));
          const out: Observation[] = [];
          for (const s of sessions as any[]) {
            const d = byId.get(s.recorder_id);
            if (!d || d.status !== 'ok') continue;
            const target = s.target
              ? ((s.nas_health?.nas?.targets ?? []) as { name: string; connected: boolean }[]).find(
                  (t) => t.name === s.target,
                )
              : undefined;
            const nasSays = s.nas_status === 'ok' && target && !target.connected;
            if (s.connected && !nasSays) continue;
            out.push({
              fingerprint: `net:${d.id}:iscsi:${s.disk}`,
              severity: 'critical',
              labels: { ...labels(d), disk: s.disk, ...(s.nas ? { nas: s.nas } : {}) },
              details: {
                title: `${d.name}'s iSCSI session${s.nas ? ` to ${s.nas}` : ''} is lost`,
                why: !s.connected
                  ? `seen from the recorder: ${s.disk}${s.lun ? ` (${s.lun})` : ''} is gone`
                  : `seen from the NAS: the target ${s.target} has no session`,
              },
              ...(s.lost_at ? { since: new Date(s.lost_at).getTime() } : {}),
            });
          }
          return out;
        },
      },
    },

    // ------------------------------------------------------------ Recording
    kindRule(
      'nvr',
      'network.recorder.not_recording',
      'Recorder not recording',
      'critical',
      0,
      (_ctx, d) => {
        const r = d.recording as RecordingState | null;
        if (!r || r.recording !== false) return null;
        return {
          fingerprint: `net:${d.id}:recording`,
          severity: 'critical',
          labels: { ...labels(d), signal: r.failed.join(',') },
          details: { title: `${d.name} is not recording`, why: notRecordingWhy(r) },
          ...(r.since ? { since: r.since } : {}),
        };
      },
      held,
    ),
    kindRule(
      'nvr',
      RECORDER_ISCSI_LOST,
      'Recorder lost its iSCSI disk',
      'critical',
      MIN,
      (_ctx, d) => {
        const r = d.recording as RecordingState | null;
        const s = r?.signals?.disk;
        if (!s || s.ok !== false) return null;
        return {
          fingerprint: `net:${d.id}:iscsidisk`,
          severity: 'critical',
          labels: labels(d),
          details: { title: `${d.name} lost its iSCSI disk`, why: s.why },
          ...(s.since ? { since: s.since } : {}),
        };
      },
      held,
    ),
    kindRule(
      'nvr',
      'network.recorder.full_soon',
      'Recorder storage full soon',
      'warning',
      10 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '<', value: 3, critical: 1 });
        const days = (d.health as RecHealth).recorder?.daysLeft;
        if (days == null || !(days < c.value)) return null;
        return {
          fingerprint: `net:${d.id}:full`,
          severity: sevOf(days, c, '<'),
          labels: labels(d),
          details: {
            title: `${d.name}'s storage is full in ${days < 1 ? `${Math.max(1, Math.round(days * 24))} h` : `${days.toFixed(1)} days`}`,
            why: `at the current write rate (threshold ${c.value} days)`,
            value: days,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '<', value: 3, critical: 1 }, unit: 'count' },
    ),
    kindRule(
      'nvr',
      'network.recorder.camera_offline',
      'Camera offline',
      'warning',
      0,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 5 * MIN });
        const off = ((d.health as RecHealth).recorder?.cameras ?? []).filter(
          (k) => !k.online && ctx.now - k.since >= c.value * 1000,
        );
        if (!off.length) return null;
        // One alert per recorder, its cameras listed: grouped, never one per camera.
        return {
          fingerprint: `net:${d.id}:cameras`,
          severity: 'warning',
          labels: labels(d),
          details: {
            title:
              off.length === 1
                ? `${d.name}: camera ${off[0]!.name} is offline`
                : `${d.name}: ${off.length} cameras are offline`,
            why:
              off
                .slice(0, 8)
                .map((k) => `${k.name} (channel ${k.channel + 1})`)
                .join(', ') + (off.length > 8 ? ` and ${off.length - 8} more` : ''),
            value: off.length,
          },
          since: Math.min(...off.map((k) => k.since)),
        };
      },
      { ...held, condition: { op: '>', value: 5 * MIN }, unit: 'seconds' },
    ),

    // ------------------------------------------------------------ UPSes
    kindRule(
      'ups',
      'network.ups.on_battery',
      'UPS on battery',
      'critical',
      0,
      (_ctx, d) => {
        const u = (d.health as UpsHealth).ups;
        if (!u || u.status !== 'on-battery') return null;
        return {
          fingerprint: `net:${d.id}:battery`,
          severity: 'critical',
          labels: labels(d),
          details: {
            title: `${d.name} is on battery`,
            why:
              [
                u.chargePercent != null ? `${Math.round(u.chargePercent)}% charge` : '',
                u.runtimeS != null ? `${Math.round(u.runtimeS / 60)} min left` : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'mains power is lost',
          },
        };
      },
      held,
    ),
    kindRule(
      'ups',
      'network.ups.runtime_low',
      'UPS runtime low',
      'critical',
      0,
      (ctx, d) => {
        const c = cond(ctx, { op: '<', value: 600 });
        const u = (d.health as UpsHealth).ups;
        if (u?.runtimeS == null || !(u.runtimeS < c.value)) return null;
        return {
          fingerprint: `net:${d.id}:runtime`,
          severity: 'critical',
          labels: labels(d),
          details: {
            title: `${d.name} has ${Math.round(u.runtimeS / 60)} min of battery`,
            why: `under ${Math.round(c.value / 60)} min${u.status === 'on-battery' ? ', on battery' : ''}`,
            value: u.runtimeS,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '<', value: 600 }, unit: 'seconds' },
    ),
    kindRule(
      'ups',
      'network.ups.replace_battery',
      'UPS battery needs replacing',
      'warning',
      0,
      (_ctx, d) => {
        const u = (d.health as UpsHealth).ups;
        if (!u?.replaceBattery) return null;
        return {
          fingerprint: `net:${d.id}:replace`,
          severity: 'warning',
          labels: labels(d),
          details: { title: `${d.name}'s battery needs replacing`, why: 'the UPS reports it' },
        };
      },
      held,
    ),
    kindRule(
      'ups',
      'network.ups.overload',
      'UPS overload',
      'warning',
      2 * MIN,
      (ctx, d) => {
        const c = cond(ctx, { op: '>', value: 0.9, critical: 1 });
        const u = (d.health as UpsHealth).ups;
        if (u?.loadPercent == null) return null;
        const v = u.loadPercent / 100;
        if (!(v > c.value)) return null;
        return {
          fingerprint: `net:${d.id}:overload`,
          severity: sevOf(v, c),
          labels: labels(d),
          details: {
            title: `${d.name} is overloaded`,
            why: `${pct(v)} load (threshold ${pct(c.value)})`,
            value: v,
            threshold: c.value,
          },
        };
      },
      { ...held, condition: { op: '>', value: 0.9, critical: 1 }, unit: 'ratio' },
    ),
  ];
}
