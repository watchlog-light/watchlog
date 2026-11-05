// SPDX-License-Identifier: AGPL-3.0-only
// The Nodes page's rules (ADR-111): capacity totals, the
// fullest disk with its alert, condition chips and the default layout.
import { describe, expect, it } from 'vitest';
import { capacity, conditionChips, defaultLayout, fullestDisk, type NodeModel } from '@/lib/nodes';

const node = (name: string, over: Partial<NodeModel> = {}) =>
  ({
    name,
    cpu: { usageCores: 1, requestsCores: 2, allocatableCores: 4 },
    memory: { usageBytes: null, requestsBytes: 10, allocatableBytes: 100 },
    pods: { count: 5, capacity: 110 },
    disks: [],
    conditions: [],
    ...over,
  }) as unknown as NodeModel;

describe('nodes', () => {
  it('adds up capacity; usage stays unknown until a node reports it', () => {
    const c = capacity([
      node('a'),
      node('b', { cpu: { usageCores: null, requestsCores: 1, allocatableCores: 4 } }),
    ]);
    expect(c.cpu).toEqual({ used: 1, requested: 3, allocatable: 8 });
    expect(c.memory.used).toBeNull();
    expect(c.pods).toEqual({ count: 10, capacity: 220 });
  });

  it('finds the fullest mount, the nodes it is that full on, and its alert', () => {
    const disks = (u: number) => [{ mount: '/var', utilization: u, sizeBytes: 100 }];
    const nodes = [
      node('a', { disks: disks(0.85) }),
      node('b', { disks: disks(0.845) }),
      node('c', { disks: disks(0.5) }),
    ];
    expect(fullestDisk(nodes, [])).toEqual({
      mount: '/var',
      utilization: 0.85,
      nodes: ['a', 'b'],
      alertId: null,
    });
    expect(fullestDisk(nodes, [{ node: 'b', mount: '/var', alertId: 'x' }])?.alertId).toBe('x');
    expect(fullestDisk(nodes, [{ node: 'c', mount: '/var', alertId: 'x' }])?.alertId).toBeNull();
    expect(fullestDisk([node('a')], [])).toBeNull();
  });

  it('shows pressure conditions as chips and picks the layout by node count', () => {
    const n = node('a', {
      conditions: [
        { type: 'Ready', status: 'True', reason: null, message: null, since: null, bad: false },
        {
          type: 'DiskPressure',
          status: 'True',
          reason: 'KubeletHasDiskPressure',
          message: null,
          since: null,
          bad: true,
        },
        {
          type: 'MemoryPressure',
          status: 'False',
          reason: null,
          message: 'ok',
          since: null,
          bad: false,
        },
      ],
    });
    expect(conditionChips(n)).toEqual([
      { key: 'memory', ok: true, title: 'ok' },
      { key: 'disk', ok: false, title: 'KubeletHasDiskPressure' },
    ]);
    expect(defaultLayout(12)).toBe('cards');
    expect(defaultLayout(13)).toBe('table');
  });
});
