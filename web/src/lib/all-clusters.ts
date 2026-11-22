// SPDX-License-Identifier: AGPL-3.0-only
// "All clusters and fleets" (ADR-226): the page's words and shapes, from GET /overview/all.
// Pure functions, so the status sentence, the tiles, the kind lines and the links are tested
// without mounting the page.
import type {
  AllClusters,
  AllClustersChange,
  AllClustersProblem,
  AllClustersRow,
} from '@watchlog/api-types';
import type { RouteLocationRaw } from 'vue-router';
import { ApiError } from '@/api/client';
import { serviceName } from '@/lib/applications';
import { metricText, objectName, rangeText, valueText } from '@/lib/what-changed';

export type Tr = (key: string, values?: Record<string, unknown>) => string;
export type Access = 'pro' | 'free' | 'community';
export type Kind = 'all' | 'kubernetes' | 'server';
export type Tone = 'critical' | 'warning' | 'healthy' | 'muted';

/** The ranges the page offers, in seconds, with their labels. */
export const RANGES: { seconds: number; label: string }[] = [
  { seconds: 3600, label: '1h' },
  { seconds: 21_600, label: '6h' },
  { seconds: 86_400, label: '24h' },
  { seconds: 604_800, label: '7d' },
  { seconds: 2_592_000, label: '30d' },
];
export const DEFAULT_RANGE = 86_400;

/** Community asks nothing (the route isn't there); Cloud and the demo ask; 403 means Free. */
export function initialAccess(isCloud: boolean, demo: boolean): Access | null {
  return isCloud || demo ? null : 'community';
}

/** A 403 `pro-feature`: the org has no Pro. */
export const isProFeature = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.status === 403 &&
  err.problem?.type === 'urn:watchlog:problem:pro-feature';

/** The request for the page. */
export const allClustersPath = (range: number, kind: Kind) =>
  `/overview/all?range=${range}&kind=${kind}`;

/** Whether a cluster or fleet has an open problem: critical or warning. */
export const needsAttention = (r: Pick<AllClustersRow, 'status'>) =>
  r.status === 'critical' || r.status === 'warning';

export const toneOf = (status: AllClustersRow['status']): Tone =>
  status === 'waiting' ? 'muted' : status;

/** Nodes (Kubernetes) and servers (fleets), in the page's words: "30 nodes and servers". */
export function hostsText(s: Pick<AllClusters, 'hosts' | 'counts'>, kind: Kind, tr: Tr): string {
  if (kind === 'kubernetes') return tr('allClusters.hosts.nodes', { n: s.hosts.nodes });
  if (kind === 'server') return tr('allClusters.hosts.servers', { n: s.hosts.servers });
  return tr('allClusters.hosts.both', { n: s.hosts.nodes + s.hosts.servers });
}

/** The header's line: "3 Kubernetes clusters · 3 server fleets · 30 nodes and servers". */
export function headerLine(s: Pick<AllClusters, 'hosts' | 'counts'>, tr: Tr): string {
  return [
    tr('allClusters.header.kubernetes', { n: s.counts.kubernetes }),
    tr('allClusters.header.fleets', { n: s.counts.server }),
    hostsText(s, 'all', tr),
  ].join(' · ');
}

/**
 * The status sentence and its second line. Something needs attention: how many, then what
 * stands out: a problem shared by several clusters or fleets, then one with a silent node or
 * server, else the worst one's first problem. Everything healthy: all N, and the hosts
 * reporting.
 */
export function hero(
  s: Pick<AllClusters, 'clusters' | 'problems' | 'hosts' | 'counts' | 'whatChanged'>,
  kind: Kind,
  tr: Tr,
): { healthy: boolean; title: string; sub: string } {
  const bad = s.clusters.filter(needsAttention);
  const n = s.clusters.length;
  if (bad.length === 0) {
    const reporting = s.clusters.reduce((x, c) => x + c.reporting.live, 0);
    return {
      healthy: true,
      title: n === 1 ? tr('allClusters.hero.oneHealthy') : tr('allClusters.hero.allHealthy', { n }),
      sub: [
        tr(
          kind === 'kubernetes'
            ? 'allClusters.hero.reportingNodes'
            : kind === 'server'
              ? 'allClusters.hero.reportingServers'
              : 'allClusters.hero.reporting',
          { n: reporting },
        ),
        s.whatChanged.rows.length
          ? tr('allClusters.hero.changes', { n: s.whatChanged.total })
          : tr('allClusters.hero.usual'),
      ].join(' · '),
    };
  }
  // The second line (ADR-226 as amended by ADR-227): how they split, then the worst thing.
  const crit = bad.filter((c) => c.status === 'critical').length;
  const notes: string[] = [
    tr('allClusters.hero.split', { critical: crit, warning: bad.length - crit }),
  ];
  const shared = s.problems.find((p) => p.places.length > 1);
  const silent = s.clusters.find((c) => c.reporting.live < c.reporting.total);
  if (shared) {
    const names = shared.places.map((p) => p.cluster.name);
    notes.push(
      names.length === 2
        ? tr('allClusters.hero.shareTwo', { a: names[0], b: names[1] })
        : tr('allClusters.hero.shareMany', { a: names[0], n: names.length - 1 }),
    );
  } else if (silent) {
    notes.push(
      tr(
        silent.kind === 'server' ? 'allClusters.hero.silentServer' : 'allClusters.hero.silentNode',
        {
          name: silent.name,
          n: silent.reporting.total - silent.reporting.live,
        },
      ),
    );
  } else if (s.problems[0]) {
    const worst = s.problems[0];
    notes.push(
      tr('allClusters.hero.worst', { name: worst.places[0]!.cluster.name, title: worst.title }),
    );
  }
  return {
    healthy: false,
    title: tr('allClusters.hero.attention', { n: bad.length }),
    sub: notes.join(' · '),
  };
}

export interface Tile {
  key: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

/**
 * The tiles: clusters and fleets, nodes and servers, open problems, alerts sent, and (0.13.0)
 * certificates expiring within 14 days and scheduled jobs failing, across all of them.
 */
export function tiles(s: AllClusters, kind: Kind, rangeLabel: string, tr: Tr): Tile[] {
  const by = (st: string) => s.clusters.filter((c) => c.status === st).length;
  const statusParts = [
    by('critical') && tr('allClusters.tiles.critical', { n: by('critical') }),
    by('warning') && tr('allClusters.tiles.warning', { n: by('warning') }),
    by('healthy') && tr('allClusters.tiles.healthy', { n: by('healthy') }),
    by('waiting') && tr('allClusters.tiles.waiting', { n: by('waiting') }),
  ].filter(Boolean) as string[];
  const crit = s.problems.filter((p) => p.severity === 'critical').length;
  const warn = s.problems.length - crit;
  const hosts =
    kind === 'kubernetes'
      ? s.hosts.nodes
      : kind === 'server'
        ? s.hosts.servers
        : s.hosts.nodes + s.hosts.servers;
  const channels = s.alertsSent.channels.map((c) =>
    c.failed
      ? tr('allClusters.tiles.channelFailed', { name: c.name, n: c.sent + c.failed })
      : tr('allClusters.tiles.channel', { name: c.name, n: c.sent }),
  );
  return [
    {
      key: 'clusters',
      label: tr('allClusters.tiles.clusters'),
      value: String(s.clusters.length),
      sub: statusParts.join(' · ') || '—',
      tone: 'muted',
    },
    {
      key: 'hosts',
      label: tr(
        kind === 'kubernetes'
          ? 'allClusters.tiles.nodes'
          : kind === 'server'
            ? 'allClusters.tiles.servers'
            : 'allClusters.tiles.hosts',
      ),
      value: String(hosts),
      sub: s.hosts.notReporting
        ? tr('allClusters.tiles.notReporting', { n: s.hosts.notReporting })
        : tr('allClusters.tiles.allReporting'),
      tone: s.hosts.notReporting ? 'critical' : 'healthy',
    },
    {
      key: 'problems',
      label: tr('allClusters.tiles.problems'),
      value: String(s.problems.length),
      sub: s.problems.length
        ? [
            crit && tr('allClusters.tiles.critical', { n: crit }),
            warn && tr('allClusters.tiles.warning', { n: warn }),
          ]
            .filter(Boolean)
            .join(' · ')
        : tr('allClusters.tiles.resolvedWeek', { n: s.resolvedThisWeek }),
      tone: 'muted',
    },
    {
      key: 'alerts',
      label: tr('allClusters.tiles.alerts', { range: rangeLabel }),
      value: String(s.alertsSent.total),
      sub: channels.join(' · ') || tr('allClusters.tiles.noAlerts'),
      tone: 'muted',
    },
    {
      key: 'certs',
      label: tr('allClusters.tiles.certsExpiring'),
      value: String(s.certificatesExpiring.count),
      sub:
        s.certificatesExpiring.places.map((p) => `${p.name} ${p.count}`).join(' · ') ||
        tr('allClusters.tiles.noneExpiring'),
      tone: s.certificatesExpiring.count ? 'critical' : 'healthy',
    },
    {
      key: 'jobs',
      label: tr('allClusters.tiles.jobsFailing'),
      value: String(s.jobsFailing.count),
      sub:
        [...new Set(s.jobsFailing.jobs.map((j) => j.name.split('/').pop() ?? j.name))].join(
          ' · ',
        ) || tr('allClusters.tiles.noneFailing'),
      tone: s.jobsFailing.count ? 'critical' : 'healthy',
    },
  ];
}

/** Under a row's name: "Kubernetes 1.34 · 12 nodes" or "Server fleet · 3 servers · PostgreSQL". */
export function kindLine(r: AllClustersRow, tr: Tr): string {
  if (r.kind === 'kubernetes') {
    return [
      r.version
        ? tr('allClusters.kind.kubernetesVersion', { v: r.version })
        : tr('allClusters.kind.kubernetes'),
      tr('allClusters.hosts.nodes', { n: r.hosts }),
    ].join(' · ');
  }
  const parts = [tr('allClusters.kind.server'), tr('allClusters.hosts.servers', { n: r.hosts })];
  const src = r.sources;
  if (src?.applications.length) parts.push(src.applications.map(serviceName).join(', '));
  else if (src) {
    const runs = [
      src.services && tr('allClusters.kind.services', { n: src.services }),
      src.processGroups && tr('allClusters.kind.processGroups', { n: src.processGroups }),
      src.containers && tr('allClusters.kind.containers', { n: src.containers }),
    ].filter(Boolean) as string[];
    if (runs.length) parts.push(runs.join(', '));
  }
  return parts.join(' · ');
}

/** The sidebar's and the switcher's count: "12 nodes", "3 servers", "1 of 2 reporting". */
export function countLine(r: AllClustersRow, tr: Tr): string {
  if (r.reporting.live < r.reporting.total)
    return tr('allClusters.reportingOf', { live: r.reporting.live, total: r.reporting.total });
  return tr(r.kind === 'server' ? 'allClusters.hosts.servers' : 'allClusters.hosts.nodes', {
    n: r.hosts,
  });
}

/** "45%": a ratio as a whole percentage; "—" when unknown. */
export const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`;

/** The CPU sparkline's path in a w×h box, ratios 0–1 (gaps skipped). */
export function sparkPath(points: (number | null)[][], w = 96, h = 28): string {
  const vals = points.map((p) => (p[1] === null || p[1] === undefined ? null : Number(p[1])));
  const n = vals.length;
  if (n < 2) return '';
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = ((i * w) / (n - 1)).toFixed(1);
    const y = (h - 2 - Math.min(1, Math.max(0, v)) * (h - 4)).toFixed(1);
    d += `${pen ? 'L' : 'M'}${x} ${y} `;
    pen = true;
  });
  return d.trim();
}

/** A problem's link: its alert in its own cluster or fleet, else that one's Overview. */
export function placeLink(p: AllClustersProblem['places'][number]): RouteLocationRaw {
  return p.alertId
    ? { name: 'alert', params: { id: p.alertId }, query: { cluster: p.cluster.id } }
    : { name: 'overview', query: { cluster: p.cluster.id } };
}

export const clusterLink = (id: string): RouteLocationRaw => ({
  name: 'overview',
  query: { cluster: id },
});

/** A What changed row across clusters: how far, what, and against what. */
export function changeView(r: AllClustersChange, tr: Tr) {
  const factor =
    r.usualHigh > 0 && r.value > r.usualHigh
      ? `${(r.value / r.usualHigh).toFixed(1)}×`
      : r.usualHigh > 0 && r.value < r.usualLow && r.value > 0
        ? `÷${(r.usualLow / r.value).toFixed(1)}`
        : `${Math.round(r.peakScore)}σ`;
  return {
    factor,
    title: `${objectName(r.object)} ${metricText(r, tr)}`,
    why: tr('allClusters.changes.why', {
      usual: rangeText(r.usualLow, r.usualHigh, r.unit),
      value: valueText(r.value, r.unit),
    }),
  };
}

/** The housekeeping items, in the page's order, each with its tone and where it leads. */
export function chores(
  h: AllClusters['housekeeping'],
  tr: Tr,
): {
  key: string;
  tone: Tone;
  title: string;
  body: string;
  action: string;
  to: RouteLocationRaw;
  /** The cluster whose agents' update dialog this item opens (ADR-227). */
  agentsOf?: string;
}[] {
  const out: ReturnType<typeof chores> = [];
  // One item per cluster or fleet with older agents: it opens their update command (ADR-227).
  for (const o of h.oldAgents) {
    out.push({
      key: `agents-${o.cluster.id}`,
      tone: 'warning',
      title: tr('allClusters.chores.agents', { n: o.count, name: o.cluster.name }),
      body: tr('allClusters.chores.agentsIn', {
        versions: o.versions.join(', '),
        latest: h.latestVersion,
      }),
      action: tr('allClusters.chores.update'),
      to: { name: 'cluster-settings', params: { id: o.cluster.id } },
      agentsOf: o.cluster.id,
    });
  }
  for (const ch of h.failingChannels) {
    out.push({
      key: `channel-${ch.id}`,
      tone: 'critical',
      title: tr('allClusters.chores.channel', { name: ch.name }),
      body: [
        ch.error ? tr('allClusters.chores.channelError', { error: ch.error }) : null,
        h.deliveringChannels.length
          ? tr('allClusters.chores.stillDeliver', {
              names: h.deliveringChannels.map((d) => d.name).join(', '),
            })
          : tr('allClusters.chores.nothingDelivers'),
      ]
        .filter(Boolean)
        .join(' '),
      action: tr('allClusters.chores.fix'),
      to: { name: 'settings', query: { tab: 'channels' } },
    });
  }
  for (const c of h.noChannel) {
    out.push({
      key: `nochannel-${c.id}`,
      tone: 'warning',
      title: tr('allClusters.chores.noChannel', { name: c.name }),
      body: tr(
        c.kind === 'server'
          ? 'allClusters.chores.noChannelFleet'
          : 'allClusters.chores.noChannelCluster',
      ),
      action: tr('allClusters.chores.add'),
      to: { name: 'settings', query: { tab: 'channels', cluster: c.id } },
    });
  }
  for (const e of h.ebpfOff) {
    out.push({
      key: `ebpf-${e.cluster.id}`,
      tone: 'muted',
      title: tr(
        e.cluster.kind === 'server'
          ? 'allClusters.chores.ebpfServers'
          : 'allClusters.chores.ebpfNodes',
        {
          n: e.count,
          name: e.cluster.name,
        },
      ),
      body: e.reasons.length
        ? tr('allClusters.chores.ebpfWhy', { reasons: e.reasons.join('; ') })
        : tr('allClusters.chores.ebpfNoReason'),
      action: tr('allClusters.chores.why'),
      to: { name: 'service-map', query: { cluster: e.cluster.id } },
    });
  }
  return out;
}

/**
 * Whether the sidebar's and the switcher's "Pro" label shows (ADR-227): only to orgs without
 * the page (Cloud Free, Community), where it explains the upgrade card. A Pro org (and the
 * demo) sees the plain name.
 */
export function showsProLabel(o: {
  isCloud: boolean;
  demo: boolean;
  proFeatures: boolean | null | undefined;
  access: Access | null;
}): boolean {
  if (o.access === 'pro' || o.demo) return false;
  if (o.isCloud) return o.proFeatures !== true;
  return true;
}

/** A row's Certificates or Jobs cell: "12 · 1 expiring", "9 · 1 failing", "12", "–". */
export function countCell(
  total: number,
  bad: number,
  badKey: string,
  tr: Tr,
): { text: string; bad: boolean } {
  if (total === 0) return { text: '–', bad: false };
  return bad
    ? { text: `${total} · ${tr(badKey, { n: bad })}`, bad: true }
    : { text: String(total), bad: false };
}
