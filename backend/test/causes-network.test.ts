// SPDX-License-Identifier: AGPL-3.0-only
// network_port (0.16, ADR-233): the switch port, uplink or switch a node or server sits
// behind, from the network module's events (kinds NetworkPort and NetworkDevice). Without
// those events (Community, no module) the rule never matches.
import { describe, expect, it } from 'vitest';
import { networkPort } from '../src/modules/causes/rules/network-port.js';
import type { EvEvent } from '../src/modules/causes/evidence.js';
import { evidence } from './support/causes.js';

const ev = (events: Partial<EvEvent>[], fixture = 'kube-workload-crash' as const) =>
  evidence(fixture, (e) => {
    const at = e.window.to;
    e.network = events.map((x) => ({
      type: 'Warning',
      reason: 'PortDown',
      message: '',
      count: 1,
      firstSeen: at,
      lastSeen: at,
      namespace: null,
      involvedKind: 'NetworkPort',
      involvedName: 'sw-access-2/Gi1/0/14',
      host: 'db-1',
      ...x,
    }));
  });

describe('network_port', () => {
  it('matches nothing without the module’s events', () => {
    expect(networkPort.match(evidence('kube-workload-crash'))).toBeNull();
  });

  it('the switch port of db-1 went down', () => {
    const m = networkPort.match(ev([{}]))!;
    expect(m.code).toBe('network_port_down');
    expect(m.facts).toEqual({ host: 'db-1', device: 'sw-access-2', port: 'Gi1/0/14' });
    expect(m.complete).toBe(true);
    expect(m.chain[0]!.object).toMatchObject({ kind: 'node', name: 'db-1' });
  });

  it('a port that came back up is not the cause', () => {
    const e = ev([{}]);
    const later = new Date(Date.parse(e.window.to) + 1000).toISOString();
    e.network!.unshift({ ...e.network![0]!, reason: 'PortUp', lastSeen: later });
    expect(networkPort.match(e)).toBeNull();
  });

  it('the switch rebooted; the uplink is dropping packets (partial)', () => {
    const reboot = networkPort.match(
      ev([
        { reason: 'DeviceRebooted', involvedKind: 'NetworkDevice', involvedName: 'sw-access-2' },
      ]),
    )!;
    expect(reboot).toMatchObject({
      code: 'network_device_rebooted',
      facts: { device: 'sw-access-2', host: 'db-1' },
    });
    const uplink = networkPort.match(
      ev(
        [
          {
            reason: 'UplinkErrors',
            involvedKind: 'NetworkDevice',
            involvedName: 'sw-access-2/Te1/1/1',
          },
        ],
        'docker-container-crash' as never,
      ),
    )!;
    expect(uplink).toMatchObject({
      code: 'network_uplink_errors',
      complete: false,
      facts: { port: 'Te1/1/1' },
    });
    expect(uplink.chain[0]!.object.kind).toBe('host');
  });
});
