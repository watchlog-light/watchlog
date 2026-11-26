// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// SNMPv3's protocols as the profile form offers them (ADR-233, amended in 1.0.4): grouped into
// what is recommended and what is for older devices, with the names people know them by.

export type Level = 'authPriv' | 'authNoPriv' | 'noAuthNoPriv';
export const LEVELS: Level[] = ['authPriv', 'authNoPriv', 'noAuthNoPriv'];

/** Recommended first; MD5 only for devices that offer nothing better (QNAP's QTS: MD5 or SHA). */
export const AUTH_RECOMMENDED = ['SHA256', 'SHA', 'SHA224', 'SHA384', 'SHA512'];
export const AUTH_OLDER = ['MD5'];
/** AES with Cisco's key extension for IOS's "priv aes 192|256" (AES192C, AES256C). */
export const PRIV_RECOMMENDED = ['AES', 'AES192', 'AES256', 'AES192C', 'AES256C'];
/** DES is what QTS means by "Use Privacy". */
export const PRIV_OLDER = ['DES'];

export function authLabel(p: string): string {
  if (p === 'SHA') return 'SHA-1';
  if (p === 'MD5') return 'MD5';
  return p.replace('SHA', 'SHA-');
}

export function privLabel(p: string): string {
  if (p === 'DES') return 'DES';
  if (p === 'AES') return 'AES-128';
  const bits = p.slice(3, 6);
  return p.endsWith('C') ? `AES-${bits} (Cisco)` : `AES-${bits}`;
}

/** MD5 or DES: weak by today's standards, used only where a device offers nothing else. */
export const isOlder = (auth: string, priv: string | null): boolean =>
  auth === 'MD5' || priv === 'DES';

/** A device whose profile match is a QNAP (QTS): SHA with DES, because QTS encrypts with DES. */
export const QNAP_PRESET = { authProto: 'SHA', privProto: 'DES' } as const;
