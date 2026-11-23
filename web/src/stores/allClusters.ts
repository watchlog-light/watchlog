// SPDX-License-Identifier: AGPL-3.0-only
// "All clusters and fleets" (ADR-226): who has it, and the org-wide summary the page, the
// sidebar's list and the switcher's line share. Community never asks (the route isn't there);
// Cloud and the demo ask, and a 403 `pro-feature` means Free. The sidebar and the switcher
// read the default view (24 hours, every kind), refreshed at most once a minute.
import type { AllClusters } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import {
  allClustersPath,
  DEFAULT_RANGE,
  initialAccess,
  isLicenseEnded,
  isProFeature,
  type Access,
  type Kind,
} from '@/lib/all-clusters';
import { useAuthStore } from './auth';

const FRESH_MS = 60_000;

export const useAllClustersStore = defineStore('allClusters', () => {
  const access = ref<Access | null>(null);
  /** The default view: 24 hours, every kind. */
  const summary = ref<AllClusters | null>(null);
  let loadedAt = 0;
  let pending: Promise<AllClusters | null> | null = null;

  /** One view of the page; the default one is kept for the sidebar and the switcher. */
  async function fetch(range = DEFAULT_RANGE, kind: Kind = 'all'): Promise<AllClusters | null> {
    const auth = useAuthStore();
    access.value ??= initialAccess(auth.proOnServer, auth.demoMode);
    if (access.value === 'community' || access.value === 'free' || access.value === 'ended') {
      return null;
    }
    try {
      const answer = await api<AllClusters>(allClustersPath(range, kind));
      access.value = 'pro';
      if (range === DEFAULT_RANGE && kind === 'all') {
        summary.value = answer;
        loadedAt = Date.now();
      }
      return answer;
    } catch (err) {
      if (isProFeature(err)) {
        access.value = 'free';
        return null;
      }
      if (isLicenseEnded(err)) {
        access.value = 'ended';
        return null;
      }
      throw err;
    }
  }

  /** The default view, reused for a minute; errors leave the sidebar as it was. */
  function ensure(): Promise<AllClusters | null> {
    if (summary.value && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(summary.value);
    pending ??= fetch()
      .catch(() => summary.value)
      .finally(() => (pending = null));
    return pending;
  }

  function reset() {
    access.value = null;
    summary.value = null;
    loadedAt = 0;
  }

  return { access, summary, fetch, ensure, reset };
});
