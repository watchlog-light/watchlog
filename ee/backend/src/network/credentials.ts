// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Credential profiles (ADR-233): one SNMPv3 (or v2c) login, or one RouterOS user, used by
// several devices. What's secret (community, keys, password) is encrypted with the install's
// key, bound to its row, never read back by the API: only the pollers of its devices get it,
// in their configuration.
import type { EeHost } from '../../../../backend/src/ee-contract.js';

/**
 * SNMPv3's protocols (ADR-233, amended in 1.0.4): SHA-2 or SHA with AES are recommended; MD5
 * and DES are for older devices that offer nothing else (QNAP's QTS encrypts with DES only);
 * AES192C and AES256C are AES with the key extension Cisco IOS uses for "priv aes 192|256".
 */
export const AUTH_PROTOS = ['SHA256', 'SHA', 'SHA224', 'SHA384', 'SHA512', 'MD5'] as const;
export const PRIV_PROTOS = ['AES', 'AES192', 'AES256', 'AES192C', 'AES256C', 'DES'] as const;
/** The security levels, chosen in the form; authPriv when a profile says none (before 1.0.4). */
export const LEVELS = ['authPriv', 'authNoPriv', 'noAuthNoPriv'] as const;
export type SnmpLevel = (typeof LEVELS)[number];

export type SnmpSettings = {
  version: '3' | '2c';
  user?: string;
  level?: SnmpLevel;
  authProto?: (typeof AUTH_PROTOS)[number];
  privProto?: (typeof PRIV_PROTOS)[number];
  port?: number;
};

/** What a profile's protocols need of the collector: MD5, DES, Cisco's AES and the lower levels came in 1.0.4. */
export function needs104(s: SnmpSettings): boolean {
  if (s.version !== '3') return false;
  const level = s.level ?? 'authPriv';
  if (level === 'noAuthNoPriv') return true;
  if (s.authProto === 'MD5') return true;
  return (
    level === 'authPriv' &&
    (s.privProto === 'DES' || s.privProto === 'AES192C' || s.privProto === 'AES256C')
  );
}

/**
 * How strong a profile's protection is, for the small mark on its card and its devices' pages
 * (1.0.4): "older" for MD5 or DES, "plain" without privacy (v2c's community travels in clear too).
 */
export function strengthOf(protocol: string, settings: unknown): 'older' | 'plain' | null {
  if (protocol !== 'snmp') return null;
  const s = (settings ?? {}) as SnmpSettings;
  if (s.version === '2c') return 'plain';
  const level = s.level ?? 'authPriv';
  if (level !== 'authPriv') return 'plain';
  if (s.authProto === 'MD5' || s.privProto === 'DES') return 'older';
  return null;
}
export type SnmpSecret = { community?: string; authKey?: string; privKey?: string };
export type RosSettings = {
  user: string;
  transport?: 'rest' | 'api-ssl' | 'api';
  allowPlain?: boolean;
  port?: number;
};
export type RosSecret = { password?: string };
/** A recorder's read-only HTTP user (Dahua, ADR-234): digest auth, HTTPS pinned like RouterOS. */
export type DahuaSettings = { user: string; https?: boolean; port?: number };

export interface CredentialRow {
  id: string;
  org_id: string;
  name: string;
  protocol: 'snmp' | 'routeros' | 'dahua';
  settings: SnmpSettings | RosSettings | DahuaSettings;
  ciphertext: string | null;
}

/** What the API shows of a profile: never the secret, only whether it is set. */
export function credentialView(r: CredentialRow, usedBy: number) {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    settings: r.settings,
    secretSet: !!r.ciphertext,
    usedBy,
    strength: strengthOf(r.protocol, r.settings),
  };
}

export const aadOf = (id: string) => `network_credentials:${id}`;

export function sealSecret(host: EeHost, id: string, secret: SnmpSecret | RosSecret): string {
  return host.secrets.encrypt(JSON.stringify(secret), aadOf(id));
}

/** The secret, or null when it can't be opened (a key mismatch): that device then can't log in. */
export function openSecret(host: EeHost, r: Pick<CredentialRow, 'id' | 'ciphertext'>) {
  if (!r.ciphertext) return {};
  try {
    return JSON.parse(host.secrets.decrypt(r.ciphertext, aadOf(r.id))) as SnmpSecret & RosSecret;
  } catch {
    return null;
  }
}

/** The collector's form of a credential (ee/collector/network/config.go). */
export function collectorCredential(host: EeHost, r: CredentialRow, pin?: string | null) {
  const secret = openSecret(host, r);
  if (secret === null) return null;
  if (r.protocol === 'snmp') {
    const s = r.settings as SnmpSettings;
    return {
      snmp: {
        version: s.version,
        ...(s.port ? { port: s.port } : {}),
        ...(s.version === '2c' ? { community: secret.community ?? '' } : v3Wire(s, secret)),
      },
    };
  }
  if (r.protocol === 'dahua') {
    const s = r.settings as DahuaSettings;
    return {
      dahua: {
        user: s.user,
        password: secret.password ?? '',
        ...(s.https ? { https: true } : {}),
        ...(s.port ? { port: s.port } : {}),
        ...(pin && s.https ? { pin } : {}),
      },
    };
  }
  const s = r.settings as RosSettings;
  return {
    routeros: {
      user: s.user,
      password: secret.password ?? '',
      ...(s.transport ? { transport: s.transport } : {}),
      ...(s.port ? { port: s.port } : {}),
      ...(s.allowPlain ? { allowPlain: true } : {}),
      ...(pin ? { pin } : {}),
    },
  };
}

/**
 * An SNMPv3 profile as the collector reads it (ee/collector/network/snmp.go): the level is
 * said with NONE, which a collector before 1.0.4 knows only for privacy.
 */
function v3Wire(s: SnmpSettings, secret: SnmpSecret) {
  const level = s.level ?? 'authPriv';
  if (level === 'noAuthNoPriv') return { user: s.user ?? '', authProto: 'NONE', privProto: 'NONE' };
  const auth = {
    user: s.user ?? '',
    authProto: s.authProto ?? 'SHA256',
    authKey: secret.authKey ?? '',
  };
  if (level === 'authNoPriv') return { ...auth, privProto: 'NONE' };
  return { ...auth, privProto: s.privProto ?? 'AES', privKey: secret.privKey ?? '' };
}

/**
 * A collector older than 1.0.4 refusing a profile it can't read (ee/collector/network/snmp.go
 * before 1.0.4: `SNMPv3 privacy "DES" isn't supported (AES)`): what it can't read, or null.
 */
export function olderCollector(error: string | null | undefined): string | null {
  const m =
    /SNMPv3 (?:privacy|authentication) "([A-Za-z0-9]+)" isn't supported \((?:AES|SHA or SHA-2)\)/.exec(
      error ?? '',
    );
  if (!m) return null;
  const v = m[1]!.toUpperCase();
  if (v === 'NONE') return 'no authentication';
  if (v === 'AES192C' || v === 'AES256C') return `Cisco's ${v.slice(0, 6)}`;
  return v;
}

/**
 * "Find what works" (1.0.4): the profile's passwords with each combination of protocols, its
 * own first, in an order that reaches the usual devices early. The collector tries them one at
 * a time and lets what the device reports rule out the rest (ee/collector/network/discovery.go).
 */
export function findOrder(settings: Record<string, unknown>): { auth: string; priv: string }[] {
  const first = <T extends string>(own: unknown, all: readonly T[]) =>
    typeof own === 'string' && all.includes(own as T)
      ? [own as T, ...all.filter((x) => x !== own)]
      : [...all];
  const auths = first(settings.authProto, FIND_AUTH);
  const level = (settings.level as string | undefined) ?? 'authPriv';
  const privs = level === 'authPriv' ? first(settings.privProto, FIND_PRIV) : ['NONE'];
  return auths.flatMap((auth) => privs.map((priv) => ({ auth, priv })));
}
const FIND_AUTH = ['SHA', 'SHA256', 'MD5', 'SHA512', 'SHA384', 'SHA224'] as const;
const FIND_PRIV = ['AES', 'DES', 'AES256', 'AES192', 'AES256C', 'AES192C'] as const;
