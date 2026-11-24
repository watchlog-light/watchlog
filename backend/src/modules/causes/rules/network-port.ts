// SPDX-License-Identifier: AGPL-3.0-only
// network_port (0.16, ADR-233): the symptom comes from the network a node or server sits on.
// The network module (ee/) records events about the switch port each server or node is behind,
// and about that switch (events/record.ts, kinds NetworkPort and NetworkDevice); this rule
// reads them for the nodes and servers under the focus:
//   - the port went down in the window (and isn't back up after it): "the switch port of db-1
//     went down";
//   - the switch's uplink started dropping packets (errors or discards): "the uplink of
//     sw-access-2 is dropping packets";
//   - the switch rebooted (its uptime started over): "sw-access-2 rebooted".
// Fixed templates (causes.cause.network_port_*), no inference: the event either is there or
// isn't. Without the module there are no such events and the rule never matches.
import { shortName } from '../checks.js';
import type { EvEvent, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Platform, Step } from '../types.js';

const ms = (s: string) => Date.parse(s);

/** "sw-access-2/Gi1/0/14" → device and port. */
function split(name: string): { device: string; port: string } {
  const i = name.indexOf('/');
  return i < 0 ? { device: name, port: '' } : { device: name.slice(0, i), port: name.slice(i + 1) };
}

/** The newest event of a reason for a host, when it is in the window. */
function newest(ev: Evidence, reason: string): EvEvent | undefined {
  const from = ms(ev.window.from);
  return (ev.network ?? []).find((e) => e.reason === reason && ms(e.lastSeen) >= from);
}

export const networkPort: Rule = {
  code: 'network_port',
  platforms: ['kubernetes', 'server'],
  applies: (f) =>
    f.kind === 'pod' ||
    f.kind === 'workload' ||
    f.kind === 'container' ||
    f.kind === 'compose_service' ||
    f.kind === 'node' ||
    f.kind === 'host' ||
    f.kind === 'application',
  match(ev: Evidence): Match | null {
    if (!ev.network?.length) return null;
    const platform: Platform = ev.platform;
    const objectOf = (host: string) => ({
      kind: platform === 'kubernetes' ? ('node' as const) : ('host' as const),
      ref: host,
      name: host,
      platform,
    });
    const down = newest(ev, 'PortDown');
    // A port that came back after it went down isn't the cause of what happens later.
    const up = newest(ev, 'PortUp');
    if (
      down &&
      down.host &&
      !(up && up.host === down.host && ms(up.lastSeen) > ms(down.lastSeen))
    ) {
      const { device, port } = split(down.involvedName);
      const host = down.host;
      const step: Step = {
        object: objectOf(host),
        source: 'metrics',
        code: 'network_port_down',
        facts: { host, device, port },
        at: down.lastSeen,
        since: null,
        next: null,
      };
      return {
        code: 'network_port_down',
        facts: { host, device, port },
        since: down.lastSeen,
        chain: [step],
        complete: true,
        headline: { code: 'network_port_down', facts: { name: shortName(ev), host, device, port } },
        explains: ['node', 'host'],
      };
    }
    const reboot = newest(ev, 'DeviceRebooted');
    if (reboot) {
      const { device } = split(reboot.involvedName);
      const host = reboot.host ?? '';
      return {
        code: 'network_device_rebooted',
        facts: { host, device },
        since: reboot.lastSeen,
        chain: [
          {
            object: objectOf(host),
            source: 'metrics',
            code: 'network_device_rebooted',
            facts: { host, device },
            at: reboot.lastSeen,
            since: null,
            next: null,
          },
        ],
        complete: true,
        headline: { code: 'network_device_rebooted', facts: { name: shortName(ev), host, device } },
        explains: ['node', 'host'],
      };
    }
    const uplink = newest(ev, 'UplinkErrors');
    if (uplink) {
      const { device, port } = split(uplink.involvedName);
      const host = uplink.host ?? '';
      return {
        code: 'network_uplink_errors',
        facts: { host, device, port },
        since: uplink.firstSeen,
        chain: [
          {
            object: objectOf(host),
            source: 'metrics',
            code: 'network_uplink_errors',
            facts: { host, device, port },
            at: null,
            since: uplink.firstSeen,
            next: null,
          },
        ],
        // Errors on the uplink slow everything behind it, but needn't be why this failed.
        complete: false,
        headline: {
          code: 'network_uplink_errors',
          facts: { name: shortName(ev), host, device, port },
        },
        explains: ['node', 'host'],
      };
    }
    return null;
  },
  explains: ['node', 'host'],
};
