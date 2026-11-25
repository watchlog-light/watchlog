// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
import { describe, expect, it } from 'vitest';
import {
  daysLeftWords,
  failing,
  feedGroups,
  rateAgainstUsual,
  recordingState,
  runtimeMinutes,
  signalState,
  smartTone,
  upsTone,
  usedShare,
  volumeTone,
} from './storage';

describe('recording', () => {
  it('says yes, no or unknown', () => {
    expect(recordingState({ recording: true })).toBe('yes');
    expect(recordingState({ recording: false })).toBe('no');
    expect(recordingState({ recording: null })).toBe('unknown');
    expect(signalState({ ok: true })).toBe('true');
    expect(signalState({ ok: false })).toBe('false');
    expect(signalState({ ok: null })).toBe('unknown');
  });

  it('words the days left', () => {
    expect(daysLeftWords({ daysLeft: 12.7, full: false })).toEqual({ key: 'days', n: 12 });
    expect(daysLeftWords({ daysLeft: 0.4, full: false })).toEqual({ key: 'underDay', n: 0 });
    expect(daysLeftWords({ daysLeft: null, full: true })).toEqual({ key: 'full', n: 0 });
    expect(daysLeftWords({ daysLeft: null, full: false })).toEqual({ key: 'unknown', n: 0 });
    // No hour of its write rate yet: calculating, whatever the number would be.
    expect(daysLeftWords({ daysLeft: null, full: false, daysCalculating: true })).toEqual({
      key: 'calculating',
      n: 0,
    });
  });

  it('places the write rate against its usual band', () => {
    const usual = { low: 10, high: 20 };
    expect(rateAgainstUsual(5, usual)).toBe('below');
    expect(rateAgainstUsual(15, usual)).toBe('inside');
    expect(rateAgainstUsual(25, usual)).toBe('above');
    expect(rateAgainstUsual(null, usual)).toBeNull();
    expect(rateAgainstUsual(5, null)).toBeNull();
  });
});

describe('NAS words', () => {
  it('colours SMART', () => {
    expect(['Good', 'warning', 'Abnormal', 'error', 'unknown'].map(smartTone)).toEqual([
      'ok',
      'warning',
      'critical',
      'critical',
      'neutral',
    ]);
  });

  it('colours volumes and pools', () => {
    expect(
      ['Ready', 'Rebuilding', 'Degraded', 'Synchronizing', 'Whatever'].map(volumeTone),
    ).toEqual(['ok', 'warning', 'critical', 'warning', 'neutral']);
  });

  it('keeps only parts that are not fine', () => {
    expect(
      failing([
        { name: 'a', state: 'ok' },
        { name: 'b', state: 'failed' },
        { name: 'c', state: 'Normal' },
      ]).map((p) => p.name),
    ).toEqual(['b']);
  });

  it('computes the used share', () => {
    expect(usedShare(100, 25)).toBe(0.75);
    expect(usedShare(0, 0)).toBeNull();
    expect(usedShare(100, 150)).toBe(0);
  });
});

describe('UPS', () => {
  it('colours its status', () => {
    expect(['online', 'on-battery', 'bypass', 'off', 'unknown', undefined].map(upsTone)).toEqual([
      'ok',
      'critical',
      'warning',
      'warning',
      'neutral',
      'neutral',
    ]);
    expect(runtimeMinutes(1830)).toBe(30);
    expect(runtimeMinutes(undefined)).toBeNull();
  });

  it('groups the hosts it can feed by place', () => {
    expect(
      feedGroups([
        { clusterId: 'f', cluster: 'fleet', kind: 'server', node: 'web-2' },
        { clusterId: 'k', cluster: 'cluster', kind: 'kubernetes', node: 'node-1' },
        { clusterId: 'f', cluster: 'fleet', kind: 'server', node: 'web-1' },
        { clusterId: 'f', cluster: 'fleet', kind: 'server', node: 'web-1' },
      ]),
    ).toEqual([
      { clusterId: 'k', cluster: 'cluster', kind: 'kubernetes', nodes: ['node-1'] },
      { clusterId: 'f', cluster: 'fleet', kind: 'server', nodes: ['web-1', 'web-2'] },
    ]);
  });
});
