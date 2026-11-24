// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// A MAC address's vendor from the IEEE MA-L registry (ADR-233, oui-data.ts). Locally
// administered addresses (virtual machines, containers, randomised phones) have none.
import { PREFIXES, VENDORS } from './oui-data.js';

const ENTRY = 9;
let names: string[] | null = null;

/** The vendor of a MAC address ("00:1b:2b:…" → "Cisco Systems"), or '' when unknown. */
export function vendorOf(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 6) return '';
  // The locally administered bit: no registered vendor.
  if (parseInt(hex.slice(0, 2), 16) & 0x02) return '';
  const prefix = hex.slice(0, 6);
  let lo = 0;
  let hi = PREFIXES.length / ENTRY - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = PREFIXES.slice(mid * ENTRY, mid * ENTRY + 6);
    if (p === prefix) {
      names ??= VENDORS.split('\n');
      return names[parseInt(PREFIXES.slice(mid * ENTRY + 6, mid * ENTRY + 9), 36)] ?? '';
    }
    if (p < prefix) lo = mid + 1;
    else hi = mid - 1;
  }
  return '';
}
