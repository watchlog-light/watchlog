<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Circle, TriangleAlert, X } from '@lucide/vue';
import type { AlertChartPanel } from '@watchlog/api-types';
import { computed } from 'vue';
import TonePill from '@/components/kube/TonePill.vue';
import { formatWhen } from '@/lib/format';

// State timelines of an alert's chart: node conditions, pod phases, a Docker health
// strip. One row per object, segments placed on the alert's window. Each segment has an
// icon and its state in words (title and a list for screen readers), and a legend names
// every state shown, so the state is never told by colour alone.
const props = defineProps<{
  rows: AlertChartPanel['rows'];
  window: { from: number; to: number };
  /** The health strip shows ✓/✕ instead of the state's tone icon. */
  strip?: boolean;
}>();

const ICON = { ok: Check, warning: TriangleAlert, critical: X, neutral: Circle } as const;
const FILL = {
  ok: 'bg-ok/25 text-ok',
  warning: 'bg-warning/25 text-warning',
  critical: 'bg-critical/25 text-critical',
  neutral: 'bg-surface-3 text-text-subtle',
} as const;

const span = computed(() => Math.max(1, props.window.to - props.window.from));
const placed = computed(() =>
  props.rows.map((r) => ({
    name: r.name,
    segments: r.segments
      .filter((s) => s.to > props.window.from && s.from < props.window.to)
      .map((s) => {
        const from = Math.max(s.from, props.window.from);
        const to = Math.min(s.to, props.window.to);
        return {
          ...s,
          left: ((from - props.window.from) / span.value) * 100,
          width: Math.max(0.4, ((to - from) / span.value) * 100),
          text: `${s.state} ${formatWhen(new Date(from * 1000).toISOString())}–${formatWhen(new Date(to * 1000).toISOString())}`,
        };
      }),
  })),
);
const legend = computed(() => {
  const seen = new Map<string, AlertChartPanel['rows'][number]['segments'][number]['tone']>();
  for (const r of props.rows) for (const s of r.segments) seen.set(s.state, s.tone);
  return [...seen].map(([state, tone]) => ({ state, tone }));
});
const edge = (ts: number) => formatWhen(new Date(ts * 1000).toISOString());
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="state-timeline">
    <div
      v-for="r in placed"
      :key="r.name"
      class="grid grid-cols-[minmax(0,8rem)_1fr] items-center gap-3"
      data-testid="state-row"
    >
      <span class="truncate text-12 text-text-muted" :title="r.name">{{ r.name }}</span>
      <div class="relative h-6 overflow-hidden rounded-control bg-surface-2">
        <span
          v-for="(s, i) in r.segments"
          :key="i"
          :class="[
            'absolute inset-y-0 flex items-center justify-center overflow-hidden',
            FILL[s.tone],
          ]"
          :style="{ left: `${s.left}%`, width: `${s.width}%` }"
          :title="s.text"
          data-testid="state-segment"
          :data-state="s.state"
        >
          <component
            :is="
              strip ? (s.tone === 'ok' ? Check : s.tone === 'critical' ? X : Circle) : ICON[s.tone]
            "
            v-if="s.width > 2"
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />
        </span>
        <ul class="sr-only">
          <li v-for="(s, i) in r.segments" :key="i">{{ s.text }}</li>
        </ul>
      </div>
    </div>
    <div class="grid grid-cols-[minmax(0,8rem)_1fr] gap-3 text-12 text-text-subtle tabular">
      <span />
      <span class="flex justify-between"
        ><span>{{ edge(window.from) }}</span
        ><span>{{ edge(window.to) }}</span></span
      >
    </div>
    <div class="flex flex-wrap gap-2" data-testid="state-legend">
      <TonePill v-for="l in legend" :key="l.state" :tone="l.tone" :label="l.state" />
    </div>
  </div>
</template>
