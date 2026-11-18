// SPDX-License-Identifier: AGPL-3.0-only
// Server, Compose project and workload names for the top bar's Server fleet filters, filled
// by the fleet's pages from data they already load (workloads: `service:<unit>`,
// `process:<group>`, `container:<name>`, from the Events page's summary).
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useDockerScopeStore = defineStore('dockerScope', () => {
  const hosts = ref<string[]>([]);
  const projects = ref<string[]>([]);
  const workloads = ref<string[]>([]);
  return { hosts, projects, workloads };
});
