// SPDX-License-Identifier: AGPL-3.0-only
// change_before_egress (ADR-187, the catalog's thirteenth rule), from the evidence captured on
// the kind and Docker e2e demos with an egress alert put on the source: a rollout or image change
// (Kubernetes) and a re-create, image or Compose change (Docker) in the 60 minutes before the first
// connection is Likely; a change after it, or more than an hour before, or an alert that isn't an
// egress alert, is not; for egress alerts no other rule of the catalog is asked.
import { headlineText, HEADLINES } from '@watchlog/cause-words';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/modules/causes/catalog.js';
import type { EvAlert, EvMarker, Evidence } from '../src/modules/causes/evidence.js';
import { rank } from '../src/modules/causes/rank.js';
import { EGRESS_CAUSE_RULES, runRules } from '../src/modules/causes/rules.js';
import {
  changeBeforeEgress,
  isEgressAlert,
} from '../src/modules/causes/rules/change-before-egress.js';
import { evidence, type FixtureName } from './support/causes.js';

const FIRST = '2026-11-10T16:21:00.000Z';

function egressAlert(labels: Record<string, string>, key = 'egress.new_destination'): EvAlert {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    state: 'firing',
    severity: 'warning',
    rule: { id: 'r1', key, name: 'New external destination' },
    labels,
    startedAt: FIRST,
    firedAt: '2026-11-10T16:22:00.000Z',
    resolvedAt: null,
  };
}

const KUBE = {
  namespace: 'causes-e2e',
  workload_kind: 'Deployment',
  workload: 'web',
  destination: 'cdn-update-check.xyz',
  port: '443',
};
const COMPOSE = {
  compose_project: 'causes-e2e',
  compose_service: 'web',
  destination: 'cdn-update-check.xyz',
  port: '443',
};

function withAlert(
  name: FixtureName,
  labels: Record<string, string>,
  changes: EvMarker[],
  key?: string,
): Evidence {
  return evidence(name, (e) => {
    e.alert = egressAlert(labels, key);
    e.symptomAt = e.alert.firedAt;
    e.window = { from: '2026-11-10T15:22:00.000Z', to: '2026-11-10T16:30:00.000Z' };
    e.changes = changes;
  });
}

function top(ev: Evidence) {
  const r = rank(runRules(ev, EGRESS_CAUSE_RULES), ev.symptomAt, ev.window.from);
  return { state: r.state, cause: r.causes[0], candidate: r.kept[0]?.candidate };
}

const marker = (kind: string, target: string, ts: string, details: object): EvMarker => ({
  kind,
  target,
  namespace: target.startsWith('Deployment/') ? target.split('/')[1]! : null,
  details: details as Record<string, unknown>,
  ts,
});

describe('change_before_egress on Kubernetes', () => {
  it('an image change 7 minutes before the first connection is Likely, with its chain', () => {
    const ev = withAlert('kube-workload-healthy', KUBE, [
      marker('image', 'Deployment/causes-e2e/web', '2026-11-10T16:14:00.000Z', {
        from: ['web=shop/web:3.8.1'],
        to: ['web=shop/web:3.8.2'],
      }),
    ]);
    const t = top(ev);
    expect(t.state).toBe('likely');
    expect(t.cause).toMatchObject({ rule: 'change_before_egress', strength: 'likely' });
    expect(t.candidate!.chain.map((s) => [s.code, s.facts, s.next])).toEqual([
      ['egress_first_connection', { destination: 'cdn-update-check.xyz:443' }, 'after'],
      ['changed_image', { from: 'shop/web:3.8.1', to: 'shop/web:3.8.2' }, null],
    ]);
    expect(t.candidate!.chain[0]!.at).toBe(FIRST);
    expect(t.candidate!.headline).toEqual({
      code: 'change_before_egress_image',
      facts: { name: 'web', n: 7, image: 'shop/web:3.8.2' },
    });
    expect(headlineText(t.candidate!.headline, { utc: true })).toBe(
      'Started 7 minutes after web was changed to image shop/web:3.8.2.',
    );
  });

  it('a rollout alone names its revision; one minute reads in the singular', () => {
    const ev = withAlert('kube-workload-healthy', KUBE, [
      marker('rollout', 'Deployment/causes-e2e/web', '2026-11-10T16:20:00.000Z', {
        from: '4',
        to: '5',
      }),
    ]);
    const c = top(ev).candidate!;
    expect(c.headline).toEqual({
      code: 'change_before_egress_rollout',
      facts: { name: 'web', n: 1, to: '5' },
    });
    expect(headlineText(c.headline, { utc: true })).toBe(
      'Started 1 minute after web rolled out revision 5.',
    );
  });

  it('no Likely cause without a change of the source in the hour before', () => {
    const cases: EvMarker[][] = [
      [],
      // another workload's change
      [marker('image', 'Deployment/causes-e2e/api', '2026-11-10T16:14:00.000Z', { to: ['a:2'] })],
      // more than 60 minutes before the first connection
      [marker('image', 'Deployment/causes-e2e/web', '2026-11-10T15:19:00.000Z', { to: ['w:2'] })],
      // after the first connection
      [marker('image', 'Deployment/causes-e2e/web', '2026-11-10T16:25:00.000Z', { to: ['w:2'] })],
      // a scale is no version change
      [marker('scale', 'Deployment/causes-e2e/web', '2026-11-10T16:14:00.000Z', { to: 3 })],
    ];
    for (const changes of cases) {
      expect(top(withAlert('kube-workload-healthy', KUBE, changes)).state).toBe('none');
    }
  });

  it('only for egress alerts: another alert on the same workload gets nothing from it', () => {
    const ev = withAlert(
      'kube-workload-healthy',
      KUBE,
      [marker('image', 'Deployment/causes-e2e/web', '2026-11-10T16:14:00.000Z', { to: ['w:2'] })],
      'k8s.pod.crashloop',
    );
    expect(isEgressAlert(ev)).toBe(false);
    expect(changeBeforeEgress.match(ev)).toBeNull();
    for (const key of ['egress.raw_ip', 'egress.large_upload_new']) {
      const e = withAlert(
        'kube-workload-healthy',
        KUBE,
        [marker('image', 'Deployment/causes-e2e/web', '2026-11-10T16:14:00.000Z', { to: ['w:2'] })],
        key,
      );
      expect(top(e).cause?.rule).toBe('change_before_egress');
    }
  });

  it('for egress alerts the catalog is this rule alone: a crash loop on the source is not asked', () => {
    const ev = evidence('kube-workload-crashloop', (e) => {
      e.alert = egressAlert({ ...KUBE, workload: 'crasher' });
      e.symptomAt = e.alert.firedAt;
    });
    expect(runRules(ev).length).toBeGreaterThan(0);
    expect(runRules(ev, EGRESS_CAUSE_RULES)).toEqual([]);
  });
});

describe('change_before_egress on Docker', () => {
  it('a Compose service brought up again before the first connection is Likely', () => {
    const ev = withAlert('docker-compose-healthy', COMPOSE, [
      marker('compose', 'Compose/docker-01/causes-e2e', '2026-11-10T16:12:59.388Z', {
        action: 'up',
      }),
    ]);
    const t = top(ev);
    expect(t.cause).toMatchObject({ rule: 'change_before_egress', strength: 'likely' });
    expect(t.candidate!.chain.map((s) => s.code)).toEqual([
      'egress_first_connection',
      'compose_up',
    ]);
    expect(headlineText(t.candidate!.headline, { utc: true })).toBe(
      'Started 8 minutes after Compose project causes-e2e was brought up.',
    );
  });

  it('a re-created container (the plain container source) is Likely, its image named', () => {
    const ev = withAlert(
      'docker-container-bad-recreate',
      {
        node: 'docker-01',
        container: 'causes-e2e-release-1',
        destination: '1.1.1.0/24',
        port: '443',
      },
      [
        marker('recreate', 'Container/docker-01/causes-e2e-release-1', '2026-11-10T16:18:00.000Z', {
          image: 'busybox:1.36',
        }),
      ],
      'egress.raw_ip',
    );
    const t = top(ev);
    expect(t.state).toBe('likely');
    expect(t.candidate!.facts).toMatchObject({
      name: 'causes-e2e-release-1',
      destination: '1.1.1.0/24:443',
      change: 'recreate',
      minutes: 3,
    });
    expect(headlineText(t.candidate!.headline, { utc: true })).toBe(
      'Started 3 minutes after causes-e2e-release-1 was re-created from busybox:1.36.',
    );
  });

  it('an image change of another container is not the source’s', () => {
    const ev = withAlert('docker-compose-healthy', COMPOSE, [
      marker('image', 'Container/docker-01/causes-e2e-release-1', '2026-11-10T16:14:29.572Z', {
        to: 'busybox:1.36',
      }),
    ]);
    expect(top(ev).state).toBe('none');
  });
});

describe('the catalog and its words', () => {
  it('is the thirteenth rule, with a headline for each change kind', () => {
    expect(CATALOG).toHaveLength(13);
    expect(CATALOG[12]).toBe('change_before_egress');
    for (const k of ['image', 'rollout', 'recreate', 'compose'])
      expect(HEADLINES[`change_before_egress_${k}`]).toBeTruthy();
  });
});
