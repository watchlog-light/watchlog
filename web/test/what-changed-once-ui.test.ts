// SPDX-License-Identifier: AGPL-3.0-only
// What changed lists a series once (ADR-229): the row says how many other changes that series
// had, on the page ("in this window") and on All clusters ("in 24 h").
import type { WhatChangedRow } from '@watchlog/api-types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WhatChangedRows from '@/components/what-changed/WhatChangedRows.vue';
import { createPlugins } from './helpers';

const row = (over: Partial<WhatChangedRow>): WhatChangedRow =>
  ({
    id: '01a19300-0000-7000-8000-000000000001',
    since: '2026-11-22T08:00:00.000Z',
    until: null,
    key: 'workload.cpu.usage',
    unit: 'cores',
    subject: {},
    object: { kind: 'workload', name: 'search', namespace: 'shop', workloadKind: 'Deployment' },
    peer: null,
    usualLow: 0.3,
    usualHigh: 0.5,
    value: 0.9,
    peakScore: 8,
    peakAt: '2026-11-22T08:05:00.000Z',
    ...over,
  }) as WhatChangedRow;

describe('a series listed once', () => {
  it('says how many more changes it had, and nothing when it had none', async () => {
    const { router, i18n, pinia } = await createPlugins('/');
    const w = mount(WhatChangedRows, {
      props: { rows: [row({ more: 3 }), row({ id: '01a19300-0000-7000-8000-000000000002' })] },
      global: { plugins: [router, i18n, pinia] },
    });
    const more = w.findAll('[data-testid="wc-more"]');
    expect(more).toHaveLength(1);
    expect(more[0]!.text()).toBe('and 3 more changes in this window');
  });
});
