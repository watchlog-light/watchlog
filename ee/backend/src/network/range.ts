// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// A discovery's range (ADR-233): IPv4, a /24 or smaller (the poller sweeps it at 20 a second).
export class RangeError extends Error {}

export function validRange(cidr: string): { base: string; bits: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || m.slice(1, 5).some((p) => Number(p) > 255))
    throw new RangeError(`"${cidr}" isn't a range like 10.0.10.0/24`);
  const bits = Number(m[5]);
  if (bits < 24 || bits > 32) throw new RangeError(`${cidr} is wider than a /24`);
  return { base: m.slice(1, 5).join('.'), bits };
}
