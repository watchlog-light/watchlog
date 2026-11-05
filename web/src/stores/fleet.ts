// SPDX-License-Identifier: AGPL-3.0-only
// The Docker fleet the Docker pages show: the selected cluster when it is a fleet.
import type { Cluster } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useClustersStore } from './clusters';

export const useFleetStore = defineStore('fleet', () => {
  const clusters = useClustersStore();
  const fleet = computed<Cluster | null>(() =>
    clusters.selected?.kind === 'docker' ? clusters.selected : null,
  );
  const loaded = computed(() => clusters.loaded);

  async function load(): Promise<Cluster | null> {
    await clusters.load();
    return fleet.value;
  }

  /** The fleet, loading the list once. */
  async function ensure(): Promise<Cluster | null> {
    await clusters.ensure();
    return fleet.value;
  }

  return { fleet, loaded, load, ensure };
});
