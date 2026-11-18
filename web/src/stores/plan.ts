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
   * strip's "Upgrade to Pro · $3 per node" (ADR-205), or "Try Pro, free during beta" while
   * billing itself says it is off. Null: not asked, or billing couldn't be reached, which is
   * never read as "free" (0.9.5).
   */
  const billing = ref<BillingState | null>(null);

  let pending: Promise<void> | null = null;
  /** Reads the plan (and, for a Free org, billing's switch). Callers at once share one read. */
  function load(): Promise<void> {
    pending ??= read().finally(() => (pending = null));
    return pending;
  }
  async function read(): Promise<void> {
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

  /**
   * The beta's free Pro is on offer: the billing service answered, and its live switch is
   * off. Anything else (live, out of reach, not asked) offers the paid upgrade.
   */
  const betaOpen = computed(
    () => !!billing.value && billing.value.available && !billing.value.live,
  );

  /** Free (or another plan with a node limit) and a share of it used, for the bar. */
  const nodeShare = computed(() => {
    const p = info.value;
    if (!p || p.limits.nodes === null || p.limits.nodes === 0) return null;
    return Math.min(1, p.usage.nodes / p.limits.nodes);
  });

  return { info, loaded, load, nodeShare, billing, billingLive, betaOpen };
});
