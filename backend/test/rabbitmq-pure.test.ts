// SPDX-License-Identifier: AGPL-3.0-only
// RabbitMQ's pure rules (1.1.0, ADR-243): how long a queue takes to drain, when a queue needs a
// look, a client's role from the direction of its traffic, and how busy the consumers were
// before they left.
import { describe, expect, it } from 'vitest';
import { mostlyOf, ROLE_MIN_BYTES } from '../src/modules/integrations/pages/rabbitmq-clients.js';
import { busyBefore } from '../src/modules/integrations/pages/rabbitmq-queue.js';
import { drainOf, severityOf } from '../src/modules/integrations/pages/rabbitmq-queues.js';

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
