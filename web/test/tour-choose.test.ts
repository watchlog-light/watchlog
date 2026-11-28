// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// The live demo's guided tour (1.3.0, ADR-246): which story it tells, when it opens, and the
// path of each moment the demo analytics read.
import { describe, expect, it } from 'vitest';
import {
  anotherStories,
  chooseStory,
  storyMatches,
  type OpenAlert,
  type TourStory,
} from '@/tour/choose';
import { markSeen, SEEN_KEY, seen, tourEntry } from '@/tour/entry';
import { momentPath } from '@/tour/events';

const K8S = { id: 'c1', kind: 'kubernetes', name: 'sample-cluster' };
const FLEET = { id: 'c2', kind: 'server', name: 'demo-docker' };
const STORIES: TourStory[] = [
  {
    id: 'rabbitmq-payments',
    kind: 'kubernetes',
    rules: ['RabbitMQ queue growing with no consumers'],
    labels: { queue: 'orders.payments' },
    fallback: false,
  },
  {
    id: 'postgres-lock',
    kind: 'kubernetes',
    rules: ['PostgreSQL session blocked over 1 minute'],
    labels: { service_name: 'shop/postgres' },
    fallback: false,
  },
  {
    id: 'legacy-importer',
    kind: 'kubernetes',
    rules: ['k8s.pod.crashloop'],
    labels: { workload: 'legacy-importer' },
    fallback: true,
  },
  {
    id: 'orders-release',
    kind: 'server',
    rules: ['server.unit.crashloop'],
    labels: { unit: 'orders.service' },
    fallback: false,
  },
  {
    id: 'invoices',
    kind: 'server',
    rules: ['server.unit.failed', 'server.unit.crashloop'],
    labels: { unit: 'invoices.service' },
    fallback: true,
  },
];
const alert = (
  id: string,
  cluster: OpenAlert['cluster'],
  rule: { key: string | null; name: string },
  labels: Record<string, string>,
  firedAt = '2026-11-28T12:00:00Z',
): OpenAlert => ({ id, title: rule.name, cluster, rule, labels, startedAt: firedAt, firedAt });

const QUEUE = alert(
  'a-queue',
  K8S,
  { key: null, name: 'RabbitMQ queue growing with no consumers' },
  { queue: 'orders.payments', vhost: '/' },
);
const LOCK = alert(
  'a-lock',
  K8S,
  { key: null, name: 'PostgreSQL session blocked over 1 minute' },
  { service_name: 'shop/postgres' },
);
const LEGACY = alert(
  'a-legacy',
  K8S,
  { key: 'k8s.pod.crashloop', name: 'Pod CrashLoopBackOff' },
  { workload: 'legacy-importer', namespace: 'shop', pod: 'legacy-importer-1' },
  '2026-11-07T23:51:40Z',
);
const ORDERS = alert(
  'a-orders',
  FLEET,
  { key: 'server.unit.crashloop', name: 'Service crash-looping' },
  { unit: 'orders.service', node: 'demo-server' },
);
const INVOICES = alert(
  'a-invoices',
  FLEET,
  { key: 'server.unit.failed', name: 'Service failed' },
  { unit: 'invoices.service', node: 'demo-server' },
);
const causes = (entries: Record<string, 'likely' | 'possible' | 'none'>) =>
  new Map(Object.entries(entries));

describe('the story the tour tells', () => {
  it("is the configuration's first open story with a Likely cause, on the visitor's side", () => {
    const all = [LEGACY, LOCK, QUEUE, INVOICES, ORDERS];
    const c = causes({ 'a-queue': 'likely', 'a-lock': 'likely', 'a-legacy': 'likely' });
    expect(chooseStory(STORIES, 'kubernetes', all, c)).toMatchObject({
      story: { id: 'rabbitmq-payments' },
      alert: { id: 'a-queue' },
      cause: 'likely',
    });
    // The queue's cause not worked out as Likely: the next one in order that is.
    expect(
      chooseStory(
        STORIES,
        'kubernetes',
        all,
        causes({ 'a-queue': 'possible', 'a-lock': 'likely' }),
      ),
    ).toMatchObject({ story: { id: 'postgres-lock' } });
    expect(
      chooseStory(STORIES, 'server', all, causes({ 'a-orders': 'likely', 'a-invoices': 'likely' })),
    ).toMatchObject({ story: { id: 'orders-release' }, alert: { id: 'a-orders' } });
  });

  it('falls back to the failure that never heals when nothing Likely is open', () => {
    expect(chooseStory(STORIES, 'kubernetes', [LEGACY], causes({}))).toMatchObject({
      story: { id: 'legacy-importer' },
      cause: null,
    });
    expect(
      chooseStory(STORIES, 'server', [INVOICES, ORDERS], causes({ 'a-orders': 'none' })),
    ).toMatchObject({ story: { id: 'invoices' } });
    // Nothing open on that side at all: no story, never an empty one.
    expect(chooseStory(STORIES, 'server', [LEGACY, QUEUE], causes({}))).toBeNull();
  });

  it('matches by side, rule key or name, and every label', () => {
    expect(storyMatches(STORIES[0]!, QUEUE)).toBe(true);
    expect(storyMatches(STORIES[0]!, { ...QUEUE, labels: { queue: 'orders' } })).toBe(false);
    expect(storyMatches(STORIES[4]!, { ...INVOICES, cluster: K8S })).toBe(false);
    expect(
      storyMatches(STORIES[4]!, { ...INVOICES, rule: { key: 'server.unit.crashloop', name: 'x' } }),
    ).toBe(true);
  });

  it('keeps its alert once chosen, even when it resolves midway', () => {
    const chosen = chooseStory(STORIES, 'kubernetes', [QUEUE], causes({ 'a-queue': 'likely' }))!;
    // The queue drained: the tour keeps the same alert id, so its page shows it as resolved.
    const later = chooseStory(STORIES, 'kubernetes', [LEGACY], causes({}));
    expect(chosen.alert.id).toBe('a-queue');
    expect(later?.alert.id).toBe('a-legacy');
  });

  it('offers at the end only the listed stories that are open, never the one just told', () => {
    const all = [LEGACY, INVOICES];
    expect(
      anotherStories(
        STORIES,
        ['legacy-importer', 'invoices', 'orders-release'],
        'legacy-importer',
        all,
        causes({}),
      ).map((o) => o.story.id),
    ).toEqual(['invoices']);
    expect(anotherStories(STORIES, ['nope'], null, all, causes({}))).toEqual([]);
  });
});

describe('when the tour opens', () => {
  const store = (v: string | null) => {
    const m = new Map<string, string>(v === null ? [] : [[SEEN_KEY, v]]);
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, val: string) => void m.set(k, val),
    };
  };
  const throwing = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };

  it('opens by itself on a first visit only', () => {
    expect(tourEntry(undefined, store(null))).toEqual({ open: true, kind: null, reason: 'first' });
    expect(tourEntry(undefined, store('1'))).toEqual({ open: false });
    const s = store(null);
    markSeen(s);
    expect(seen(s)).toBe(true);
    expect(tourEntry(undefined, s)).toEqual({ open: false });
  });

  it('starts at once on ?tour=k8s or ?tour=servers, seen or not; never on ?tour=off', () => {
    expect(tourEntry('k8s', store('1'))).toEqual({
      open: true,
      kind: 'kubernetes',
      reason: 'link',
    });
    expect(tourEntry('servers', store('1'))).toEqual({
      open: true,
      kind: 'server',
      reason: 'link',
    });
    expect(tourEntry(['servers'], store(null))).toMatchObject({ kind: 'server' });
    expect(tourEntry('off', store(null))).toEqual({ open: false });
  });

  it('treats storage that throws as a first visit it can’t remember, and never throws', () => {
    expect(seen(throwing)).toBe(false);
    expect(() => markSeen(throwing)).not.toThrow();
    expect(tourEntry(undefined, throwing)).toMatchObject({ open: true, reason: 'first' });
    expect(tourEntry(undefined, null)).toMatchObject({ open: true, reason: 'first' });
  });
});

describe('the moments the demo analytics read', () => {
  it('are paths, since the access log drops query strings', () => {
    expect(momentPath({ name: 'shown' })).toBe('/api/v1/demo/tour/event/shown');
    expect(momentPath({ name: 'started', kind: 'kubernetes' })).toBe(
      '/api/v1/demo/tour/event/started/k8s',
    );
    expect(momentPath({ name: 'started', kind: 'server' })).toBe(
      '/api/v1/demo/tour/event/started/servers',
    );
    expect(momentPath({ name: 'step', step: 2 })).toBe('/api/v1/demo/tour/event/step/2');
    expect(momentPath({ name: 'skipped', step: 0 })).toBe('/api/v1/demo/tour/event/skipped/0');
    expect(momentPath({ name: 'another', story: 'invoices' })).toBe(
      '/api/v1/demo/tour/event/another/invoices',
    );
  });
});
