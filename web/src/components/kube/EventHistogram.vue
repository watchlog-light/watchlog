<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeEventSummary } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { clockTime } from '@/lib/time';

// Events per bucket, Warning stacked on Normal, with a dashed marker per notable event
// (reboots, NotReady, OOM, evictions). Dragging across the chart zooms into that range.
const props = defineProps<{
  summary: KubeEventSummary;
  showNormal: boolean;
  showWarning: boolean;
}>();
const emit = defineEmits<{ zoom: [from: number, to: number] }>();
const { t } = useI18n();
const W = 900;
const H = 90;
const bars = computed(() => props.summary.histogram);
const max = computed(() =>
  Math.max(
    1,
    ...bars.value.map(
      (b) => (props.showWarning ? b.warning : 0) + (props.showNormal ? b.normal : 0),
    ),
  ),
);
const span = computed(() => {
  const first = bars.value[0]?.ts ?? props.summary.from;
  return [first, first + bars.value.length * props.summary.bucket] as const;
});
const x = (ts: number) => ((ts - span.value[0]) / (span.value[1] - span.value[0])) * W;
const bw = computed(() => Math.max(1, W / Math.max(1, bars.value.length) - 3));
const h = (v: number) => (v / max.value) * (H - 14);
// Times of day; dates too once the range spans more than a day and a half.
const dayFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const ticks = computed(() =>
  Array.from({ length: 5 }, (_, i) => {
    const ts = span.value[0] + ((span.value[1] - span.value[0]) * i) / 4;
    const iso = new Date(ts * 1000).toISOString();
    const long = span.value[1] - span.value[0] > 1.5 * 86400;
    return {
      label: `${long ? `${dayFormat.format(new Date(iso))} ` : ''}${clockTime(iso).slice(0, 5)}`,
    };
  }),
);
const markerLabel = (m: KubeEventSummary['markers'][number]) =>
  t(`kube.events.markers.${m.reason}`, { n: m.objects }, m.objects);
const barTitle = (b: KubeEventSummary['histogram'][number]) =>
  t('kube.events.bar', {
    from: clockTime(new Date(b.ts * 1000).toISOString()).slice(0, 5),
    to: clockTime(new Date((b.ts + props.summary.bucket) * 1000).toISOString()).slice(0, 5),
    w: b.warning,
    n: b.normal,
  });

// Drag to zoom: the selection is kept in chart coordinates while the pointer is down.
const svg = ref<SVGSVGElement | null>(null);
const drag = ref<{ a: number; b: number } | null>(null);
const at = (e: PointerEvent) => {
  const r = svg.value!.getBoundingClientRect();
  return Math.min(W, Math.max(0, ((e.clientX - r.left) / Math.max(1, r.width)) * W));
};
function down(e: PointerEvent) {
  if (e.button !== 0) return;
  const p = at(e);
  drag.value = { a: p, b: p };
  svg.value?.setPointerCapture?.(e.pointerId);
}
function move(e: PointerEvent) {
  if (drag.value) drag.value = { ...drag.value, b: at(e) };
}
function up() {
  const d = drag.value;
  drag.value = null;
  if (!d) return;
  const [a, b] = [Math.min(d.a, d.b), Math.max(d.a, d.b)];
  // At least one bucket wide, so a click does not zoom.
  if (b - a < W / Math.max(1, bars.value.length)) return;
  const time = (px: number) =>
    Math.round(span.value[0] + (px / W) * (span.value[1] - span.value[0]));
  emit('zoom', time(a), time(b));
}
const aria = computed(() =>
  t('kube.events.chartAria', {
    total: props.summary.total,
    markers: props.summary.markers.length,
  }),
);
</script>

<template>
  <div class="relative">
    <svg
      ref="svg"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      class="block h-[90px] w-full cursor-crosshair touch-none select-none"
      role="img"
      :aria-label="aria"
      data-testid="event-histogram"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="drag = null"
    >
      <g v-for="b in bars" :key="b.ts">
        <title>{{ barTitle(b) }}</title>
        <rect :x="x(b.ts) + 1.5" :y="0" :width="bw" :height="H" fill="transparent" />
        <rect
          v-if="showNormal && b.normal"
          :x="x(b.ts) + 1.5"
          :y="H - h(b.normal)"
          :width="bw"
          :height="h(b.normal)"
          class="normal"
        />
        <rect
          v-if="showWarning && b.warning"
          :x="x(b.ts) + 1.5"
          :y="H - h(b.normal * (showNormal ? 1 : 0)) - h(b.warning)"
          :width="bw"
          :height="h(b.warning)"
          class="warning"
          data-testid="bar-warning"
        />
      </g>
      <line
        v-for="m in summary.markers"
        :key="`${m.reason}-${m.ts}`"
        :x1="x(m.ts)"
        :x2="x(m.ts)"
        y1="0"
        :y2="H"
        class="marker"
        vector-effect="non-scaling-stroke"
      />
      <rect
        v-if="drag"
        :x="Math.min(drag.a, drag.b)"
        y="0"
        :width="Math.abs(drag.b - drag.a)"
        :height="H"
        class="sel"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <!-- Labels in HTML, so they keep their size at any width. -->
    <span
      v-for="m in summary.markers"
      :key="`l-${m.reason}-${m.ts}`"
      class="marker-label"
      :style="{ left: `${(x(m.ts) / W) * 100}%` }"
      data-testid="event-marker"
      >{{ markerLabel(m) }}</span
    >
    <div class="ticks" aria-hidden="true">
      <span v-for="(tk, i) in ticks" :key="i">{{ tk.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.normal {
  fill: var(--border-strong);
}
.warning {
  fill: var(--warning);
  fill-opacity: 0.85;
}
.marker {
  stroke: var(--warning);
  stroke-dasharray: 3 3;
}
.marker-label {
  position: absolute;
  top: 0;
  max-width: 40%;
  overflow: hidden;
  padding-left: 5px;
  color: var(--warning);
  font-size: var(--text-12);
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.ticks {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  color: var(--text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--text-11);
  white-space: nowrap;
}
@container (max-width: 520px) {
  .ticks span:nth-child(2n) {
    display: none;
  }
}
.sel {
  fill: var(--primary);
  fill-opacity: 0.15;
  stroke: var(--primary);
  stroke-opacity: 0.5;
}
</style>
