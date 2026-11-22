<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useProOffer } from '@/composables/useProOffer';
import { usePlanStore } from '@/stores/plan';

// The plan strip (ADR-177, Dashboard.dc.html), Cloud only: "Free plan · 3 of 5 nodes ·
// 3 days of data · 1 user · Upgrade to Pro · $3 per node →" with the real counts. On the
// overview below 1024 px; the sidebar has its compact plan line instead (PlanLine, 0.10.1). The
// beta's Pro says "free during beta" next to the plan's name (ADR-178). The plan's name is
// the org's entitlement, which also decides the Pro features (ADR-205), so the strip and What
// changed always agree. Free's link is the one offer every page makes (useProOffer):
// "Upgrade to Pro · $3 per node" with the price from GET /plan, and "Try Pro, free during
// beta" only while the billing service says it is off.
defineProps<{ inline?: boolean }>();
const { t } = useI18n();
const plan = usePlanStore();
const p = computed(() => plan.info);
const share = computed(() => plan.nodeShare);
const full = computed(() => share.value !== null && share.value >= 1);
const BILLING = { name: 'settings', query: { tab: 'billing' } } as const;
const offer = useProOffer();
const linkText = computed(() => {
  const info = p.value;
  if (!info || info.plan !== 'free') return t('cloud.plan.manage');
  return offer.link.value;
});
</script>

<template>
  <section
    v-if="p"
    :class="[
      'flex flex-col gap-2.5 rounded-card border border-border p-3.5',
      inline ? 'bg-surface-1' : 'bg-bg',
    ]"
    :aria-label="$t('cloud.plan.label')"
    data-testid="plan-strip"
  >
    <div class="flex items-baseline justify-between gap-3 text-13">
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <b class="font-semibold text-text">{{ $t(`cloud.plan.name.${p.plan}`) }}</b>
        <span
          v-if="p.plan === 'pro' && p.source === 'beta'"
          class="text-12 text-link"
          data-testid="plan-beta"
          >{{ $t('cloud.plan.betaTag') }}</span
        >
      </span>
      <span class="shrink-0 whitespace-nowrap text-text-muted" data-testid="plan-nodes">
        {{
          p.limits.nodes === null
            ? $t('cloud.plan.nodes', { n: p.usage.nodes }, p.usage.nodes)
            : $t('cloud.plan.nodesOf', { n: p.usage.nodes, max: p.limits.nodes })
        }}
      </span>
    </div>
    <div
      v-if="share !== null"
      class="h-1.5 rounded-full bg-surface-3"
      role="progressbar"
      :aria-valuenow="p.usage.nodes"
      aria-valuemin="0"
      :aria-valuemax="p.limits.nodes ?? undefined"
      :aria-label="$t('cloud.plan.nodesBar')"
    >
      <div
        :class="['h-1.5 rounded-full', full ? 'bg-warning' : 'bg-primary']"
        :style="{ width: `${Math.max(2, Math.round(share * 100))}%` }"
      />
    </div>
    <p class="text-12 text-text-muted">
      {{ $t('cloud.plan.days', { n: p.limits.retentionDays }, p.limits.retentionDays) }} ·
      {{
        p.limits.users === null
          ? $t('cloud.plan.usersUnlimited')
          : p.limits.users === 1
            ? $t('cloud.plan.users', { n: 1 }, 1)
            : $t('cloud.plan.usersUpTo', { n: p.limits.users })
      }}
    </p>
    <RouterLink
      :to="BILLING"
      class="text-13 font-semibold text-link hover:text-primary-hover"
      data-testid="plan-try-pro"
    >
      {{ linkText }}
    </RouterLink>
  </section>
</template>
