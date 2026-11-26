// SPDX-License-Identifier: AGPL-3.0-only
// "Add a source" (1.0.3) in rules, without I/O: which way opens first, what a test's answer
// means, what a typed name and value are, and the last way a user chose (remembered in this
// browser; never a token, which lives only in the page that made it).
import type { OwnAddressTest, OwnFound, OwnMetricsSummary } from '@watchlog/api-types';
import { isTimestampName } from '@watchlog/snippets';
import type { Way } from '@/lib/own-metrics';

/** The ways in the page's order: the one that needs nothing installed first. */
export const WAYS: readonly Way[] = ['push', 'scrape', 'prometheus'];

const KEY = 'watchlog.ownAdd.way';

/** The way the user chose last time in this browser, if it can be read. */
export function rememberedWay(): Way | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return WAYS.includes(v as Way) ? (v as Way) : null;
  } catch {
    return null;
  }
}
export function rememberWay(w: Way): void {
  try {
    globalThis.localStorage?.setItem(KEY, w);
  } catch {
    // A private window: the page works without it.
  }
}

/**
 * Which way opens first: the one the link names, else the one chosen last time, else Expose
 * when the quiet search found an endpoint here, else Push (it needs nothing installed).
 */
export function firstWay(o: {
  query: unknown;
  remembered: Way | null;
  found: OwnFound | null;
}): Way {
  if (WAYS.includes(o.query as Way)) return o.query as Way;
  if (o.remembered) return o.remembered;
  return o.found && o.found.found.length > 0 ? 'scrape' : 'push';
}

/** A metric's name as the push accepts it. */
export const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
export const nameOk = (name: string): boolean =>
  METRIC_NAME.test(name) && name.length <= 200 && !name.startsWith('watchlog_');
export const valueOk = (value: string): boolean =>
  value.trim() !== '' && Number.isFinite(Number(value.trim()));

/** What a name will be read as: the page says it beside the field. */
export function kindOfName(name: string): 'counter' | 'timestamp' | 'gauge' {
  if (isTimestampName(name)) return 'timestamp';
  return /_total$/.test(name) ? 'counter' : 'gauge';
}

/** The words of a test's answer: the i18n key under ownMetrics.add.test.outcome. */
export function testOutcomeKey(t: OwnAddressTest): string {
  const known = [
    'answered',
    'refused',
    'no_host',
    'slow',
    'big',
    'auth',
    'status',
    'html',
    'not_metrics',
    'redirect',
    'tls',
    'address',
    'silent',
  ];
  return known.includes(t.outcome ?? '') ? t.outcome! : 'other';
}

/** "22, 80, 443 and 6 more": a list of ports, shortened. */
export function portsText(ports: readonly number[], more: (n: number) => string, max = 8): string {
  if (ports.length <= max) return ports.join(', ');
  return `${ports.slice(0, max).join(', ')} ${more(ports.length - max)}`;
}

/** The pickers' options: a fleet's servers, or a cluster's workloads as "namespace/name". */
export function ownerOptions(
  s: Pick<OwnMetricsSummary, 'kind' | 'servers' | 'workloads'>,
): { value: string; label: string; description?: string }[] {
  if (s.kind === 'server') return s.servers.map((n) => ({ value: n, label: n }));
  return s.workloads.map((w) => ({
    value: `${w.namespace}/${w.kind}/${w.name}`,
    label: `${w.namespace}/${w.name}`,
    description: w.kind,
  }));
}

/** A picker's value as the push names it: {server} or {workload: "namespace/name"}. */
export function pushOwner(
  kind: 'kubernetes' | 'server',
  value: string | null,
): { server: string } | { workload: string } | null {
  if (!value) return null;
  if (kind === 'server') return { server: value };
  const [ns, , name] = value.split('/');
  return ns && name ? { workload: `${ns}/${name}` } : null;
}

/** A picker's value as a workload: its namespace, kind and name. */
export function workloadOf(
  value: string | null,
): { namespace: string; kind: string; name: string } | null {
  const [namespace, kind, name] = (value ?? '').split('/');
  return namespace && kind && name ? { namespace, kind, name } : null;
}
