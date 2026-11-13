// SPDX-License-Identifier: AGPL-3.0-only
// Cloud (ADR-181): the org's deletion, suspension and inactivity state, for the banner over
// every page and Settings › Data. Community never asks.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { cloudApi, type OrgStatus } from '@/api/cloud';

export const useOrgStatusStore = defineStore('orgStatus', () => {
  const status = ref<OrgStatus | null>(null);

  async function load(): Promise<void> {
    try {
      status.value = await cloudApi.orgStatus();
    } catch {
      // The pages never depend on it: no banner.
    }
  }

  function set(s: OrgStatus): void {
    status.value = s;
  }

  return { status, load, set };
});
