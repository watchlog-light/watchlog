// SPDX-License-Identifier: AGPL-3.0-only
import type { WhatChangedLearning } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';

// The navigation's "day 3/7" beside What changed (ADR-216): the learning state of each
// cluster or fleet the shell has shown. The page sets it on every load; the sidebar reads it
// once per selected cluster, and only for an org with Pro (anyone else would get a 403, and
// Community a 404). A failed read leaves no hint.
export const useWhatChangedLearningStore = defineStore('whatChangedLearning', () => {
  const state = ref<Record<string, WhatChangedLearning>>({});
  const asked = new Set<string>();

  function set(clusterId: string, l: WhatChangedLearning) {
    asked.add(clusterId);
    state.value = { ...state.value, [clusterId]: l };
  }

  async function load(clusterId: string) {
    if (asked.has(clusterId)) return;
    asked.add(clusterId);
    try {
      const r = await api<{ learning: WhatChangedLearning }>(
        `/what-changed/learning?cluster=${encodeURIComponent(clusterId)}`,
      );
      set(clusterId, r.learning);
    } catch {
      asked.delete(clusterId);
    }
  }

  function reset() {
    state.value = {};
    asked.clear();
  }

  return { state, set, load, reset };
});
