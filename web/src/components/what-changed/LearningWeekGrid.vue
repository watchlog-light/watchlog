<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMotion } from '@/composables/useMotion';
import {
  offsetHours,
  rangesText,
  viewerOffset,
  weekCells,
  weekSummary,
  zoneLabel,
} from '@/lib/what-changed-learning';

// "The week it is learning" (ADR-216, the screen Learning): the 7 × 24 hours of the week,
// each learned (it has a baseline), this hour, or not seen yet, from the API's `week`, in the
// viewer's time zone. The squares are decoration for the eye; the same facts are a list a
// screen reader reads, one weekday a line. `waiting` (the upgrade page): every hour is "not
// seen yet" and none is "this hour", because nothing is learning. On phones the grid scrolls
// inside its box.
const props = defineProps<{
  week: string;
  /** The clock "this hour" comes from. */
  now: number;
  waiting?: boolean;
  /** The viewer's offset from UTC in minutes; the browser's by default. */
  offsetMin?: number;
}>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const motion = useMotion(root);

const offset = computed(() => props.offsetMin ?? viewerOffset(new Date(props.now)));
const cells = computed(() =>
  weekCells(props.waiting ? '' : props.week, props.waiting ? null : props.now, offset.value),
);
const days = computed(() => weekSummary(cells.value));
const learned = computed(() => cells.value.filter((c) => c.state === 'learned').length);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** The grid's hours are whole hours: say so where the viewer's zone is off by 30 or 45 minutes. */
const rounded = computed(() => offset.value !== offsetHours(offset.value) * 60);
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
</script>

<template>
  <section
    ref="root"
    class="flex flex-col gap-4 rounded-2xl border border-border bg-surface-1/45 p-6 max-md:p-4"
    aria-labelledby="wc-week-title"
    :data-motion="motion"
    :data-waiting="waiting ? 'on' : undefined"
    data-testid="wc-week"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-3">
      <h3 id="wc-week-title" class="text-16 font-semibold text-text md:text-20">
        {{ $t(waiting ? 'whatChanged.learn.week.titleWaiting' : 'whatChanged.learn.week.title') }}
      </h3>
      <span class="flex flex-wrap gap-x-4 gap-y-1 text-13 text-text-muted" aria-hidden="true">
        <template v-if="!waiting">
          <span class="flex items-center gap-1.5"
            ><span class="wk-key wk-learned" />{{ $t('whatChanged.learn.week.learned') }}</span
          >
          <span class="flex items-center gap-1.5"
            ><span class="wk-key wk-now" />{{ $t('whatChanged.learn.week.now') }}</span
          >
        </template>
        <span class="flex items-center gap-1.5"
          ><span class="wk-key wk-todo" />{{ $t('whatChanged.learn.week.todo') }}</span
        >
      </span>
    </div>

    <!-- The grid, for the eye. -->
    <div class="overflow-x-auto pb-1" data-testid="wc-week-scroll" aria-hidden="true">
      <div class="wk-box">
        <div class="wk-days font-mono text-12 text-text-muted">
          <span v-for="d in DAYS" :key="d">{{ $t(`whatChanged.learn.week.days.${d}`) }}</span>
        </div>
        <div class="wk-grid" data-testid="wc-week-grid">
          <span
            v-for="c in cells"
            :key="`${c.row}-${c.col}`"
            :class="['wk-cell', `wk-${c.state}`]"
            :data-state="c.state"
          />
        </div>
        <span />
        <div class="wk-hours font-mono text-12 text-text-muted">
          <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
        </div>
      </div>
    </div>

    <!-- The same, as text: a weekday a line. -->
    <div class="sr-only" data-testid="wc-week-text">
      <p>
        {{
          waiting
            ? $t('whatChanged.learn.week.textWaiting')
            : $t('whatChanged.learn.week.text', { n: learned })
        }}
      </p>
      <ul v-if="!waiting">
        <li v-for="d in days" :key="d.row">
          {{
            d.learned
              ? $t('whatChanged.learn.week.textDay', {
                  day: $t(`whatChanged.learn.week.daysLong.${DAYS[d.row]}`),
                  n: d.learned,
                  hours: rangesText(d.ranges),
                })
              : $t('whatChanged.learn.week.textDayNone', {
                  day: $t(`whatChanged.learn.week.daysLong.${DAYS[d.row]}`),
                })
          }}
          <template v-if="d.now !== null">{{
            ' ' + $t('whatChanged.learn.week.textNow', { hour: hh(d.now) })
          }}</template>
        </li>
      </ul>
    </div>

    <p class="text-14 leading-relaxed text-text-muted">
      {{ $t(waiting ? 'whatChanged.learn.week.whyWaiting' : 'whatChanged.learn.week.why') }}
      <span v-if="!waiting" class="text-text-subtle" data-testid="wc-week-zone">{{
        t(rounded ? 'whatChanged.learn.week.zoneRounded' : 'whatChanged.learn.week.zone', {
          zone: zoneLabel(offset),
        })
      }}</span>
    </p>
  </section>
</template>

<style scoped>
.wk-box {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 8px;
  min-width: 640px;
}
.wk-days {
  display: grid;
  grid-template-rows: repeat(7, minmax(0, 1fr));
  align-items: center;
}
.wk-grid {
  display: grid;
  grid-template-columns: repeat(24, minmax(0, 1fr));
  gap: 6px;
}
.wk-cell {
  aspect-ratio: 34 / 22;
  border-radius: 4px;
}
.wk-hours {
  display: flex;
  justify-content: space-between;
}
.wk-key {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}
.wk-learned {
  background: var(--primary);
}
.wk-now {
  background: var(--warning);
}
.wk-todo {
  background: var(--surface-3);
}
/* "This hour" pulses: opacity only, on its own layer. */
.wk-cell.wk-now {
  will-change: opacity;
  animation: wk-blink 2.4s ease-in-out infinite;
}
[data-motion='paused'] .wk-cell.wk-now {
  animation-play-state: paused;
}
[data-motion='off'] .wk-cell.wk-now {
  animation: none;
}
@keyframes wk-blink {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wk-cell.wk-now {
    animation: none !important;
  }
}
</style>
