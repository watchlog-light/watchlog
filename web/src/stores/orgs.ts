// SPDX-License-Identifier: AGPL-3.0-only
// Cloud (ADR-175): the orgs the user belongs to, for the header's org switcher.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { cloudApi, type OrgMembership } from '@/api/cloud';

export const useOrgsStore = defineStore('orgs', () => {
  const list = ref<OrgMembership[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    try {
      list.value = (await cloudApi.orgs()).orgs;
    } catch {
      list.value = []; // no switcher; the rest of the app still works
    }
    loaded.value = true;
  }

  /**
   * Makes `id` the session's current org. Every store holds the old org's data, so the app
   * starts again from the top (a full load), as a new sign-in would.
   */
  async function switchTo(id: string, reload: () => void = () => window.location.assign('/')) {
    await cloudApi.switchOrg(id);
    reload();
  }

  return { list, loaded, load, switchTo };
});
