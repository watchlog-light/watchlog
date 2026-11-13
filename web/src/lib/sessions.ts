// SPDX-License-Identifier: AGPL-3.0-only
// Settings › Security's sessions list (ADR-175): a browser's user agent in a few words.

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/curl\//, 'curl'],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iOS/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/** "Firefox on macOS", "Chrome", or null when nothing is known. */
export function describeAgent(
  ua: string | null | undefined,
): { browser?: string; os?: string } | null {
  if (!ua) return null;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return browser || os ? { browser, os } : null;
}
