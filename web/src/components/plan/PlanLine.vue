<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { planLine } from '@/lib/plan-line';
import { useClustersStore } from '@/stores/clusters';
import { usePlanStore } from '@/stores/plan';

// The sidebar's plan line (0.10.1): see lib/plan-line.ts. Collapsed, only a paid plan's label
// shows (Free shows nothing there). Cloud only: the parent renders it only in Cloud.
defineProps<{ collapsed?: boolean }>();
const plan = usePlanStore();
const clusters = useClustersStore();
const line = computed(() =>
  planLine(
    plan.info,
    clusters.list.map((c) => c.kind),
  ),
);
const BILLING = { name: 'settings', query: { tab: 'billing' } } as const;
</script>

<template>
  <template v-if="line">
    <template v-if="collapsed">
      <span
        v-if="line.kind === 'unlimited'"
        data-testid="plan-line"
        class="inline-flex h-5 items-center rounded-full border border-info/50 px-1.5 text-12 font-semibold text-info-text"
        :title="
          $t('sidebar.plan.paid', {
            count: $t(`sidebar.plan.${line.unit}`, { n: line.count }, line.count),
            days: $t('cloud.plan.days', { n: line.days }, line.days),
          })
        "
        >{{ $t(`cloud.plan.short.${line.plan}`) }}</span
      >
    </template>
    <RouterLink
      v-else-if="line.kind === 'limited'"
      :to="BILLING"
      data-testid="plan-line"
      class="flex flex-col gap-1.5 rounded-control px-2.5 py-2 transition-colors hover:bg-surface-2"
    >
      <span class="flex items-baseline justify-between gap-2 text-13">
        <span class="min-w-0 truncate">
          <b class="font-semibold text-text">{{ $t(`cloud.plan.short.${line.plan}`) }}</b>
          <span class="text-text-muted" data-testid="plan-line-nodes">
            · {{ $t('cloud.plan.nodesOf', { n: line.used, max: line.max }) }}</span
          >
        </span>
        <span class="shrink-0 font-semibold whitespace-nowrap text-link">{{
          $t('sidebar.plan.upgrade')
        }}</span>
      </span>
      <span
        class="block h-1 rounded-full bg-surface-3"
        role="progressbar"
        :aria-valuenow="line.used"
        aria-valuemin="0"
        :aria-valuemax="line.max"
        :aria-label="$t('cloud.plan.nodesBar')"
      >
        <span
          data-testid="plan-line-bar"
          :class="['block h-1 rounded-full', line.warn ? 'bg-warning' : 'bg-primary']"
          :style="{ width: `${Math.round(line.share * 100)}%` }"
        />
      </span>
    </RouterLink>
    <p
      v-else
      data-testid="plan-line"
      class="flex items-center gap-2 px-2.5 py-1 text-13 text-text-muted"
    >
      <span
        class="inline-flex h-5 shrink-0 items-center rounded-full border border-info/50 px-2 text-12 font-semibold text-info-text"
        >{{ $t(`cloud.plan.short.${line.plan}`) }}</span
      >
      <span class="min-w-0 truncate">{{
        $t('sidebar.plan.paid', {
          count: $t(`sidebar.plan.${line.unit}`, { n: line.count }, line.count),
          days: $t('cloud.plan.days', { n: line.days }, line.days),
        })
      }}</span>
    </p>
  </template>
</template>
