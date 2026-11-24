// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// Credential profiles (ADR-233): one SNMPv3 (or v2c) login, or one RouterOS user, used by
// several devices. What's secret (community, keys, password) is encrypted with the install's
// key, bound to its row, never read back by the API: only the pollers of its devices get it,
// in their configuration.
import type { EeHost } from '../../../../backend/src/ee-contract.js';

export type SnmpSettings = {
  version: '3' | '2c';
  user?: string;
  authProto?: 'SHA' | 'SHA224' | 'SHA256' | 'SHA384' | 'SHA512';
  privProto?: 'AES' | 'AES192' | 'AES256';
  port?: number;
};
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
        ...(s.version === '2c'
          ? { community: secret.community ?? '' }
          : {
              user: s.user ?? '',
              authProto: s.authProto ?? 'SHA256',
              authKey: secret.authKey ?? '',
              privProto: s.privProto ?? 'AES',
              privKey: secret.privKey ?? '',
            }),
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
