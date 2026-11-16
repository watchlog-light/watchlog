<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { money } from '@/lib/what-changed-upgrade';
import { usePlanStore } from '@/stores/plan';

// The plan strip (ADR-177, Dashboard.dc.html), Cloud only: "Free plan · 3 of 5 nodes ·
// 3 days of data · 1 user · Try Pro, free during beta →" with the real counts. In the
// sidebar from 1024 px; on the overview below it (the sidebar is a drawer there). The
// beta's Pro says "free during beta" next to the plan's name (ADR-178). The plan's name is
// the org's entitlement, which also decides the Pro features (ADR-205), so the strip and What
// changed always agree. Free's link: "Try Pro, free during beta" while billing is off,
// "Upgrade to Pro · $1 per node" once it is live (the price from GET /plan).
defineProps<{ inline?: boolean }>();
const { t } = useI18n();
const plan = usePlanStore();
const p = computed(() => plan.info);
const share = computed(() => plan.nodeShare);
const full = computed(() => share.value !== null && share.value >= 1);
const BILLING = { name: 'settings', query: { tab: 'billing' } } as const;
const linkText = computed(() => {
  const info = p.value;
  if (!info || info.plan !== 'free') return t('cloud.plan.manage');
  if (plan.billingLive && info.price) {
    return t('cloud.plan.upgradePro', {
      perNode: money(info.price.perNodeMonth, info.price.currency),
    });
  }
  return t('cloud.plan.tryPro');
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
          class="text-12 text-primary"
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
      class="text-13 font-semibold text-primary hover:text-primary-hover"
      data-testid="plan-try-pro"
    >
      {{ linkText }}
    </RouterLink>
  </section>
</template>
