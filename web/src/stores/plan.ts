// SPDX-License-Identifier: AGPL-3.0-only
// Cloud (ADR-177): the org's plan, limits and usage, for the plan strip, the banners and
// Settings › Plan & billing. Community never asks: it has no plan.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { cloudApi, type PlanInfo } from '@/api/cloud';

/** How often the shell asks again (the server's own cache is 60 s). */
export const PLAN_REFRESH_MS = 60_000;

export const usePlanStore = defineStore('plan', () => {
  const info = ref<PlanInfo | null>(null);
  const loaded = ref(false);

  async function load(): Promise<void> {
    try {
      info.value = await cloudApi.plan();
    } catch {
      // The pages never depend on it: no strip, no banner.
    }
    loaded.value = true;
  }

  /** Free (or another plan with a node limit) and a share of it used, for the bar. */
  const nodeShare = computed(() => {
    const p = info.value;
    if (!p || p.limits.nodes === null || p.limits.nodes === 0) return null;
    return Math.min(1, p.usage.nodes / p.limits.nodes);
  });

  return { info, loaded, load, nodeShare };
});
