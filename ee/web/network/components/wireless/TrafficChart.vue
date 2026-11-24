<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { hhmm } from '@/lib/what-changed';
import { niceStep } from '@/lib/units';
import type { Wireless } from '../../api';
import { bpsText } from '../../lib/format';
import { bandAt, lastValue } from '../../lib/wireless';

// The access points' traffic over 24 h (ADR-234), in bits a second, over its usual band for each
// hour (What changed's statistics), drawn like What changed's charts: an SVG with the tokens'
// colours. Without a band yet (learning), the line alone and a note.
const props = defineProps<{ traffic: Wireless['traffic'] }>();
const { t } = useI18n();

const W = 1000;
const H = 160;
const TOP = 8;
const HOUR = 3_600_000;

const pts = computed(() => props.traffic.points.map(([ts, v]) => [ts, v == null ? null : v * 8]));
const band = computed(() =>
  props.traffic.band.map((b) => ({
    t: Date.parse(b.t),
    low: b.low * 8,
    high: b.high * 8,
  })),
);
const span = computed<[number, number]>(() => {
  const end = pts.value.length ? pts.value[pts.value.length - 1]![0]! : Date.now();
  return [end - 24 * HOUR, end];
});
const ticks = computed(() => {
  const max = Math.max(
    0,
    ...pts.value.map((p) => p[1] ?? 0),
    ...band.value.filter((b) => b.t + HOUR > span.value[0]).map((b) => b.high),
  );
  const step = niceStep(max * 1.05 || 1, 3);
  const out = [0];
  while (out[out.length - 1]! < max * 1.05) out.push(out[out.length - 1]! + step);
  return out;
});
const top = computed(() => ticks.value[ticks.value.length - 1]! || 1);
const x = (ms: number) => ((ms - span.value[0]) / (span.value[1] - span.value[0])) * W;
const y = (v: number) => TOP + (H - TOP) * (1 - v / top.value);

const line = computed(() => {
  let d = '';
  let pen = false;
  for (const [ts, v] of pts.value) {
    if (v == null || ts! < span.value[0]) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${x(ts!).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
});
const rects = computed(() =>
  band.value
    .map((b) => {
      const from = Math.max(b.t, span.value[0]);
      const to = Math.min(b.t + HOUR, span.value[1]);
      return to > from
        ? { x: x(from), w: x(to) - x(from), y: y(b.high), h: Math.max(1, y(b.low) - y(b.high)) }
        : null;
    })
    .filter((r) => r !== null),
);
const times = computed(() =>
  [0, 1, 2, 3, 4].map((i) => ({
    pct: i * 25,
    at: hhmm(new Date(span.value[0] + ((span.value[1] - span.value[0]) * i) / 4).toISOString()),
  })),
);

const now = computed(() => lastValue(props.traffic.points));
const usualNow = computed(() => (now.value ? bandAt(props.traffic.band, now.value.t) : null));
const headline = computed(() => {
  if (!now.value) return null;
  const v = bpsText(now.value.v * 8);
  const u = usualNow.value;
  if (!u) return { text: t('netWifi.traffic.now', { now: v }), above: false };
  return {
    text: t('netWifi.traffic.nowUsual', {
      now: v,
      low: bpsText(u.low * 8),
      high: bpsText(u.high * 8),
    }),
    above: now.value.v > u.high,
  };
});
const hasData = computed(() => pts.value.some((p) => p[1] != null));
const aria = computed(() =>
  t('netWifi.traffic.aria', { now: now.value ? bpsText(now.value.v * 8) : '–' }),
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 px-4 py-4"
    aria-labelledby="wifi-traffic-h"
    data-testid="wifi-traffic"
    :data-band="band.length ? 'yes' : 'no'"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="wifi-traffic-h" class="text-14 font-semibold text-text">
        {{ $t('netWifi.traffic.title') }}
        <span class="text-13 font-normal text-text-muted max-md:hidden"
          >· {{ $t('netWifi.traffic.hint') }}</span
        >
      </h2>
      <span
        v-if="headline"
        class="text-13"
        :class="headline.above ? 'text-warning-text' : 'text-text-muted'"
        >{{ headline.text }}</span
      >
    </div>
    <p v-if="!hasData" class="py-6 text-13 text-text-muted">{{ $t('netWifi.traffic.empty') }}</p>
    <template v-else>
      <div class="flex gap-2">
        <div class="relative w-16 shrink-0" :style="{ height: `${H}px` }" aria-hidden="true">
          <span
            v-for="v in ticks"
            :key="v"
            class="absolute right-0 -translate-y-1/2 font-mono text-12 whitespace-nowrap text-text-subtle"
            :style="{ top: `${y(v)}px` }"
            >{{ bpsText(v) }}</span
          >
        </div>
        <div class="relative min-w-0 flex-1" :style="{ height: `${H + 22}px` }">
          <svg
            :viewBox="`0 0 ${W} ${H}`"
            preserveAspectRatio="none"
            class="absolute inset-x-0 top-0 w-full"
            :style="{ height: `${H}px` }"
            role="img"
            :aria-label="aria"
          >
            <line
              v-for="v in ticks"
              :key="v"
              x1="0"
              :x2="W"
              :y1="y(v)"
              :y2="y(v)"
              class="stroke-border"
              stroke-width="1"
              vector-effect="non-scaling-stroke"
            />
            <rect
              v-for="(r, i) in rects"
              :key="i"
              :x="r.x"
              :y="r.y"
              :width="r.w"
              :height="r.h"
              class="fill-text-muted/15"
              data-testid="wifi-traffic-band"
            />
            <path
              :d="line"
              fill="none"
              class="stroke-info"
              stroke-width="2"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <div class="absolute inset-x-0 bottom-0 h-4.5" aria-hidden="true">
            <span
              v-for="(tk, i) in times"
              :key="i"
              class="absolute bottom-0 font-mono text-12 text-text-subtle"
              :class="i % 2 ? 'max-md:hidden' : ''"
              :style="{
                left: `${tk.pct}%`,
                transform: `translateX(${i === 0 ? '0' : i === times.length - 1 ? '-100%' : '-50%'})`,
              }"
              >{{ tk.at }}</span
            >
          </div>
        </div>
      </div>
      <p class="flex flex-wrap gap-x-4 gap-y-1 text-12 text-text-muted">
        <span class="inline-flex items-center gap-1.5"
          ><span class="inline-block h-0.5 w-3 bg-info" aria-hidden="true" />{{
            $t('netWifi.traffic.legendLine')
          }}</span
        >
        <span v-if="band.length" class="inline-flex items-center gap-1.5"
          ><span
            class="inline-block h-2.5 w-3 rounded-[2px] bg-text-muted/25"
            aria-hidden="true"
          />{{ $t('netWifi.traffic.legendBand') }}</span
        >
        <span v-else data-testid="wifi-traffic-learning">{{ $t('netWifi.traffic.learning') }}</span>
      </p>
    </template>
  </section>
</template>
