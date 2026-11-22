<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { TlsCertificate } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  maxLabelPx,
  placeCerts,
  ticksThatFit,
  timelineText,
  type DotTone,
  type ExpiryRange,
  type TimelineCert,
  type TimelineMark,
} from '@/lib/expiry-timeline';

// "When they expire" (0.13.0, ADR-230): one component for the Certificates page (`full`:
// labels on three lanes, the renewal window, ticks, "+N later", clusters past 15) and the
// Overview's strip (`strip`: the dots, the 14-day warning band, today to 90 days, no labels).
const props = withDefaults(
  defineProps<{ certs: TlsCertificate[]; range?: ExpiryRange; variant?: 'full' | 'strip' }>(),
  { range: 90, variant: 'full' },
);
const { t } = useI18n();
const say = (key: string, values: Record<string, unknown>, n?: number) => t(key, values, n ?? 1);

// The axis's width, for the lanes (labels are measured against it).
const box = ref<HTMLElement | null>(null);
const width = ref(900);
let observer: ResizeObserver | null = null;
onMounted(() => {
  if (!box.value || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(([e]) => (width.value = e!.contentRect.width || 900));
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

/** A certificate as the timeline names it: its first name, and on a server its server and port. */
const items = computed<TimelineCert[]>(() =>
  props.certs.map((c) => {
    // On a Server fleet a label says where: "api.acme.com · app-1 :443" (not on a phone, where
    // it would only be cut off; the table below says it).
    const e = c.endpoints[0];
    const where = c.node && width.value >= 480 ? `${c.node}${e ? ` :${e.port}` : ''}` : '';
    return {
      id: c.id,
      name: c.names[0] ?? c.subject,
      where,
      daysLeft: c.daysLeft,
      problem: c.status === 'problem',
    };
  }),
);
const byId = computed(() => new Map(props.certs.map((c) => [c.id, c])));

const range = computed<ExpiryRange>(() => (props.variant === 'strip' ? 90 : props.range));
const placed = computed(() =>
  placeCerts(items.value, range.value, {
    widthPx: width.value,
    labels: props.variant === 'full',
  }),
);
const ticks = computed(() => ticksThatFit(placed.value.ticks, width.value));
const a11y = computed(() => timelineText(items.value, range.value, say));

const DOT: Record<DotTone, string> = { crit: 'bg-critical', warn: 'bg-warning', info: 'bg-info' };
const DAYS: Record<DotTone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  info: 'text-text-muted',
};
const daysText = (d: number) =>
  d < 0 ? t('certTimeline.expiredAgo', { n: -d }, -d) : t('certTimeline.daysLeft', { n: d }, d);
const LANE_TOP = [6, 36, 66];
const link = (id: string) => {
  const c = byId.value.get(id);
  return { name: 'certificate', params: { certId: id }, query: c?.node ? { node: c.node } : {} };
};
const tickLabel = (days: number) =>
  days === 0 ? t('certTimeline.today') : t('certTimeline.ticks', { n: days });

// A cluster's list, opened from its dot.
const open = ref<string | null>(null);
const toggle = (m: TimelineMark) => (open.value = open.value === m.id ? null : m.id);
</script>

<template>
  <div
    v-if="variant === 'strip'"
    ref="box"
    class="flex flex-col gap-1.5"
    data-testid="expiry-strip"
  >
    <div class="relative h-6.5" role="img" :aria-label="a11y">
      <span class="absolute inset-x-0 top-3 h-0.5 rounded-full bg-surface-3" aria-hidden="true" />
      <span
        class="absolute top-2.75 left-0 h-1 rounded-full bg-warning/45"
        :style="{ width: `${(14 / 90) * 100}%` }"
        aria-hidden="true"
      />
      <span
        v-for="m in placed.marks"
        :key="m.id"
        :class="['absolute top-1.5 size-3.5 rounded-full border-2 border-surface-1', DOT[m.tone]]"
        :style="{ left: `calc(${m.pct}% - 7px)` }"
        aria-hidden="true"
        data-testid="expiry-dot"
      />
    </div>
    <div class="flex justify-between font-mono text-12 text-text-subtle" aria-hidden="true">
      <span v-for="tk in placed.ticks" :key="tk.days">{{ tickLabel(tk.days) }}</span>
    </div>
  </div>

  <div v-else ref="box" class="flex flex-col gap-3" data-testid="expiry-timeline">
    <p class="sr-only" data-testid="expiry-timeline-text">{{ a11y }}</p>
    <!-- Labels and dots are a drawing: on a phone the table below has a full-size row per
         certificate. -->
    <div class="relative h-37.5" data-layout-exempt="touch-target">
      <!-- The usual renewal window (ACME clients renew in the last 30 days). -->
      <span
        class="absolute top-0 bottom-6.5 left-0 border-r border-dashed border-info/40 bg-info/5"
        :style="{ width: `${placed.windowEnd}%` }"
        aria-hidden="true"
      />
      <span
        class="absolute top-23.5 -translate-x-full pr-1.5 text-12 whitespace-nowrap text-text-subtle max-sm:hidden"
        :style="{ left: `${placed.windowEnd}%` }"
        aria-hidden="true"
        >{{ $t('certTimeline.window') }}</span
      >
      <span class="absolute inset-x-0 top-29.5 h-0.5 bg-surface-3" aria-hidden="true" />
      <span class="absolute top-2 bottom-6.5 left-0 w-0.5 bg-text-muted" aria-hidden="true" />
      <div
        v-for="m in placed.marks"
        :key="m.id"
        class="absolute top-0 h-32.5 w-0"
        :style="{ left: `${m.pct}%` }"
        data-testid="expiry-mark"
        :data-tone="m.tone"
      >
        <template v-if="m.lane !== null">
          <RouterLink
            :to="link(m.id)"
            :class="[
              'absolute truncate rounded-[6px] border border-border bg-surface-2 px-1.75 py-0.75 font-mono text-12 whitespace-nowrap text-text hover:border-border-strong hover:underline',
              m.flip ? '-right-1.5' : '-left-1.5',
            ]"
            :style="{ top: `${LANE_TOP[m.lane]}px`, maxWidth: `${maxLabelPx(width)}px` }"
            data-testid="expiry-label"
          >
            {{ m.items[0]!.name
            }}<span v-if="m.items[0]!.where" class="text-text-muted">
              · {{ m.items[0]!.where }}</span
            ><span v-if="m.items.length > 1" class="text-text-muted">
              +{{ m.items.length - 1 }}</span
            >
            <b :class="['ml-1 font-semibold', DAYS[m.tone]]">{{
              daysText(m.items[0]!.daysLeft)
            }}</b>
          </RouterLink>
          <span
            :class="['absolute -left-px w-0.5 opacity-50', DOT[m.tone]]"
            :style="{
              top: `${LANE_TOP[m.lane]! + 24}px`,
              height: `${112 - LANE_TOP[m.lane]! - 24}px`,
            }"
            aria-hidden="true"
          />
        </template>
        <button
          v-if="m.items.length > 1"
          type="button"
          :class="[
            'absolute top-26 -left-2.75 flex size-5.5 items-center justify-center rounded-full border-2 border-surface-1 font-mono text-12 font-semibold text-on-primary',
            DOT[m.tone],
          ]"
          :aria-label="$t('certTimeline.cluster', { n: m.items.length }, m.items.length)"
          :aria-expanded="open === m.id"
          data-testid="expiry-cluster"
          @click="toggle(m)"
        >
          {{ m.items.length }}
        </button>
        <RouterLink
          v-else-if="m.lane === null"
          :to="link(m.id)"
          :class="[
            'absolute top-28 -left-1.75 size-3.5 rounded-full border-2 border-surface-1',
            DOT[m.tone],
          ]"
          :aria-label="`${m.items[0]!.name}, ${daysText(m.items[0]!.daysLeft)}`"
          data-testid="expiry-dot"
        />
        <span
          v-else
          :class="[
            'absolute top-28 -left-1.75 size-3.5 rounded-full border-2 border-surface-1',
            DOT[m.tone],
          ]"
          aria-hidden="true"
          data-testid="expiry-dot"
        />
        <ul
          v-if="open === m.id"
          :class="[
            'absolute top-33 z-10 flex w-64 flex-col gap-0.5 rounded-card border border-border-strong bg-surface-2 p-1.5 shadow-menu',
            m.flip ? 'right-0' : 'left-0',
          ]"
          data-testid="expiry-cluster-list"
        >
          <li v-for="c in m.items" :key="c.id">
            <RouterLink
              :to="link(c.id)"
              class="flex items-baseline justify-between gap-2 rounded-control px-2 py-1.5 font-mono text-12 text-text hover:bg-surface-3 max-lg:min-h-11"
            >
              <span class="truncate">{{ c.name }}</span>
              <span class="shrink-0 text-text-muted">{{ daysText(c.daysLeft) }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <div class="absolute inset-x-0 bottom-0 h-4.5" aria-hidden="true">
        <span
          v-for="(tk, i) in ticks"
          :key="tk.days"
          class="absolute bottom-0 font-mono text-12 whitespace-nowrap text-text-subtle"
          :style="{
            left: `${tk.pct}%`,
            transform: `translateX(${i === 0 ? '0' : i === ticks.length - 1 ? '-100%' : '-50%'})`,
          }"
          >{{ tickLabel(tk.days) }}</span
        >
      </div>
    </div>
    <span
      v-if="placed.later > 0"
      class="self-end rounded-full border border-border bg-surface-2 px-2.5 py-0.75 text-12 text-text-muted"
      data-testid="expiry-later"
      >{{
        range === 365
          ? $t('certTimeline.laterYear', { n: placed.later })
          : $t('certTimeline.later', { n: placed.later, days: range })
      }}</span
    >
    <p class="text-13 text-text-muted">{{ $t('certTimeline.legend') }}</p>
  </div>
</template>
