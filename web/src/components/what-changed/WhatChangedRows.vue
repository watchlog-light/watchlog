<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { WhatChangedRow } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  barShare,
  hhmm,
  metricText,
  objectContext,
  objectName,
  rangeText,
  valueText,
} from '@/lib/what-changed';

// The ranked rows (ADR-199, the screens' Main and Anomaly): when it started, what (the subject
// and the metric in its platform's words), and usual → now. On the page each row carries a bar
// for how far out it went; the alert card's rows (`compact`) are plain. Names are cluster data,
// shown as text only.
const props = defineProps<{ rows: WhatChangedRow[]; compact?: boolean }>();
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>) => t(key, values ?? {});
const max = computed(() => Math.max(0, ...props.rows.map((r) => r.peakScore)));
const view = computed(() =>
  props.rows.map((r) => ({
    id: r.id,
    since: hhmm(r.since),
    name: objectName(r.object),
    metric: metricText(r, tr),
    context: objectContext(r.object, tr),
    usual: rangeText(r.usualLow, r.usualHigh, r.unit),
    now: valueText(r.value, r.unit),
    ended: r.until !== null,
    share: barShare(r.peakScore, max.value),
  })),
);
</script>

<template>
  <ol
    :class="['flex flex-col', compact ? 'gap-2' : 'gap-2.5']"
    :aria-label="$t('whatChanged.rows.label')"
    data-testid="wc-rows"
  >
    <li
      v-for="r in view"
      :key="r.id"
      :class="[
        'relative overflow-hidden',
        compact ? 'rounded-control bg-surface-2' : 'min-h-14 rounded-card bg-surface-1',
      ]"
      data-testid="wc-row"
    >
      <span
        v-if="!compact"
        class="wc-bar absolute inset-y-0 left-0"
        :style="{ width: `${(r.share * 100).toFixed(1)}%` }"
        aria-hidden="true"
      />
      <span
        :class="[
          'relative flex flex-wrap items-center gap-x-4.5 gap-y-1 font-mono',
          compact ? 'px-4 py-3 text-14 max-md:px-3.5' : 'px-5 py-4 text-14 md:text-16 max-md:px-4',
        ]"
      >
        <span class="min-w-11 text-13 text-text-subtle tabular" data-testid="wc-since">{{
          r.since
        }}</span>
        <span class="min-w-0 flex-[1_1_18rem] break-words text-text max-md:flex-[1_1_0%]">
          <span data-testid="wc-name">{{ r.name }}</span>
          <span class="text-text-subtle" aria-hidden="true"> · </span>
          <span class="sr-only">, </span>
          <span data-testid="wc-metric">{{ r.metric }}</span>
          <span
            v-if="r.context"
            class="ml-2 font-sans text-12 text-text-subtle max-md:block max-md:ml-0"
            data-testid="wc-context"
            >{{ r.context }}</span
          >
        </span>
        <span
          class="ml-auto inline-flex items-center gap-3 whitespace-nowrap max-md:ml-0 max-md:w-full max-md:pl-15.5"
        >
          <span class="text-13 text-text-muted tabular" data-testid="wc-usual">
            <span class="sr-only">{{ $t('whatChanged.rows.usual') }} </span>{{ r.usual }}
          </span>
          <span class="text-text-subtle" aria-hidden="true">→</span>
          <span
            :class="[
              'font-medium tabular md:min-w-16 md:text-right',
              r.ended ? 'text-text-muted' : 'text-warning',
            ]"
            data-testid="wc-now"
          >
            <span class="sr-only"
              >{{ $t(r.ended ? 'whatChanged.rows.furthest' : 'whatChanged.rows.now') }} </span
            >{{ r.now }}
          </span>
        </span>
      </span>
    </li>
  </ol>
</template>

<style scoped>
/* How far out it went: the warning tone, fading to the right (the screens' amber bar). */
.wc-bar {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--warning) 26%, transparent),
    color-mix(in srgb, var(--warning) 12%, transparent)
  );
}
</style>
