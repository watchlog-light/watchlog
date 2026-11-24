// SPDX-License-Identifier: AGPL-3.0-only
// Default rules from Enterprise modules (ADR-233): added to an org by the module when it
// starts using it (its first network device), evaluated like the core's (rules.ts looks them
// up by key). Without ee/ there are none, and rows an org kept from them have no evaluator
// and are skipped. A module's rule writes its own sentence (text.ts).
import type { DefaultRule } from './defaults.js';

const MODULE_RULES = new Map<string, DefaultRule>();

export function addModuleRules(rules: DefaultRule[]): void {
  for (const r of rules) MODULE_RULES.set(r.key, r);
}

export function moduleRules(): DefaultRule[] {
  return [...MODULE_RULES.values()];
}

export const isModuleRule = (key: string | null | undefined): boolean =>
  !!key && MODULE_RULES.has(key);
