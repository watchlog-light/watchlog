<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { WhatChangedLive } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { liveMap, type MapCell } from '@/lib/what-changed-live';
import { metricText, rangeText, valueText } from '@/lib/what-changed';

// The live map (0.14.0, ADR-231): every scored series as one small square, grouped by workload
// or by server, coloured by its distance from its usual range for this hour (inside in three
// soft greens, near the edge, outside in amber). A soft scan line sweeps across it as a sign
// of life, never a progress claim; it stops under prefers-reduced-motion. A square or a group's
// name filters the page to it (`?focus=`).
const props = defineProps<{
  live: WhatChangedLive | null;
  kind: 'kubernetes' | 'server';
  hideOwn: boolean;
  focus: string | null;
}>();
const { t } = useI18n();
const route = useRoute();
const tr = (k: string, v?: Record<string, unknown>, n?: number) =>
  n === undefined ? t(k, v ?? {}) : t(k, v ?? {}, n);
const map = computed(() => liveMap(props.live?.series ?? [], props.kind, props.hideOwn));

const CELL: Record<string, string> = {
  'inside-0': 'bg-ok/15',
  'inside-1': 'bg-ok/25',
  'inside-2': 'bg-ok/35',
  'near-1': 'bg-warning/40',
  'outside-2': 'bg-warning',
};
const cellClass = (c: MapCell) =>
  CELL[`${c.state}-${c.shade}`] ??
  (c.state === 'near' ? 'bg-warning/40' : c.state === 'outside' ? 'bg-warning' : 'bg-ok/25');
const title = (c: MapCell, group: string) => {
  const s = c.series;
  const unit = s.unit;
  return (
    t('whatChanged.map.square', {
      name: group,
      metric: metricText({ key: s.key, peer: s.peer }, tr),
      value: s.value === null ? '–' : valueText(s.value, unit),
      range: rangeText(s.usualLow, s.usualHigh, unit),
    }) + ` · ${t(`whatChanged.map.state.${s.state}`)}`
  );
};
const focusLink = (key: string) => ({ query: { ...route.query, focus: key } });
const moreLabel = computed(() =>
  props.kind === 'server'
    ? t(
        'whatChanged.map.moreServers',
        { n: map.value.folded?.groups ?? 0 },
        map.value.folded?.groups ?? 0,
      )
    : t(
        'whatChanged.map.moreWorkloads',
        { n: map.value.folded?.groups ?? 0 },
        map.value.folded?.groups ?? 0,
      ),
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 px-6 py-5 max-md:px-4"
    aria-labelledby="wc-map-title"
    data-testid="wc-map"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
      <h3 id="wc-map-title" class="text-15 font-semibold text-text">
        {{ $t('whatChanged.map.title', { n: map.total.toLocaleString('en') }, map.total) }}
        <span class="font-normal text-text-muted max-md:hidden"
          >· {{ $t('whatChanged.map.hint') }}</span
        >
      </h3>
      <span class="flex flex-wrap gap-x-3 font-mono text-13" data-testid="wc-map-counts">
        <span class="text-text-muted">{{
          $t('whatChanged.map.inside', { n: map.counts.inside })
        }}</span>
        <span class="text-text-muted">{{
          $t('whatChanged.map.near', { n: map.counts.near })
        }}</span>
        <span :class="map.counts.outside ? 'font-semibold text-warning-text' : 'text-text-muted'">{{
          $t('whatChanged.map.outside', { n: map.counts.outside })
        }}</span>
      </span>
    </div>

    <p v-if="!map.total" class="text-14 text-text-muted" data-testid="wc-map-none">
      {{ $t('whatChanged.map.none') }}
    </p>
    <div v-else class="relative overflow-hidden rounded-card" data-testid="wc-map-groups">
      <span
        class="wc-scan pointer-events-none absolute inset-y-0 w-24 motion-reduce:hidden"
        aria-hidden="true"
      />
      <div
        class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-2.5 max-md:grid-cols-1"
      >
        <div
          v-for="g in map.groups"
          :key="g.key"
          :class="['flex min-w-0 flex-col gap-1', focus && focus !== g.key ? 'opacity-40' : '']"
          data-testid="wc-map-group"
          :data-outside="g.outside"
        >
          <RouterLink
            :to="focusLink(g.key)"
            :class="[
              'truncate font-mono text-12 hover:underline max-lg:py-1',
              g.outside ? 'text-warning-text' : 'text-text-muted',
            ]"
            :title="g.name"
            >{{ g.name }}</RouterLink
          >
          <span
            class="flex flex-wrap gap-0.75"
            role="img"
            :aria-label="
              $t('whatChanged.map.groupAria', {
                name: g.name,
                n: g.cells.length,
                outside: g.outside,
                near: g.near,
              })
            "
            data-layout-exempt="touch-target"
          >
            <RouterLink
              v-for="c in g.cells"
              :key="c.id"
              :to="focusLink(g.key)"
              :class="['size-2.75 rounded-[2px]', cellClass(c)]"
              :title="title(c, g.name)"
              :data-state="c.state"
              tabindex="-1"
              data-testid="wc-square"
            />
          </span>
        </div>
        <div v-if="map.folded" class="flex min-w-0 flex-col gap-1" data-testid="wc-map-folded">
          <span class="font-mono text-12 text-text-subtle">{{ moreLabel }}</span>
          <span class="flex flex-wrap gap-0.75" aria-hidden="true">
            <span
              v-for="c in map.folded.cells"
              :key="c.id"
              :class="['size-2.75 rounded-[2px]', cellClass(c)]"
              :title="title(c, '')"
            />
          </span>
        </div>
      </div>
    </div>

    <p class="text-13 text-text-subtle" data-testid="wc-map-foot">
      {{ $t('whatChanged.map.foot') }}
      <template v-if="live && live.learning > 0">
        {{
          $t('whatChanged.map.learning', { n: live.learning.toLocaleString('en') }, live.learning)
        }}
      </template>
    </p>
  </section>
</template>

<style scoped>
.wc-scan {
  left: -6rem;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in oklab, var(--ok) 12%, transparent),
    transparent
  );
  animation: wc-scan 6s linear infinite;
}
@keyframes wc-scan {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(calc(100vw));
  }
}
@media (prefers-reduced-motion: reduce) {
  .wc-scan {
    animation: none;
    display: none;
  }
}
</style>
