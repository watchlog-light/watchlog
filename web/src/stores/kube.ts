// SPDX-License-Identifier: AGPL-3.0-only
// The Kubernetes cluster the cluster pages show: the selected cluster when it is one.
import type { Cluster } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useClustersStore } from './clusters';

export const useKubeStore = defineStore('kube', () => {
  const clusters = useClustersStore();
  const cluster = computed<Cluster | null>(() =>
    clusters.selected?.kind === 'kubernetes' ? clusters.selected : null,
  );
  const loaded = computed(() => clusters.loaded);
  /** Namespace names for the top bar's filter, filled by the pages. */
  const namespaces = ref<string[]>([]);

  async function load(): Promise<Cluster | null> {
    await clusters.load();
    return cluster.value;
  }

  /** The cluster, loading the list once. */
  async function ensure(): Promise<Cluster | null> {
    await clusters.ensure();
    return cluster.value;
  }

  return { cluster, loaded, namespaces, load, ensure };
});
