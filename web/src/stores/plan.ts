// SPDX-License-Identifier: AGPL-3.0-only
// Cloud (ADR-177): the org's plan, limits and usage, for the plan strip, the banners and
// Settings › Plan & billing. Community never asks: it has no plan.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { cloudApi, type BillingState, type PlanInfo } from '@/api/cloud';

/** How often the shell asks again (the server's own cache is 60 s). */
export const PLAN_REFRESH_MS = 60_000;

export const usePlanStore = defineStore('plan', () => {
  const info = ref<PlanInfo | null>(null);
  const loaded = ref(false);
  /**
   * The billing service's live switch (ADR-178), read once a session for a Free org: the
   * strip's "Try Pro, free during beta" while it is off, "Upgrade to Pro · $1 per node" once
   * it is on (ADR-205). Null: not asked, or billing couldn't be reached (the beta's text).
   */
  const billing = ref<BillingState | null>(null);

  async function load(): Promise<void> {
    try {
      info.value = await cloudApi.plan();
    } catch {
      // The pages never depend on it: no strip, no banner.
    }
    if (info.value?.plan === 'free' && billing.value === null) {
      billing.value = await cloudApi.billing().catch(() => null);
    }
    loaded.value = true;
  }

  /** Billing is live (Checkout and the portal), not the beta. */
  const billingLive = computed(() => !!(billing.value?.available && billing.value.live));

  /** Free (or another plan with a node limit) and a share of it used, for the bar. */
  const nodeShare = computed(() => {
    const p = info.value;
    if (!p || p.limits.nodes === null || p.limits.nodes === 0) return null;
    return Math.min(1, p.usage.nodes / p.limits.nodes);
  });

  return { info, loaded, load, nodeShare, billing, billingLive };
});
