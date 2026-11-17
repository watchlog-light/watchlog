// SPDX-License-Identifier: AGPL-3.0-only
// The egress alerts' messages (ADR-187, ADR-095) in every channel, Kubernetes and Docker: the
// same words as the web, the likely cause's line, a link to the Egress page filtered to the
// source and destination, and the destination set as code (never a link) in Slack and
// Telegram, escaped first: names come from DNS answers anyone can register. In the webhook the
// destination is data, in `labels`.
import { describe, expect, it } from 'vitest';
import { slackBody, telegramText, webhookBody } from '../src/modules/alerts/channels.js';
import type { NotifyCause } from '../src/modules/alerts/likely-cause.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import { renderMessage } from '../src/modules/alerts/render.js';

const BASE = 'https://watchlog.example.com';
const AT = '2026-11-15T08:15:00.000Z';

const cause: NotifyCause = {
  rule: 'change_before_egress',
  code: 'change_before_egress',
  facts: { name: 'orders', minutes: 7 },
  since: '2026-11-15T08:05:00.000Z',
  headline: {
    code: 'change_before_egress_image',
    facts: { name: 'orders', n: 7, image: 'shop/orders:3.8.2' },
  },
  subject: 'workload:shop/Deployment/orders',
  text: 'Started 7 minutes after orders was changed to image shop/orders:3.8.2.',
  chain: [],
};

function payload(
  kind: 'kubernetes' | 'server',
  key: string,
  labels: Record<string, string>,
  details: Record<string, unknown>,
  over: Partial<MessagePayload['items'][number]> = {},
): MessagePayload {
  return {
    version: 1,
    kind: 'firing',
    severity: 'warning',
    rule: { id: 'rule-1', key, name: 'New external destination' },
    cluster: { id: 'c-1', name: kind === 'server' ? 'edge-fleet' : 'acme-prod', kind },
    items: [
      {
        alertId: 'a-1',
        severity: 'warning',
        labels,
        details,
        startedAt: '2026-11-15T08:12:00.000Z',
        firedAt: '2026-11-15T08:13:00.000Z',
        resolvedAt: null,
        ...over,
      },
    ],
    total: 1,
    at: AT,
  };
}

const KUBE = {
  namespace: 'shop',
  workload_kind: 'Deployment',
  workload: 'orders',
  destination: 'cdn-update-check.xyz',
  port: '443',
};
const NEW_DETAILS = {
  destination: 'cdn-update-check.xyz',
  port: 443,
  class: 'name',
  firstSeen: '2026-11-15T08:12:00.000Z',
  others: 0,
};

describe('New external destination, Kubernetes', () => {
  const p = payload('kubernetes', 'egress.new_destination', KUBE, NEW_DETAILS, {
    likelyCause: cause,
  });
  const m = renderMessage(p, BASE);

  it('email (plain text): what, where, since when, the likely cause and the Egress link', () => {
    expect(m.subject).toBe(
      '[WARNING] orders started talking to cdn-update-check.xyz:443 (acme-prod)',
    );
    expect(m.text).toBe(
      [
        '🟠 WARNING · orders started talking to cdn-update-check.xyz:443',
        '',
        'first connection at 08:12 UTC · nothing else in the cluster talks to it',
        'shop/orders (Deployment) · cluster acme-prod · since 08:12 UTC (3 min)',
        'Likely cause: Started 7 minutes after orders was changed to image shop/orders:3.8.2.',
        `${BASE}/egress?cluster=c-1&namespace=shop&kind=Deployment&workload=orders&q=cdn-update-check.xyz`,
      ].join('\n'),
    );
  });

  it('Telegram: the destination as <code>, never a link', () => {
    const t = telegramText(m);
    expect(t).toContain(
      '<b>🟠 WARNING · orders started talking to <code>cdn-update-check.xyz:443</code></b>',
    );
    expect(t).not.toContain('href="http://cdn-update-check');
    expect(t).toContain(`<a href="${BASE}/egress?cluster=c-1&amp;namespace=shop`);
  });

  it('Slack: the destination in backticks', () => {
    const body = JSON.stringify(slackBody(m, p));
    expect(body).toContain('orders started talking to `cdn-update-check.xyz:443`');
  });

  it('webhook: the destination is data in labels, the words beside it', () => {
    const w = webhookBody(p, m, Date.parse(AT)) as { alerts: Record<string, unknown>[] };
    expect(w.alerts[0]).toMatchObject({
      labels: KUBE,
      title: 'orders started talking to cdn-update-check.xyz:443',
      why: 'first connection at 08:12 UTC · nothing else in the cluster talks to it',
      likelyCause: { rule: 'change_before_egress' },
    });
  });
});

describe('Docker vocabulary', () => {
  it('a Compose service: named with its project, the fleet, the Egress page filtered to it', () => {
    const p = payload(
      'server',
      'egress.new_destination',
      { compose_project: 'shop', compose_service: 'api', destination: 'example.org', port: '443' },
      { ...NEW_DETAILS, destination: 'example.org', others: 2 },
    );
    const m = renderMessage(p, BASE);
    expect(m.items[0]).toMatchObject({
      title: 'shop/api started talking to example.org:443',
      why: 'first connection at 08:12 UTC · 2 other containers talk to it',
      where: 'shop/api (Compose service)',
      link: `${BASE}/egress?cluster=c-1&project=shop&service=api&q=example.org`,
    });
  });

  it('a plain container on its host: raw IP', () => {
    const p = payload(
      'server',
      'egress.raw_ip',
      { node: 'docker-01', container: 'redis', destination: '8.8.8.0/24', port: '53' },
      {
        destination: '8.8.8.0/24',
        port: 53,
        class: 'public_network',
        connections: 6,
        threshold: 4,
      },
    );
    const m = renderMessage(p, BASE);
    expect(m.items[0]).toMatchObject({
      title: 'redis connects to 8.8.8.0/24:53 by IP address',
      why: '6 connections in 10 min · no DNS name behind it',
      where: 'docker-01/redis',
      link: `${BASE}/egress?cluster=c-1&host=docker-01&container=redis&q=8.8.8.0%2F24`,
    });
    expect(telegramText(m)).toContain('<code>8.8.8.0/24:53</code>');
  });
});

describe('Large upload and the resolve message', () => {
  it('names the size in MiB, the threshold and the first seen', () => {
    const p = payload('kubernetes', 'egress.large_upload_new', KUBE, {
      destination: 'cdn-update-check.xyz',
      port: 443,
      class: 'name',
      sentBytes: 120 * 2 ** 20,
      threshold: 100 * 2 ** 20,
      firstSeen: '2026-11-15T06:00:00.000Z',
    });
    const m = renderMessage(p, BASE);
    expect(m.items[0]!.title).toBe('orders sent 120 MiB to cdn-update-check.xyz:443');
    expect(m.items[0]!.why).toBe('in the last hour · threshold 100 MiB · first seen at 06:00 UTC');
  });

  it('resolved: "Was likely" and the same words', () => {
    const p = {
      ...payload('kubernetes', 'egress.new_destination', KUBE, NEW_DETAILS, {
        likelyCause: cause,
        resolvedAt: '2026-11-16T09:00:00.000Z',
      }),
      kind: 'resolved' as const,
    };
    const m = renderMessage(p, BASE);
    expect(m.title).toBe('✅ RESOLVED · orders started talking to cdn-update-check.xyz:443');
    expect(m.items[0]!.cause).toBe(`Was likely: ${cause.text}`);
  });

  it('a hostile name stays text: escaped in Telegram, no markup from it', () => {
    const evil = 'x<b>y</b>.example.org';
    const p = payload(
      'kubernetes',
      'egress.new_destination',
      { ...KUBE, destination: evil },
      { ...NEW_DETAILS, destination: evil },
    );
    const t = telegramText(renderMessage(p, BASE));
    expect(t).toContain('<code>x&lt;b&gt;y&lt;/b&gt;.example.org:443</code>');
    expect(t).not.toContain('<b>y</b>');
  });
});
