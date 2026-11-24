// SPDX-License-Identifier: AGPL-3.0-only
import { HEADLINES } from '@watchlog/cause-words';
import { createI18n } from 'vue-i18n';
import enFile from './en.json';

/**
 * The English messages: en.json (and ee/'s), with the probable-cause headlines (causes.headline.<code>)
 * from @watchlog/cause-words, the templates the notifications render too (ADR-157).
 */
/**
 * Enterprise modules' words (ee/web/<module>/messages*.json, ADR-232), found at build time like
 * their pages; none without ee/.
 */
const eeMessages = Object.values(
  import.meta.glob<{ default: Record<string, unknown> }>('../../../ee/web/*/messages*.json', {
    eager: true,
  }),
).reduce<Record<string, unknown>>((all, m) => ({ ...all, ...m.default }), {});

export const en = {
  ...eeMessages,
  ...enFile,
  causes: { ...enFile.causes, headline: HEADLINES },
} as typeof enFile & { causes: typeof enFile.causes & { headline: typeof HEADLINES } };

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
