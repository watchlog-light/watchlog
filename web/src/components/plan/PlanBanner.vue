<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, CircleAlert } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePlanStore } from '@/stores/plan';

// The plan's banners (ADR-177), Cloud only, over every page:
//   - over the limit: how many new nodes were refused (402) and the way out;
//   - after a downgrade: the days left before the nodes beyond the plan stop sending.
// Plain words, the count, one link to Settings › Plan & billing.
const { t } = useI18n();
const plan = usePlanStore();
const BILLING = { name: 'settings', query: { tab: 'billing' } } as const;

const downgrade = computed(() => {
  const g = plan.info?.downgrade;
  return g && !g.ended ? g : null;
});
const refused = computed(() => plan.info?.refusedNodes ?? 0);

const text = computed(() => {
  const p = plan.info;
  if (!p) return null;
  const planName = t(`cloud.plan.short.${p.plan}`);
  if (downgrade.value) {
    const g = downgrade.value;
    const parts = [
      g.nodesOver > 0 ? t('cloud.plan.banner.nodesOver', { n: g.nodesOver }, g.nodesOver) : null,
      g.clustersOver > 0
        ? t('cloud.plan.banner.clustersOver', { n: g.clustersOver }, g.clustersOver)
        : null,
    ].filter(Boolean);
    return t(
      'cloud.plan.banner.downgrade',
      {
        plan: planName,
        days: t('cloud.plan.banner.days', { n: g.daysLeft }, g.daysLeft),
        date: new Date(g.graceUntil).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        }),
        over: parts.join(t('cloud.plan.banner.and')),
      },
      g.daysLeft,
    );
  }
  if (refused.value > 0) {
    return t(
      'cloud.plan.banner.overLimit',
      { n: refused.value, plan: planName, max: p.limits.nodes ?? 0, used: p.usage.nodes },
      refused.value,
    );
  }
  return null;
});
</script>

<template>
  <div
    v-if="text"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-1 px-4 py-2 text-13 text-text md:px-6"
    role="region"
    :aria-label="$t('cloud.plan.banner.label')"
    :data-testid="downgrade ? 'downgrade-banner' : 'over-limit-banner'"
  >
    <CalendarClock v-if="downgrade" class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <CircleAlert v-else class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1">{{ text }}</p>
    <RouterLink
      :to="BILLING"
      class="font-semibold whitespace-nowrap text-primary hover:text-primary-hover max-sm:basis-full max-sm:pl-7"
    >
      {{ $t('cloud.plan.tryPro') }}
    </RouterLink>
  </div>
</template>
