// SPDX-License-Identifier: AGPL-3.0-only
// The process-group rules' preview (ADR-207/208): the agent's matching (the procs collector's
// rules.go) run in the browser on a process the user types. The agent's patterns are RE2;
// JavaScript reads the same simple patterns the same way.
import type { ProcessRule } from '@watchlog/api-types';

export const MAX_NAME = 63;

/** A glob (*, ?, [..]) as path.Match reads it, as a whole-string regular expression. */
export function globRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) out += '\\[';
      else {
        out += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The group a process gets from the rules, and which rule (1-based); null when none match. */
export function previewRules(
  rules: ProcessRule[],
  p: { exe: string; unit: string; args: string },
): { name: string; rule: number } | null {
  for (const [i, r] of rules.entries()) {
    try {
      if (r.exe && !globRegExp(r.exe).test(p.exe)) continue;
      if (r.unit && !globRegExp(r.unit).test(p.unit)) continue;
      let name = r.name;
      if (r.args) {
        const m = new RegExp(r.args).exec(p.args);
        if (!m) continue;
        for (let k = Math.min(m.length - 1, 9); k >= 1; k--) {
          name = name.replaceAll(`$${k}`, m[k] ?? '');
        }
      }
      return { name: name.trim().slice(0, MAX_NAME) || 'unnamed', rule: i + 1 };
    } catch {
      // A pattern that doesn't compile is skipped, as on the agent.
    }
  }
  return null;
}
