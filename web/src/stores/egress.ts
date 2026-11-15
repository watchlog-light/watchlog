// SPDX-License-Identifier: AGPL-3.0-only
import type { Egress } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import { egressPath } from '@/lib/egress';

// The navigation's "N new" beside Egress (ADR-188): destinations first seen in the last 24
// hours, per cluster. The Egress page sets it on every unfiltered load; the sidebar reads it
// once per selected cluster. A failed read leaves no count (the page says what failed).
export const useEgressStore = defineStore('egress', () => {
  const newCount = ref<Record<string, number>>({});
  const asked = new Set<string>();

  function set(clusterId: string, n: number) {
    newCount.value = { ...newCount.value, [clusterId]: n };
  }

  async function load(clusterId: string) {
    if (asked.has(clusterId)) return;
    asked.add(clusterId);
    try {
      const res = await api<Egress>(egressPath(clusterId, {}));
      set(clusterId, res.summary.new);
    } catch {
      asked.delete(clusterId);
    }
  }

  function reset() {
    newCount.value = {};
    asked.clear();
  }

  return { newCount, set, load, reset };
});
