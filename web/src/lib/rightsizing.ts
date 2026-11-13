// SPDX-License-Identifier: AGPL-3.0-only
// Right-sizing hints in words (ADR-168): the API's codes and facts become sentences through
// i18n (ADR-147), with cores and bytes in the units a request is written in. The "not set"
// hints of one container (no CPU request, no memory request, no memory limit) are one
// sentence, as ADR-168 says.
import type { RightSizingHint } from '@watchlog/api-types';
import { formatBytes, formatCores } from '@watchlog/cause-words';

export type Tone = 'risk' | 'held' | 'back' | 'unset';

const TONE: Record<string, Tone> = {
  memory_limit_oom: 'risk',
  memory_limit_tight: 'risk',
  cpu_limit_throttled: 'held',
  memory_request_low: 'held',
  cpu_request_low: 'held',
  memory_reservation_low: 'held',
  cpu_request_high: 'back',
  memory_request_high: 'back',
  memory_reservation_high: 'back',
  cpu_no_request: 'unset',
  memory_no_request: 'unset',
  memory_no_limit: 'unset',
};
export const toneOf = (code: string): Tone => TONE[code] ?? 'unset';

const UNSET = new Set(['cpu_no_request', 'memory_no_request', 'memory_no_limit']);

/** One line of the panel: a hint, or a container's "not set" hints together. */
export interface HintLine {
  key: string;
  tone: Tone;
  /** The i18n key and its values. */
  message: string;
  values: Record<string, string | number>;
  hint: RightSizingHint;
  /** Where the probable cause has the same finding (ADR-154, ADR-160). */
  cause: 'oom_limit' | 'cpu_throttled' | null;
}

type Translate = (key: string, values: Record<string, unknown>, plural: number) => string;

/** "7 days", "30 hours": how much history a hint is based on. */
export function period(hours: number, t: Translate): string {
  return hours >= 48
    ? t('rightSizing.days', { n: Math.round(hours / 24) }, Math.round(hours / 24))
    : t('rightSizing.hours', { n: Math.max(1, Math.round(hours)) }, Math.max(1, Math.round(hours)));
}

const cores = (v: unknown) => (typeof v === 'number' ? formatCores(Math.max(v, 0.001)) : '');
const bytes = (v: unknown) => (typeof v === 'number' ? formatBytes(v) : '');

/** The facts as a sentence shows them. */
export function hintValues(h: RightSizingHint, t: Translate): Record<string, string | number> {
  const f = h.facts;
  const out: Record<string, string | number> = {
    name: String(f.name ?? h.object.name),
    container: String(f.container ?? ''),
    period: period(h.basedOn.hours, t),
  };
  if (f.requestCores !== undefined) out.request = cores(f.requestCores);
  if (f.requestBytes !== undefined) out.request = bytes(f.requestBytes);
  if (f.reservationBytes !== undefined) out.reservation = bytes(f.reservationBytes);
  if (f.usedCores !== undefined && f.usedCores !== null) out.used = cores(f.usedCores);
  if (f.peakBytes !== undefined && f.peakBytes !== null) out.peak = bytes(f.peakBytes);
  if (f.p95Bytes !== undefined) out.p95 = bytes(f.p95Bytes);
  if (f.limitBytes !== undefined) out.limit = bytes(f.limitBytes);
  if (f.limitCores !== undefined) out.limit = cores(f.limitCores);
  if (f.hostMemoryBytes !== undefined) out.hostMemory = bytes(f.hostMemoryBytes);
  if (typeof f.host === 'string') out.host = f.host;
  if (typeof f.throttledShare === 'number') out.share = `${Math.round(f.throttledShare * 100)}%`;
  if (typeof f.oomKills === 'number') out.n = f.oomKills;
  if (typeof f.replicas === 'number') out.replicas = f.replicas;
  if (h.suggestion !== null) {
    out.suggest = h.resource === 'cpu' ? cores(h.suggestion) : bytes(h.suggestion);
  }
  if (h.giveBack) out.giveBack = h.resource === 'cpu' ? cores(h.giveBack) : bytes(h.giveBack);
  return out;
}

const platformOf = (h: RightSizingHint) => (h.object.host !== undefined ? 'docker' : 'k8s');

/** The lines for a list of hints (in the API's order), the "not set" ones merged per container. */
export function hintLines(hints: RightSizingHint[], t: Translate): HintLine[] {
  const out: HintLine[] = [];
  const unset = new Map<string, HintLine & { codes: Set<string> }>();
  for (const h of hints) {
    const id = `${h.object.namespace ?? h.object.host}/${h.object.kind}/${h.object.name}/${h.container ?? ''}`;
    if (UNSET.has(h.code)) {
      // Docker's only "not set" hint (no memory limit on a big container) stays its own.
      if (platformOf(h) === 'docker') {
        out.push(line(h, `rightSizing.docker.${h.code}`, hintValues(h, t), `${id}/${h.code}`));
        continue;
      }
      const prev = unset.get(id);
      const values = { ...(prev?.values ?? {}), ...hintValues(h, t) };
      if (h.code === 'cpu_no_request') values.cpuSuggest = values.suggest ?? '';
      else values.memorySuggest = values.suggest ?? '';
      const codes = new Set([...(prev?.codes ?? []), h.code]);
      const entry = { ...line(h, '', values, `${id}/unset`), codes };
      if (prev) Object.assign(prev, { values, codes });
      else {
        unset.set(id, entry);
        out.push(entry);
      }
      continue;
    }
    out.push(
      line(h, `rightSizing.${platformOf(h)}.${h.code}`, hintValues(h, t), `${id}/${h.code}`),
    );
  }
  for (const u of unset.values()) {
    const what = [
      u.codes.has('cpu_no_request') ? 'cpu' : '',
      u.codes.has('memory_no_request') ? 'memory' : '',
      u.codes.has('memory_no_limit') ? 'limit' : '',
    ]
      .filter(Boolean)
      .join('_');
    u.message = `rightSizing.k8s.unset.${what}`;
  }
  return out;
}

function line(
  h: RightSizingHint,
  message: string,
  values: Record<string, string | number>,
  key: string,
): HintLine {
  return {
    key,
    tone: toneOf(h.code),
    message,
    values,
    hint: h,
    cause:
      h.code === 'memory_limit_oom'
        ? 'oom_limit'
        : h.code === 'cpu_limit_throttled'
          ? 'cpu_throttled'
          : null,
  };
}

/** The API path for a panel's object. */
export function rightSizingPath(clusterId: string, q: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  const s = params.toString();
  return `/clusters/${clusterId}/right-sizing${s ? `?${s}` : ''}`;
}
