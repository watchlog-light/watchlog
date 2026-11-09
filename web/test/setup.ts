// SPDX-License-Identifier: AGPL-3.0-only
// Every test fails when a component renders an i18n key en.json doesn't have, such as a
// key built from data (`applications.monitor.alert.${key}`) that a literal-key scan can't
// see. The key would show raw on screen.
import { afterEach, beforeEach, expect } from 'vitest';
import { missingKeys } from '@/i18n';

let missing: string[] = [];
beforeEach(() => {
  missing = [];
  missingKeys.report = (key) => missing.push(key);
});
afterEach(() => {
  const keys = [...new Set(missing)];
  missingKeys.report = undefined;
  expect(keys, 'i18n keys rendered but missing from en.json').toEqual([]);
});
