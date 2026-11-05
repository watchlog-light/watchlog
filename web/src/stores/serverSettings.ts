// SPDX-License-Identifier: AGPL-3.0-only
// Settings of this installation made in the UI (alerts redesign, ADR-093).
import type { GeneralSettings } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';

export const useServerSettingsStore = defineStore('serverSettings', () => {
  const general = ref<GeneralSettings | null>(null);

  async function loadGeneral() {
    general.value = await api<GeneralSettings>('/settings/general');
    return general.value;
  }

  async function savePublicUrl(publicUrl: string | null) {
    general.value = await api<GeneralSettings>('/settings/general', {
      method: 'PUT',
      body: { publicUrl },
    });
    return general.value;
  }

  return { general, loadGeneral, savePublicUrl };
});
