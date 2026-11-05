// SPDX-License-Identifier: AGPL-3.0-only
// Turns the transitions of one rule and cluster in one cycle into outbox rows: one
// message per channel and transition kind, listing at most MAX_ITEMS alerts
// (ADR-074, ADR-075). Rendering for each channel happens when it is sent.
import { createHash } from 'node:crypto';
import { newId } from '../../lib/ids.js';
import { maxSeverity, type Episode, type NotifyKind, type Severity } from './state-machine.js';

export const MAX_ITEMS = 5;

export interface MessageItem {
  alertId: string;
  severity: Severity;
  labels: Record<string, string>;
  details: Record<string, unknown>;
  startedAt: string;
  firedAt: string | null;
  resolvedAt: string | null;
}

/** What a sender needs to render a message; stored in notifications.payload. */
export interface MessagePayload {
  version: 1;
  kind: NotifyKind | 'test';
  severity: Severity;
  rule: { id: string; key: string | null; name: string; metric?: string | null };
  cluster: { id: string; name: string; kind: string };
  items: MessageItem[];
  /** All alerts of this message; items holds the first MAX_ITEMS. */
  total: number;
  at: string;
}

export interface Transition {
  alertId: string;
  episode: Episode;
  notify: NotifyKind;
}

export interface OutboxRow {
  id: string;
  org_id: string;
  channel_id: string;
  rule_id: string;
  cluster_id: string;
  kind: NotifyKind;
  payload: MessagePayload;
  dedupe_key: string;
  alertIds: string[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function buildOutboxRows(
  orgId: string,
  rule: {
    id: string;
    rule_key: string | null;
    name: string;
    metric?: string | null;
    channel_ids: string[];
  },
  cluster: { id: string; name: string; kind: string },
  transitions: Transition[],
  now: number,
): OutboxRow[] {
  if (rule.channel_ids.length === 0) return [];
  const byKind = new Map<NotifyKind, Transition[]>();
  for (const t of transitions) byKind.set(t.notify, [...(byKind.get(t.notify) ?? []), t]);
  const rows: OutboxRow[] = [];
  for (const [kind, list] of byKind) {
    // Critical first, then oldest first: the items worth reading come before "and N more".
    list.sort(
      (a, b) =>
        (b.episode.severity === 'critical' ? 1 : 0) - (a.episode.severity === 'critical' ? 1 : 0) ||
        a.episode.startedAt - b.episode.startedAt,
    );
    const payload: MessagePayload = {
      version: 1,
      kind,
      severity: list.map((t) => t.episode.severity).reduce(maxSeverity),
      rule: { id: rule.id, key: rule.rule_key, name: rule.name, metric: rule.metric ?? null },
      cluster,
      items: list.slice(0, MAX_ITEMS).map((t) => ({
        alertId: t.alertId,
        severity: t.episode.severity,
        labels: t.episode.labels,
        details: t.episode.details,
        startedAt: iso(t.episode.startedAt)!,
        firedAt: iso(t.episode.firedAt),
        resolvedAt: iso(t.episode.resolvedAt),
      })),
      total: list.length,
      at: iso(now)!,
    };
    // The same alerts at the same notification sequence never make a second message.
    const key = list
      .map((t) => `${t.alertId}:${t.episode.notifySeq}`)
      .sort()
      .join(',');
    const dedupe = `${kind}:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    for (const channelId of rule.channel_ids) {
      rows.push({
        id: newId(),
        org_id: orgId,
        channel_id: channelId,
        rule_id: rule.id,
        cluster_id: cluster.id,
        kind,
        payload,
        dedupe_key: dedupe,
        alertIds: list.map((t) => t.alertId),
      });
    }
  }
  return rows;
}
