// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiToken } from '@watchlog/api-types';
import { useI18n } from 'vue-i18n';
import { callsLabel, expiryNote, formatDay, lastUsedLabel } from '@/lib/api-tokens';

/** The words for a token's columns, shared by the list, the detail and the revoke dialog. */
export function useApiTokenText() {
  const { t } = useI18n();
  return {
    expires: (tk: ApiToken) => (tk.expiresAt ? formatDay(tk.expiresAt) : t('apiTokens.never')),
    note: (tk: ApiToken) => {
      const n = expiryNote(tk);
      return {
        text: t(n.key, n.values ?? {}, (n.values?.n as number | undefined) ?? 0),
        warn: n.warn,
      };
    },
    lastUsed: (tk: ApiToken) =>
      tk.lastUsedAt ? lastUsedLabel(tk.lastUsedAt) : t('apiTokens.neverUsed'),
    calls: (tk: ApiToken) => {
      const c = callsLabel(tk);
      return t(c.key, { n: c.n ?? 0 }, c.n ?? 0);
    },
  };
}
