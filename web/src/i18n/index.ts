// SPDX-License-Identifier: AGPL-3.0-only
import { createI18n } from 'vue-i18n';
import en from './en.json';

export type MessageSchema = typeof en;

/**
 * Called with every key a component asks for that en.json doesn't have. Tests set it
 * (test/setup.ts) so a raw key on screen fails them; in the app it stays unset and
 * vue-i18n's own warning applies.
 */
export const missingKeys: { report?: (key: string) => void } = {};

export function createAppI18n() {
  return createI18n<[MessageSchema], 'en'>({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
    missing: (_locale, key) => {
      missingKeys.report?.(key);
    },
  });
}
