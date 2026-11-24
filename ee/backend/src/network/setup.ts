// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The commands each device needs before WatchLog can read it (ADR-233): a read-only SNMPv3
// user (or a v2c community) limited to the poller's address on Cisco IOS and NX-OS, and a
// read-only RouterOS group and user with HTTPS (www-ssl) and API-SSL limited to the poller.
// Secrets are never filled in: the profile's secret is write-only, so the commands show
// placeholders for the person to type the same values.
import type { RosSettings, SnmpSettings } from './credentials.js';

export type Platform = 'ios' | 'nxos' | 'routeros';

const IOS_AUTH: Record<string, string> = {
  SHA: 'sha',
  SHA224: 'sha-2 224',
  SHA256: 'sha-2 256',
  SHA384: 'sha-2 384',
  SHA512: 'sha-2 512',
};
const IOS_PRIV: Record<string, string> = { AES: 'aes 128', AES192: 'aes 192', AES256: 'aes 256' };

export function setupCommands(
  platform: Platform,
  poller: string,
  settings: SnmpSettings | RosSettings,
): string {
  const ip = poller || '<poller-address>';
  if (platform === 'routeros') {
    const s = settings as RosSettings;
    const user = s.user || 'watchlog';
    return [
      '# A read-only group: `add` grants only the policies it lists (read, the API and REST).',
      '/user group add name=watchlog-read policy=read,api,rest-api',
      `/user add name=${user} group=watchlog-read address=${ip}/32 password="<password>"`,
      '# A certificate for HTTPS and API-SSL (WatchLog pins it on first contact).',
      '/certificate add name=watchlog common-name=watchlog key-usage=digital-signature,key-encipherment,tls-server days-valid=3650',
      '/certificate sign watchlog',
      `/ip service set www-ssl certificate=watchlog disabled=no address=${ip}/32`,
      `/ip service set api-ssl certificate=watchlog disabled=no address=${ip}/32`,
    ].join('\n');
  }
  const s = settings as SnmpSettings;
  const user = s.user || 'watchlog';
  if (platform === 'nxos') {
    if (s.version === '2c') {
      return [
        'ip access-list WATCHLOG-SNMP',
        `  10 permit udp ${ip}/32 any eq snmp`,
        'snmp-server community <community> group network-operator',
        'snmp-server community <community> use-ipv4acl WATCHLOG-SNMP',
      ].join('\n');
    }
    const auth = (s.authProto ?? 'SHA256') === 'SHA' ? 'sha' : 'sha-256';
    return [
      'ip access-list WATCHLOG-SNMP',
      `  10 permit udp ${ip}/32 any eq snmp`,
      "! network-operator is NX-OS's read-only role.",
      `snmp-server user ${user} network-operator auth ${auth} <auth-key> priv aes-128 <privacy-key>`,
      `snmp-server user ${user} use-ipv4acl WATCHLOG-SNMP`,
    ].join('\n');
  }
  const acl = ['ip access-list standard WATCHLOG-SNMP', ` permit host ${ip}`, ' deny any log'];
  if (s.version === '2c') {
    return [
      ...acl,
      'snmp-server view WATCHLOG-RO iso included',
      'snmp-server community <community> view WATCHLOG-RO RO WATCHLOG-SNMP',
    ].join('\n');
  }
  const auth = IOS_AUTH[s.authProto ?? 'SHA256'] ?? 'sha';
  const priv = IOS_PRIV[s.privProto ?? 'AES'] ?? 'aes 128';
  return [
    ...acl,
    'snmp-server view WATCHLOG-RO iso included',
    'snmp-server group watchlog-ro v3 priv read WATCHLOG-RO access WATCHLOG-SNMP',
    '! The MAC table per VLAN (contexts vlan-<id>).',
    'snmp-server group watchlog-ro v3 priv context vlan- match prefix read WATCHLOG-RO access WATCHLOG-SNMP',
    auth === 'sha'
      ? `snmp-server user ${user} watchlog-ro v3 auth sha <auth-key> priv ${priv} <privacy-key> access WATCHLOG-SNMP`
      : `! SHA-2 needs IOS XE 17 or later; on IOS 15 choose SHA in the profile.\nsnmp-server user ${user} watchlog-ro v3 auth ${auth} <auth-key> priv ${priv} <privacy-key> access WATCHLOG-SNMP`,
  ].join('\n');
}
