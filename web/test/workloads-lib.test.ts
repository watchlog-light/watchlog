// SPDX-License-Identifier: AGPL-3.0-only
// The Workloads page's rules (ADR-111): namespace
// grouping and ordering, the system-namespace filter, resource bar states, image names,
// pod squares and CronJob schedules.
import type { KubeWorkload } from '@watchlog/api-types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ResourceBar from '@/components/kube/ResourceBar.vue';
import { resourceBar } from '@/lib/resources';
import {
  cronText,
  filterWorkloads,
  groupByNamespace,
  restartsHigh,
  shortImage,
  squares,
} from '@/lib/workloads';
import { createPlugins } from './helpers';

const wl = (namespace: string, name: string, severity?: 'critical' | 'warning') =>
  ({
    kind: 'Deployment',
    namespace,
    name,
    images: [`${name}:1`],
    problem: severity ? { severity, reason: 'r', alertId: null } : null,
  }) as KubeWorkload;

describe('namespace grouping', () => {
  it('puts namespaces with the most problems first, problem rows first inside', () => {
    const groups = groupByNamespace([
      wl('a', 'x'),
      wl('b', 'z'),
      wl('b', 'y', 'warning'),
      wl('c', 'q', 'warning'),
      wl('c', 'p'),
      wl('c', 'r', 'critical'),
    ]);
    expect(groups.map((g) => [g.namespace, g.problems])).toEqual([
      ['c', 2],
      ['b', 1],
      ['a', 0],
    ]);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual(['r', 'q', 'p']);
    expect(groups[1]!.rows.map((r) => r.name)).toEqual(['y', 'z']);
  });

  it('hides system namespaces unless asked, and filters by kinds and failing', () => {
    const rows = [wl('kube-system', 'coredns'), wl('shop', 'cart', 'critical'), wl('shop', 'web')];
    const f = { kinds: [], failing: false, hideSystem: true, terms: [] };
    const system = new Set(['kube-system', 'watchlog']);
    expect(filterWorkloads(rows, { ...f, system }).map((w) => w.name)).toEqual(['cart', 'web']);
    expect(filterWorkloads(rows, { ...f, system, hideSystem: false })).toHaveLength(3);
    expect(filterWorkloads(rows, { ...f, system, failing: true }).map((w) => w.name)).toEqual([
      'cart',
    ]);
    expect(filterWorkloads(rows, { ...f, system, kinds: ['StatefulSet'] })).toEqual([]);
    expect(filterWorkloads(rows, { ...f, system, terms: ['web:1'] }).map((w) => w.name)).toEqual([
      'web',
    ]);
  });
});

describe('resource bars', () => {
  it('places usage, the request tick and the limit marker; red near the limit', () => {
    const b = resourceBar(50, 100, 200);
    expect(b.usage).toBeCloseTo(22.73);
    expect(b.request).toBeCloseTo(45.45);
    expect(b.limit).toBeCloseTo(90.91);
    expect(b.near).toBe(false);
    expect(resourceBar(31, 16, 32).near).toBe(true);
    expect(resourceBar(28, 16, 32).near).toBe(false);
    // Over the request is not a problem by itself; no limit is never "near".
    expect(resourceBar(300, 100, null).near).toBe(false);
    // A trace of usage still shows.
    expect(resourceBar(0, 1, null).usage).toBe(2);
  });

  it('spells out "no request" and "no limit", with exact values in the tooltip', async () => {
    const { i18n } = await createPlugins('/');
    const bar = (props: { usage: number | null; request: number | null; limit: number | null }) =>
      mount(ResourceBar, {
        props: { unit: 'bytes' as const, ...props },
        global: { plugins: [i18n] },
      });
    const none = bar({ usage: 10 * 2 ** 20, request: null, limit: null });
    expect(none.text()).toContain('no request');
    expect(none.attributes('title')).toBe('used 10 MiB · no request · no limit');
    expect(none.find('[data-testid="request-tick"]').exists()).toBe(false);
    expect(none.find('[data-testid="limit-marker"]').exists()).toBe(false);
    const near = bar({ usage: 31 * 2 ** 20, request: 16 * 2 ** 20, limit: 32 * 2 ** 20 });
    expect(near.attributes('data-state')).toBe('near');
    expect(near.text()).toContain('req 16 MiB');
    expect(near.attributes('title')).toBe('used 31 MiB · request 16 MiB · limit 32 MiB');
    expect(near.find('[data-testid="limit-marker"]').exists()).toBe(true);
    const cpu = mount(ResourceBar, {
      props: { unit: 'cores', usage: 0.0123, request: 0.1, limit: null },
      global: { plugins: [i18n] },
    });
    expect(cpu.text()).toMatch(/^0\.01\s*req 0\.10$/);
    expect(cpu.attributes('title')).toBe('used 0.0123 cores · request 0.1 cores · no limit');
    expect(bar({ usage: null, request: null, limit: null }).text()).toBe('–');
  });
});

describe('rows', () => {
  it('shortens images to name:tag', () => {
    expect(shortImage('docker.io/library/busybox:1.37')).toBe('busybox:1.37');
    expect(shortImage('ghcr.io/stefanprodan/podinfo:6.1')).toBe('podinfo:6.1');
    expect(shortImage('redis:7-alpine')).toBe('redis:7-alpine');
    expect(shortImage('registry.k8s.io/pause@sha256:7031c1b283388d2c')).toBe('pause@7031c1b');
  });

  it('draws one square per pod, missing ones up to the desired count', () => {
    expect(squares(['ready', 'failing'], 3)).toEqual(['ready', 'failing', 'missing']);
    expect(squares(['ready'], null)).toEqual(['ready']);
  });

  it('says common schedules in words and flags many restarts', () => {
    const t = (k: string, v?: Record<string, unknown>) => `${k}${v ? JSON.stringify(v) : ''}`;
    expect(cronText('* * * * *', t)).toBe('kube.cron.everyMinute');
    expect(cronText('*/5 * * * *', t)).toBe('kube.cron.everyMinutes{"n":5}');
    expect(cronText('7 * * * *', t)).toBe('kube.cron.hourly{"m":"07"}');
    expect(cronText('30 2 * * *', t)).toBe('kube.cron.daily{"time":"02:30"}');
    expect(cronText('0 3 * * 1', t)).toBe('0 3 * * 1');
    expect(restartsHigh(19, 3600)).toBe(true);
    expect(restartsHigh(12, 3600)).toBe(false);
    expect(restartsHigh(5, 300)).toBe(true);
    expect(restartsHigh(null, 3600)).toBe(false);
  });
});
