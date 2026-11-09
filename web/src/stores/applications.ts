// SPDX-License-Identifier: AGPL-3.0-only
import type { Application } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api/client';

// The monitored services, shared by the Applications page and the navigation's problems
// count (SPEC §4.12).
export const useApplicationsStore = defineStore('applications', () => {
  const list = ref<Application[]>([]);
  const loaded = ref(false);
  const problems = computed(
    () => list.value.filter((a) => a.health === 'critical' || a.health === 'warning').length,
  );

  async function load(): Promise<Application[]> {
    const res = await api<{ applications: Application[] }>('/applications');
    list.value = res.applications;
    loaded.value = true;
    return res.applications;
  }

  function reset() {
    list.value = [];
    loaded.value = false;
  }

  return { list, loaded, problems, load, reset };
});
