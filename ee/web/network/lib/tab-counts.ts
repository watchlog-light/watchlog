// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The tabs' counts (GET /network/kinds, ADR-234), read once a minute at most: every network
// page shows the header, and moving between tabs shouldn't ask again.
import { ref } from 'vue';
import { networkApi, type Kinds } from '../api';

export const tabCounts = ref<Kinds | null>(null);
let at = 0;
let pending: Promise<void> | null = null;

export function loadTabCounts(maxAgeMs = 60_000): Promise<void> {
  if (tabCounts.value && Date.now() - at < maxAgeMs) return Promise.resolve();
  pending ??= networkApi
    .kinds()
    .then((k) => {
      tabCounts.value = k;
      at = Date.now();
    })
    .catch(() => undefined)
    .finally(() => {
      pending = null;
    });
  return pending;
}
