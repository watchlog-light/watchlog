// SPDX-License-Identifier: AGPL-3.0-only
import { createI18n } from 'vue-i18n';
import en from './en.json';

export type MessageSchema = typeof en;

export function createAppI18n() {
  return createI18n<[MessageSchema], 'en'>({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
  });
}
