// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's pure rules (1.1.0, ADR-243): how long a queue takes to drain, when a queue needs a
// look, a client's role from the direction of its traffic, and how busy the consumers were
// before they left.
import { describe, expect, it } from 'vitest';
import { isServiceItself } from '../src/modules/integrations/pages/connected.js';
import {
  clientStateOf,
  mostlyOf,
  ROLE_MIN_BYTES,
} from '../src/modules/integrations/pages/rabbitmq-clients.js';
import {
  consumersOf,
  deliverLags,
  needALook,
  pctText,
} from '../src/modules/integrations/pages/rabbitmq-tabs.js';
import { busyBefore } from '../src/modules/integrations/pages/rabbitmq-queue.js';
import { busyOf, drainOf, severityOf } from '../src/modules/integrations/pages/rabbitmq-queues.js';

const q = (over: object) => ({
  ready: 100,
  in: 1,
  out: 3,
  consumers: 1,
  type: 'classic' as const,
  ...over,
});

describe('drains in', () => {
  it('is ready ÷ (out − in) when the queue shrinks', () => {
    expect(drainOf(q({}))).toEqual({ state: 'eta', seconds: 50 });
    expect(drainOf(q({ ready: 18_420, in: 310, out: 1500 }))).toEqual({
      state: 'eta',
      seconds: 15,
    });
  });
  it('says growing when more comes in than goes out, never when nothing takes from it', () => {
    expect(drainOf(q({ in: 5, out: 3 }))).toEqual({ state: 'growing' });
    expect(drainOf(q({ in: 3, out: 3 }))).toEqual({ state: 'growing' });
    expect(drainOf(q({ consumers: 0, out: 0 }))).toEqual({ state: 'never' });
    expect(drainOf(q({ consumers: 2, out: 0, in: 0 }))).toEqual({ state: 'never' });
    expect(drainOf(q({ out: null, in: null, consumers: null }))).toEqual({ state: 'never' });
  });
  it('empty and stream queues have nothing to drain', () => {
    expect(drainOf(q({ ready: 0 }))).toEqual({ state: 'empty' });
    expect(drainOf(q({ type: 'stream', ready: 5000 }))).toEqual({ state: 'stream' });
  });
});

describe('a queue that needs a look', () => {
  const row = (over: object) => {
    const base = { vhost: '/', queue: 'q', name: 'q', unacked: 0, busy: null, ...q(over) };
    return { ...base, drain: drainOf(base) };
  };
  it('is critical with messages and no consumer, warning when it grows or holds many unacked', () => {
    expect(severityOf(row({ consumers: 0, out: 0 }))).toBe('critical');
    expect(severityOf(row({ ready: 5000, in: 10, out: 5 }))).toBe('warning');
    expect(severityOf(row({ unacked: 20_000 }))).toBe('warning');
    expect(severityOf(row({}))).toBeUndefined();
    // A dead-letter queue without a consumer is usual: a warning, its dead letters are.
    expect(severityOf(row({ queue: 'orders.payments.dlq', consumers: 0, out: 0 }))).toBe('warning');
    expect(severityOf(row({ queue: 'billing-dead-letter', consumers: 0, out: 0 }))).toBe('warning');
    // A stream keeps what it holds: no consumer isn't a problem there.
    expect(severityOf(row({ type: 'stream', consumers: 0, out: 0 }))).toBeUndefined();
  });
});

describe('the role guess', () => {
  it('names a role only when one direction clearly dominates', () => {
    expect(mostlyOf(10e6, 100e3)).toBe('publishes');
    expect(mostlyOf(100e3, 10e6)).toBe('consumes');
    expect(mostlyOf(5e6, 3e6)).toBeNull();
    expect(mostlyOf(4e6, 1.1e6)).toBeNull();
  });
  it('says nothing about a client that barely talked', () => {
    expect(mostlyOf(ROLE_MIN_BYTES / 2 - 1, 0)).toBeNull();
  });
});

describe('busy before the drop', () => {
  it('is the highest utilisation in the 30 minutes before the consumers left', () => {
    const pts: [number, number | null][] = [
      [1000, 0.5],
      [2000, 0.97],
      [2900, 0.99],
      [3100, 0],
    ];
    expect(busyBefore(pts, 3000)).toBe(0.99);
    expect(busyBefore([[100, 0.4]], 3000)).toBeNull();
  });
});

// 1.1.1: one source of truth.
const qrow = (over: object) => {
  const base = {
    vhost: '/',
    queue: 'q',
    name: 'q',
    type: 'classic' as const,
    ready: 0,
    unacked: 0,
    in: 3,
    out: 3,
    consumers: 1,
    busy: 0,
    ...over,
  };
  const row = { ...base, drain: drainOf(base) };
  const severity = severityOf(row);
  return severity ? { ...row, severity } : row;
};

describe('A1: consumers, read once', () => {
  it('a client is gone only when it ended and nothing of it is connected now', () => {
    const oom = { how: 'OOMKilled', at: 1000 };
    expect(clientStateOf(oom, false)).toMatchObject({
      state: { key: 'ended', values: { how: 'OOMKilled' } },
      severity: 'critical',
    });
    // Its restarted pod is connected again: running, the restart said without red.
    const back = clientStateOf(oom, true);
    expect(back.state).toEqual({ key: 'restarted', values: { how: 'OOMKilled', at: 1000 } });
    expect(back.severity).toBeUndefined();
    expect(clientStateOf(null, true).state.key).toBe('running');
    expect(clientStateOf(null, false).state.key).toBe('quiet');
  });

  it('the tile, the rows and the checks count the same consumers', () => {
    expect(consumersOf([qrow({ consumers: 2 }), qrow({ queue: 'b', consumers: 1 })])).toBe(3);
    expect(consumersOf([qrow({ consumers: null })])).toBeNull();
  });

  it('busy is 1 − utilisation, and only with consumers ("100% busy" was idle)', () => {
    expect(busyOf(1, 2)).toBe(0);
    expect(busyOf(0.02, 2)).toBe(0.98);
    expect(busyOf(0, 0)).toBeNull();
    expect(busyOf(null, 3)).toBeNull();
  });
});

describe('A2: deliver warns only when consumers fall behind', () => {
  it('draining a backlog is not a drop', () => {
    // Publish = deliver, the queue empty: no warning, whatever the hour's peak was.
    expect(deliverLags(3, 3, 0)).toBe(false);
    // Deliver above publish (draining a backlog): no warning.
    expect(deliverLags(12, 3, -9)).toBe(false);
    // Below publish while ready grows: a warning.
    expect(deliverLags(0, 3, 3)).toBe(true);
    // Below publish but ready not growing (a short dip): no warning.
    expect(deliverLags(2, 3, 0)).toBe(false);
  });
});

describe('A3: the same number, the same rounding', () => {
  it('writes a ratio as the dashboard does', () => {
    expect(pctText(0.0031)).toBe('0.31%');
    expect(pctText(0.061)).toBe('6.1%');
    expect(pctText(0.61)).toBe('61%');
    expect(pctText(0)).toBe('0%');
  });
});

describe('A4: a service is never its own client', () => {
  it('leaves out its own pods, Compose service, container and unit', () => {
    const k8s = {
      kind: 'workload',
      namespace: 'shop',
      workload_kind: 'StatefulSet',
      workload: 'rabbitmq',
      port: 5672,
    } as const;
    expect(isServiceItself(k8s, { namespace: 'shop', workload: 'rabbitmq' })).toBe(true);
    expect(isServiceItself(k8s, { namespace: 'shop', workload: 'publisher' })).toBe(false);
    const compose = {
      kind: 'compose',
      host: 'h1',
      compose_project: 'shop',
      compose_service: 'rabbitmq',
      port: 5672,
    } as const;
    expect(
      isServiceItself(compose, {
        compose_project: 'shop',
        compose_service: 'rabbitmq',
        container: 'shop-rabbitmq-1',
      }),
    ).toBe(true);
    expect(isServiceItself(compose, { compose_project: 'shop', compose_service: 'consumer' })).toBe(
      false,
    );
  });
});

describe('A5: only queues with a finding need a look', () => {
  it('leaves out a healthy queue, keeps no consumers, growing, 95% busy and dead letters', () => {
    const rows = [
      qrow({ queue: 'orders' }),
      qrow({ queue: 'payments', ready: 300, consumers: 0, out: 0 }),
      qrow({ queue: 'emails', ready: 2000, in: 10, out: 5, busy: 0.5 }),
      qrow({ queue: 'invoices', ready: 50, busy: 0.97 }),
      qrow({ queue: 'orders.dlq', ready: 12, consumers: 0, out: 0, in: 0.1 }),
    ];
    expect(needALook(rows).map((q) => q.queue)).toEqual([
      'payments',
      'emails',
      'invoices',
      'orders.dlq',
    ]);
    expect(needALook([qrow({ queue: 'orders' })])).toEqual([]);
  });
});
