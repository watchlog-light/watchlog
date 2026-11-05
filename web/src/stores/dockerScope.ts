// SPDX-License-Identifier: AGPL-3.0-only
// Host and Compose project names for the top bar's Docker filters, filled by the
// Docker pages from data they already load.
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useDockerScopeStore = defineStore('dockerScope', () => {
  const hosts = ref<string[]>([]);
  const projects = ref<string[]>([]);
  return { hosts, projects };
});
