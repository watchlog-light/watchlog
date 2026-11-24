// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Links and endpoints from reports (ADR-233): CDP, LLDP and MNDP to links with both ends
// merged, MAC tables where no protocol speaks, endpoints on the port nearest them.
import { describe, expect, it } from 'vitest';
import {
  mergeLinks,
  placeEndpoints,
  portKey,
  type DevRef,
  type MacIn,
  type NeighbourIn,
} from '../src/network/links.js';
import { vendorOf } from '../src/network/oui.js';
import { setupCommands } from '../src/network/setup.js';
import { olderVersion } from '../src/network/routes.js';
import { validRange } from '../src/network/range.js';

const dev = (
  id: string,
  name: string,
  address: string,
  ports: string[],
  macs: string[] = [],
): DevRef => ({
  id,
  name,
  sysName: name,
  address,
  macs: new Set(macs),
  ports: ports.map((p) => ({
    name: p,
    descr: p.replace(/^Gi/, 'GigabitEthernet').replace(/^Te/, 'TenGigabitEthernet'),
    alias: '',
  })),
});

const core = dev(
  '1',
  'core-1',
  '10.0.0.2',
  ['Ethernet1/1', 'Ethernet1/47', 'Ethernet1/48'],
  ['00:1b:00:00:00:01'],
);
const sw1 = dev(
  '2',
  'sw-access-1',
  '10.0.0.11',
  ['Gi1/0/1', 'Gi1/0/2', 'Te1/1/1'],
  ['00:1b:00:00:00:02'],
);
const sw2 = dev(
  '3',
  'sw-access-2',
  '10.0.0.12',
  ['Gi1/0/1', 'Gi1/0/14', 'Te1/1/1'],
  ['00:1b:00:00:00:03'],
);
const edge = dev('4', 'edge-1', '10.0.0.1', ['sfp-sfpplus1', 'ether2'], ['48:a9:8a:00:00:01']);

describe('port names', () => {
  it('reads every spelling of a port as one', () => {
    expect(portKey('GigabitEthernet1/0/14')).toBe(portKey('Gi1/0/14'));
    expect(portKey('TenGigabitEthernet1/1/1')).toBe(portKey('Te1/1/1'));
    expect(portKey('Ethernet1/47')).toBe('eth1/47');
    expect(portKey('sfp-sfpplus1')).toBe('sfp-sfpplus1');
  });
});

describe('links', () => {
  it('merges CDP from one end and LLDP from the other into one link', () => {
    const n: NeighbourIn[] = [
      // core-1 sees sw-access-1 over CDP, with the long port name and a domain.
      {
        deviceId: '1',
        localPort: 'Ethernet1/47',
        protocol: 'cdp',
        remoteName: 'sw-access-1.lan(FOC123)',
        remotePort: 'TenGigabitEthernet1/1/1',
        remoteAddr: '10.0.0.11',
      },
      // sw-access-1 sees core-1 over LLDP and CDP.
      {
        deviceId: '2',
        localPort: 'Te1/1/1',
        protocol: 'lldp',
        remoteName: 'core-1',
        remotePort: 'Ethernet1/47',
      },
      {
        deviceId: '2',
        localPort: 'Te1/1/1',
        protocol: 'cdp',
        remoteName: 'core-1',
        remotePort: 'Ethernet1/47',
        remoteAddr: '10.0.0.2',
      },
      // The router speaks MNDP, found by its MAC.
      {
        deviceId: '4',
        localPort: 'sfp-sfpplus1',
        protocol: 'mndp',
        remoteMac: '00:1b:00:00:00:01',
        remotePort: 'Ethernet1/1',
      },
      // Something WatchLog doesn't poll: no link.
      { deviceId: '1', localPort: 'Ethernet1/48', protocol: 'lldp', remoteName: 'unknown-ap' },
    ];
    const links = mergeLinks([core, sw1, sw2, edge], n, []);
    expect(links).toEqual([
      { aDevice: '1', aPort: 'Ethernet1/1', bDevice: '4', bPort: 'sfp-sfpplus1', via: ['mndp'] },
      { aDevice: '1', aPort: 'Ethernet1/47', bDevice: '2', bPort: 'Te1/1/1', via: ['cdp', 'lldp'] },
    ]);
  });

  it('learns a link from MAC tables when neither end speaks CDP or LLDP', () => {
    const macs: MacIn[] = [
      // core-1 sees sw-access-2 behind Ethernet1/48 (with the hosts behind it), and the
      // hosts of sw-access-1 behind Ethernet1/47 (a learnt link already).
      { deviceId: '1', port: 'Ethernet1/48', mac: '00:1b:00:00:00:03' },
      { deviceId: '1', port: 'Ethernet1/48', mac: '52:54:00:aa:00:01' },
      { deviceId: '3', port: 'Te1/1/1', mac: '00:1b:00:00:00:01' },
      { deviceId: '3', port: 'Gi1/0/14', mac: '52:54:00:aa:00:01' },
    ];
    const n: NeighbourIn[] = [
      {
        deviceId: '1',
        localPort: 'Ethernet1/47',
        protocol: 'cdp',
        remoteAddr: '10.0.0.11',
        remotePort: 'Te1/1/1',
      },
    ];
    const links = mergeLinks([core, sw1, sw2], n, macs);
    expect(links).toContainEqual({
      aDevice: '1',
      aPort: 'Ethernet1/48',
      bDevice: '3',
      bPort: 'Te1/1/1',
      via: ['mac'],
    });
    expect(links).toHaveLength(2);
    // The host is on sw-access-2's Gi1/0/14, not on the core's port toward it.
    const eps = placeEndpoints([core, sw1, sw2], links, macs, [
      { mac: '52:54:00:aa:00:01', ip: '10.0.10.21' },
    ]);
    expect(eps).toEqual([
      { mac: '52:54:00:aa:00:01', ip: '10.0.10.21', deviceId: '3', port: 'Gi1/0/14', vlan: null },
    ]);
  });

  it('puts an endpoint on the port with the fewest addresses (a desk switch behind a port)', () => {
    const macs: MacIn[] = [
      { deviceId: '2', port: 'Gi1/0/1', mac: 'aa:00:00:00:00:01' },
      { deviceId: '2', port: 'Gi1/0/1', mac: 'aa:00:00:00:00:02' },
      { deviceId: '3', port: 'Gi1/0/1', mac: 'aa:00:00:00:00:01' },
    ];
    const eps = placeEndpoints([sw1, sw2], [], macs, []);
    expect(eps.find((e) => e.mac === 'aa:00:00:00:00:01')).toMatchObject({
      deviceId: '3',
      port: 'Gi1/0/1',
    });
  });
});

describe('vendors', () => {
  it('reads the IEEE registry and skips locally administered addresses', () => {
    expect(vendorOf('00:1b:2b:00:00:01')).toMatch(/Cisco/);
    expect(vendorOf('52:54:00:12:34:56')).toBe(''); // locally administered (QEMU)
    expect(vendorOf('nope')).toBe('');
  });
});

describe('setup commands and checks', () => {
  it('limits every platform to the poller, read-only, without secrets', () => {
    const ios = setupCommands('ios', '10.0.0.50', {
      version: '3',
      user: 'watchlog',
      authProto: 'SHA',
      privProto: 'AES',
    });
    expect(ios).toContain('permit host 10.0.0.50');
    expect(ios).toContain('v3 priv read WATCHLOG-RO');
    expect(ios).toContain('context vlan- match prefix');
    expect(ios).toContain('<auth-key>');
    expect(ios).not.toMatch(/write|rw\b/i);
    const nx = setupCommands('nxos', '10.0.0.50', {
      version: '3',
      user: 'watchlog',
      authProto: 'SHA256',
    });
    expect(nx).toContain('network-operator');
    expect(nx).toContain('use-ipv4acl WATCHLOG-SNMP');
    const ros = setupCommands('routeros', '10.0.0.50', { user: 'watchlog' });
    expect(ros).toContain('policy=read,api,rest-api');
    expect(ros).toContain('address=10.0.0.50/32');
    expect(ros).toContain('www-ssl');
    expect(ros).not.toContain('write');
  });

  it('finds the oldest firmware, and refuses ranges wider than a /24', () => {
    expect(olderVersion('15.2(2)E10', '15.2(7)E8')).toBe(true);
    expect(olderVersion('7.16.2', '7.9.1')).toBe(false);
    expect(validRange('10.0.10.0/24').bits).toBe(24);
    expect(() => validRange('10.0.0.0/23')).toThrow(/wider/);
  });
});
