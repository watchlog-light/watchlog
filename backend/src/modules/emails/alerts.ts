// SPDX-License-Identifier: AGPL-3.0-only
// The alert email (ADR-220, from ADR-081/095's message): what the alert's page shows, in the
// shared template. One alert: where, since when, the rule, its value against its limit
// ("Now", the rule's own why-line), the likely cause when there is one and, on Pro, one line
// of What changed around it. A batch (ADR-095: grouped by rule and cluster) lists its alerts.
// Subjects start with [Critical], [Warning], [Resolved] (or [Flapping], [Test]) and name the
// thing and the place; a resolve, a reminder or an escalation threads under the alert's
// firing email (In-Reply-To, References) and keeps its subject's stem.
import type { EmailSpec } from '../../lib/mail.js';
import type { MessagePayload } from '../alerts/outbox.js';
import type { RenderedMessage } from '../alerts/render.js';
import { hhmm, span, when } from './format.js';

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sev = (s: string) => (s === 'critical' ? 'Critical' : 'Warning');

function badgeOf(p: MessagePayload): string {
  switch (p.kind) {
    case 'firing':
      return `${sev(p.severity)} · firing`;
    case 'escalated':
      return `${sev(p.severity)} · escalated`;
    case 'renotify':
      return `${sev(p.severity)} · still firing`;
    case 'flapping':
      return `${sev(p.severity)} · flapping`;
    case 'resolved':
      return 'Resolved';
    default:
      return 'Test';
  }
}

function kindOf(p: MessagePayload): EmailSpec['kind'] {
  if (p.kind === 'resolved') return 'resolved';
  if (p.kind === 'test') return 'info';
  return p.severity === 'critical' ? 'critical' : 'warning';
}

export interface AlertEmailOptions {
  /** One line of What changed around it (Pro), when there was one when it fired. */
  whatChanged?: string | null;
}

export function alertEmail(
  p: MessagePayload,
  m: RenderedMessage,
  opts: AlertEmailOptions = {},
): EmailSpec {
  const at = Date.parse(p.at);
  const subject = m.subject;
  const footer = {
    why: `You got this because this address is an alert channel for ${p.cluster.name}.`,
    manage: 'Change it in Settings › Alert channels.',
  };
  if (p.kind === 'test') {
    return {
      kind: 'info',
      subject,
      preheader: 'This channel is connected. Alerts will arrive like this.',
      header: p.cluster.name,
      badge: 'Test',
      title: 'This alert channel works',
      intro: ['This is a test from WatchLog. Alerts will arrive like this. No action needed.'],
      footer,
    };
  }

  if (!m.single) {
    const items = m.items.map((it) => [it.title, it.where, it.why].filter(Boolean).join(' · '));
    const firstStart = Math.min(...p.items.map((it) => Date.parse(it.startedAt)));
    return {
      kind: kindOf(p),
      subject,
      preheader: `${p.total} alerts of the rule ${p.rule.name} in ${p.cluster.name}.`,
      header: p.cluster.name,
      badge: badgeOf(p),
      title:
        p.kind === 'resolved'
          ? `Resolved: ${p.rule.name} (${p.total})`
          : `${p.rule.name}: ${p.total} alerts`,
      intro: [
        p.kind === 'resolved'
          ? `These ${p.total} alerts in ${p.cluster.name} are back to normal.`
          : `${p.total} alerts of the same rule are open in ${p.cluster.name}, the first since ${when(new Date(firstStart))}.`,
      ],
      list: { items: m.more ? [...items, cap(m.more)] : items },
      button: m.alertsLink ? { label: 'Open the alerts', url: m.alertsLink } : null,
      footer,
    };
  }

  const it = p.items[0]!;
  const r = m.items[0]!;
  const started = it.firedAt ?? it.startedAt;
  const facts: { label: string; value: string }[] = [
    { label: 'Where', value: `${p.cluster.name} › ${r.where}` },
  ];
  let intro: string;
  let preheader: string;
  if (p.kind === 'resolved' && it.resolvedAt) {
    const open = span(Date.parse(it.resolvedAt) - Date.parse(started));
    facts.push({ label: 'From', value: when(started) });
    facts.push({ label: 'To', value: `${when(it.resolvedAt)} (${open})` });
    intro = `It is back to normal. The alert was open for ${open}.`;
    preheader = `Back to normal at ${hhmm(it.resolvedAt)} after ${open}.`;
  } else {
    const long = span(at - Date.parse(it.startedAt));
    facts.push({ label: 'Since', value: `${when(it.startedAt)} (${long})` });
    intro =
      p.kind === 'renotify'
        ? `It is still firing after ${long}.`
        : p.kind === 'escalated'
          ? `It got worse: it is ${p.severity} now, firing for ${long}.`
          : p.kind === 'flapping'
            ? 'It fired 3 times within 30 minutes. WatchLog sends no reminders while it flaps, and resolves it after 15 quiet minutes.'
            : `It started at ${hhmm(it.startedAt)} and is still firing.`;
    preheader =
      [r.why ? cap(r.why) : null, r.cause ? r.cause : null]
        .filter(Boolean)
        .join('. ')
        .slice(0, 140) || `Since ${hhmm(it.startedAt)}.`;
  }
  facts.push({ label: 'Rule', value: p.rule.name });
  if (r.why && p.kind !== 'resolved') facts.push({ label: 'Now', value: r.why });
  const cause = it.likelyCause?.text
    ? { label: p.kind === 'resolved' ? 'Was likely' : 'Likely cause', text: it.likelyCause.text }
    : null;
  const aside =
    opts.whatChanged && p.kind !== 'resolved'
      ? { label: 'What changed around it', text: opts.whatChanged }
      : null;
  return {
    kind: kindOf(p),
    subject,
    preheader,
    header: p.cluster.name,
    badge: badgeOf(p),
    title: p.kind === 'resolved' ? `Resolved: ${r.title}` : r.title,
    intro: [intro],
    facts,
    cause,
    aside,
    button: r.link
      ? { label: p.kind === 'resolved' ? 'See what happened' : 'Open the alert', url: r.link }
      : null,
    note: [
      p.kind === 'resolved'
        ? 'The alert’s page keeps its chart and its probable cause.'
        : 'You’ll get one more email when it resolves. Silence it from the alert’s page.',
    ],
    footer,
  };
}

/** Message-ID and thread for an alert email: one alert's messages share its thread. */
export function alertThread(
  p: MessagePayload,
  m: RenderedMessage,
  deliveryId: string,
  domain: string,
): { messageId: string; inReplyTo?: string } {
  if (!m.single || p.kind === 'test') return { messageId: `<${deliveryId}@${domain}>` };
  // One thread per firing episode: an alert that resolves and fires again starts a new one.
  const it = p.items[0]!;
  const fired = Date.parse(it.firedAt ?? it.startedAt);
  const root = `<alert-${it.alertId}.${Number.isNaN(fired) ? 0 : fired}@${domain}>`;
  if (p.kind === 'firing' || p.kind === 'flapping') return { messageId: root };
  return { messageId: `<${deliveryId}@${domain}>`, inReplyTo: root };
}
