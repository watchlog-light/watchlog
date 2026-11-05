// SPDX-License-Identifier: AGPL-3.0-only
// The selected cluster or Docker fleet: one selection for every page. It changes only
// in the cluster switcher or through `?cluster=` in a link, is kept in the URL and
// remembered per user in this browser. The Kubernetes and Docker stores read it.
import type { Cluster, ClusterList } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import { useAuthStore } from './auth';

const KEY = 'watchlog.cluster';

export const useClustersStore = defineStore('clusters', () => {
  const list = ref<Cluster[]>([]);
  const loaded = ref(false);
  const selectedId = ref<string | null>(null);
  let pending: Promise<Cluster[]> | null = null;

  const storageKey = () => `${KEY}.${(useAuthStore().user as { id?: string } | null)?.id ?? ''}`;
  function remembered(): string | null {
    try {
      return localStorage.getItem(storageKey());
    } catch {
      return null;
    }
  }
  function remember(id: string) {
    try {
      localStorage.setItem(storageKey(), id);
    } catch {
      // Private windows: the selection lasts for this visit (and stays in the URL).
    }
  }

  const selected = computed<Cluster | null>(
    () => list.value.find((c) => c.id === selectedId.value) ?? null,
  );

  /**
   * Loads the list. A selection that still exists is kept; otherwise the remembered
   * one, else the first Kubernetes cluster, else the first fleet. Nothing else ever
   * changes it.
   */
  async function load(): Promise<Cluster[]> {
    pending ??= api<ClusterList>('/clusters')
      .then(({ clusters }) => {
        list.value = clusters;
        loaded.value = true;
        const has = (id: string | null) => !!id && clusters.some((c) => c.id === id);
        if (!has(selectedId.value)) {
          const r = remembered();
          selectedId.value = has(r)
            ? r
            : ((clusters.find((c) => c.kind === 'kubernetes') ?? clusters[0])?.id ?? null);
        }
        return clusters;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  /** The selected cluster, loading the list once. */
  async function ensure(): Promise<Cluster | null> {
    if (!loaded.value) await load();
    return selected.value;
  }

  /** Selects a cluster (the switcher, or `?cluster=` in a link). */
  function select(id: string): boolean {
    if (!list.value.some((c) => c.id === id)) return false;
    selectedId.value = id;
    remember(id);
    return true;
  }

  function reset() {
    list.value = [];
    loaded.value = false;
    selectedId.value = null;
  }

  return { list, loaded, selectedId, selected, load, ensure, select, reset };
});
