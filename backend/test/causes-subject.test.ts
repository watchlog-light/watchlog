// SPDX-License-Identifier: AGPL-3.0-only
// Subjects of GET /causes (ADR-148): every kind in its forms, the canonical form back, and
// the 400s with the forms named.
import { describe, expect, it } from 'vitest';
import {
  formatSubject,
  parseSubject,
  platformOf,
  SubjectError,
} from '../src/modules/causes/subject.js';

const ID = '01a1c65e-24dc-74a3-926b-c80d5a1bd1e5';

describe('parseSubject', () => {
  it.each([
    [`alert:${ID}`, { kind: 'alert', id: ID }],
    [`alert:${ID.toUpperCase()}`, { kind: 'alert', id: ID }],
    [
      'pod:causes-e2e/hog-76cf876d44-psvtk',
      { kind: 'pod', namespace: 'causes-e2e', name: 'hog-76cf876d44-psvtk' },
    ],
    [
      'workload:causes-e2e/web',
      { kind: 'workload', namespace: 'causes-e2e', workloadKind: null, name: 'web' },
    ],
    [
      'workload:shop/statefulset/postgres',
      { kind: 'workload', namespace: 'shop', workloadKind: 'StatefulSet', name: 'postgres' },
    ],
    ['container:causes-e2e-hog-1', { kind: 'container', host: null, name: 'causes-e2e-hog-1' }],
    [
      'container:docker-01/causes-e2e-hog-1',
      { kind: 'container', host: 'docker-01', name: 'causes-e2e-hog-1' },
    ],
    ['compose_service:web', { kind: 'compose_service', project: null, service: 'web' }],
    [
      'compose_service:causes-e2e/web',
      { kind: 'compose_service', project: 'causes-e2e', service: 'web' },
    ],
    [
      'edge:w:causes-e2e/Deployment/web>w:causes-e2e/Deployment/api:9898',
      {
        kind: 'edge',
        source: 'w:causes-e2e/Deployment/web',
        target: 'w:causes-e2e/Deployment/api',
        port: 9898,
      },
    ],
    // An external target carries its own port; the edge's port is after the last colon.
    [
      'edge:c:causes-e2e-front-1>x:slow:9898:9898',
      { kind: 'edge', source: 'c:causes-e2e-front-1', target: 'x:slow:9898', port: 9898 },
    ],
    // Topology edges have no port.
    [
      'edge:c:shop-web-1>c:shop-api-1:',
      { kind: 'edge', source: 'c:shop-web-1', target: 'c:shop-api-1', port: null },
    ],
    [
      'edge:w:shop/Deployment/web>internet:443',
      { kind: 'edge', source: 'w:shop/Deployment/web', target: 'internet', port: 443 },
    ],
    ['application:causes-e2e/pg', { kind: 'application', ref: 'causes-e2e/pg' }],
    [`application:${ID}`, { kind: 'application', ref: ID }],
  ])('%s', (raw, want) => {
    expect(parseSubject(raw)).toEqual(want);
  });

  it.each([
    '',
    'pod',
    ':x',
    'nope:x',
    'alert:',
    'alert:12',
    'pod:only-a-name',
    'pod:Shop/x',
    'pod:a/b/c',
    'workload:shop/Pod/x',
    'workload:a/b/c/d',
    'container:a/b/c',
    'container:-bad',
    'compose_service:a/b/c',
    'edge:w:shop/Deployment/web',
    'edge:s:shop/api>w:shop/Deployment/api:80',
    'edge:w:shop/Deployment/web>w:shop/Deployment/api:http',
    'edge:w:shop/Deployment/web>w:shop/Deployment/api:70000',
    'application:has space',
    `pod:${'a'.repeat(700)}/b`,
  ])('refuses %j', (raw) => {
    expect(() => parseSubject(raw)).toThrow(SubjectError);
  });

  it('names the forms and the workload kinds when it refuses', () => {
    expect(() => parseSubject('nope:x')).toThrow(/pod:<namespace>\/<pod>/);
    expect(() => parseSubject('workload:shop/Pod/x')).toThrow(/Deployment, StatefulSet/);
  });

  it('formats back the canonical form', () => {
    for (const raw of [
      `alert:${ID}`,
      'pod:shop/cart-1',
      'workload:shop/Deployment/cart',
      'workload:shop/cart',
      'container:docker-01/shop-web-1',
      'container:shop-web-1',
      'compose_service:shop/web',
      'edge:w:shop/Deployment/web>w:shop/Deployment/api:9898',
      'edge:c:shop-web-1>c:shop-api-1:',
      'application:shop/redis',
    ])
      expect(formatSubject(parseSubject(raw))).toBe(raw);
  });

  it('knows which platform a kind belongs to', () => {
    expect(platformOf('pod')).toBe('kubernetes');
    expect(platformOf('compose_service')).toBe('docker');
    expect(platformOf('alert')).toBeNull();
  });
});
