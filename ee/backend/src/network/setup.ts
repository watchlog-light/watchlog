// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The commands each device needs before WatchLog can read it (ADR-233): a read-only SNMPv3
// user (or a v2c community) limited to the poller's address on Cisco IOS and NX-OS, and a
// read-only RouterOS group and user with HTTPS (www-ssl) and API-SSL limited to the poller.
// Secrets are never filled in: the profile's secret is write-only, so the commands show
// placeholders for the person to type the same values.
import type { RosSettings, SnmpSettings } from './credentials.js';

export type Platform = 'ios' | 'nxos' | 'routeros';

const IOS_AUTH: Record<string, string> = {
  MD5: 'md5',
  SHA: 'sha',
  SHA224: 'sha-2 224',
  SHA256: 'sha-2 256',
  SHA384: 'sha-2 384',
  SHA512: 'sha-2 512',
};
/** IOS's "aes 192|256" extend the key Cisco's way: AES192C and AES256C in the profile (1.0.4). */
const IOS_PRIV: Record<string, string> = {
  DES: 'des',
  AES: 'aes 128',
  AES192: 'aes 192',
  AES256: 'aes 256',
  AES192C: 'aes 192',
  AES256C: 'aes 256',
};
/** NX-OS offers AES-128 or DES (a bare "priv"), and MD5, SHA or SHA-2 except SHA-224. */
const NXOS_AUTH: Record<string, string> = {
  MD5: 'md5',
  SHA: 'sha',
  SHA256: 'sha-256',
  SHA384: 'sha-384',
  SHA512: 'sha-512',
};

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
    const level = s.level ?? 'authPriv';
    const authProto = s.authProto ?? 'SHA256';
    const auth = NXOS_AUTH[authProto];
    const privProto = s.privProto ?? 'AES';
    const notes: string[] = [];
    if (level !== 'noAuthNoPriv' && !auth)
      notes.push('! NX-OS has no SHA-224: choose SHA-256 in the profile.');
    if (level === 'authPriv' && privProto !== 'AES' && privProto !== 'DES')
      notes.push('! NX-OS encrypts with AES-128 or DES only: choose one of them in the profile.');
    const priv =
      level !== 'authPriv'
        ? ''
        : privProto === 'DES'
          ? ' priv <privacy-key>'
          : ' priv aes-128 <privacy-key>';
    const user_ =
      level === 'noAuthNoPriv'
        ? `snmp-server user ${user} network-operator`
        : `snmp-server user ${user} network-operator auth ${auth ?? 'sha-256'} <auth-key>${priv}`;
    return [
      'ip access-list WATCHLOG-SNMP',
      `  10 permit udp ${ip}/32 any eq snmp`,
      "! network-operator is NX-OS's read-only role.",
      ...notes,
      user_,
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
  const level = s.level ?? 'authPriv';
  const authProto = s.authProto ?? 'SHA256';
  const privProto = s.privProto ?? 'AES';
  const auth = IOS_AUTH[authProto] ?? 'sha';
  const priv = IOS_PRIV[privProto] ?? 'aes 128';
  // The group's level, and the user's protocols for it (1.0.4: all three levels).
  const groupLevel = level === 'authPriv' ? 'priv' : level === 'authNoPriv' ? 'auth' : 'noauth';
  const notes: string[] = [];
  if (level !== 'noAuthNoPriv' && authProto.startsWith('SHA') && authProto !== 'SHA')
    notes.push('! SHA-2 needs IOS XE 17 or later; on IOS 15 choose SHA in the profile.');
  if (level === 'authPriv' && (privProto === 'AES192' || privProto === 'AES256'))
    notes.push(
      `! IOS extends AES-${privProto.slice(3)} keys its own way: choose "AES-${privProto.slice(3)} (Cisco)" in the profile.`,
    );
  const userLine =
    level === 'noAuthNoPriv'
      ? `snmp-server user ${user} watchlog-ro v3 access WATCHLOG-SNMP`
      : level === 'authNoPriv'
        ? `snmp-server user ${user} watchlog-ro v3 auth ${auth} <auth-key> access WATCHLOG-SNMP`
        : `snmp-server user ${user} watchlog-ro v3 auth ${auth} <auth-key> priv ${priv} <privacy-key> access WATCHLOG-SNMP`;
  return [
    ...acl,
    'snmp-server view WATCHLOG-RO iso included',
    `snmp-server group watchlog-ro v3 ${groupLevel} read WATCHLOG-RO access WATCHLOG-SNMP`,
    '! The MAC table per VLAN (contexts vlan-<id>).',
    `snmp-server group watchlog-ro v3 ${groupLevel} context vlan- match prefix read WATCHLOG-RO access WATCHLOG-SNMP`,
    ...notes,
    userLine,
  ].join('\n');
}
