<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMotion } from '@/composables/useMotion';
import { ringSegments, waitingSegments } from '@/lib/what-changed-learning';

// The learning week's centrepiece (ADR-216, the screen Learning): a brain drawn in strokes
// whose folds light up in turn, a pulsing halo, orbiting dots, and a ring of 7 day segments
// with the weekdays from the day learning started. SVG and CSS only.
//   - `learning`: the ring is the week as the worker has learned it (ADR-217): a day is done
//     when all its 24 hours are learned, today pulses, and a day that wasn't learned (the org
//     was off Pro, no data came) shows only the share it has, or stays empty.
//   - `waiting` (the upgrade page, ADR-201): nothing is learning. The brain is dim and calm,
//     every segment is empty, and it never looks as if it were learning. `preview` (the
//     Upgrade button hovered or focused) fills the first segment and brightens the brain, as
//     a preview of day 1; not with reduced motion.
// Each moving part is its own layer and animates only transform or opacity, so the browser's
// compositor moves it and the page's main thread does nothing (measured in e2e/learning.spec.ts:
// animating the folds' strokes instead kept it 6 % busy). The folds are drawn once when the
// page opens, then light up in turn by opacity. Everything stops with reduced motion (the
// same information stays) and pauses while the tab is hidden or the ring is out of view.
const props = withDefaults(
  defineProps<{
    state: 'learning' | 'waiting';
    /** The day of learning, 1 to 7, as the API counts it (the label; ignored while waiting). */
    day?: number;
    /** The first day's time: when learning started, or now on the upgrade page. */
    start: number;
    /** While learning: the API's week (which hours are learned) and the clock. */
    week?: string;
    now?: number;
    preview?: boolean;
  }>(),
  { day: 1, week: '', now: undefined, preview: false },
);
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const motion = useMotion(root);

const waiting = computed(() => props.state === 'waiting');
/** The preview of day 1, only where motion is allowed. */
const previewing = computed(() => waiting.value && props.preview && motion.value !== 'off');
const segments = computed(() =>
  waiting.value
    ? waitingSegments(props.start, previewing.value)
    : ringSegments(props.week, props.start, props.now ?? Date.now()),
);
/** A day partly learned and not today: its learned share is drawn over the empty track. */
const partial = computed(() =>
  segments.value.filter((s) => s.state === 'todo' && s.share > 0 && !waiting.value),
);
const label = computed(() =>
  waiting.value
    ? t('whatChanged.learn.ring.waiting')
    : t('whatChanged.learn.ring.learning', { day: props.day }),
);

// The brain's two halves and its folds, in a 120 × 120 box (the design's strokes).
const HALVES = [
  'M60 24 C52 15 38 17 34 28 C24 28 17 38 22 48 C13 54 13 68 22 74 C19 86 30 97 42 94 C46 103 56 103 60 96',
  'M60 24 C68 15 82 17 86 28 C96 28 103 38 98 48 C107 54 107 68 98 74 C101 86 90 97 78 94 C74 103 64 103 60 96',
];
const TURNS = ['a', 'b', 'c'] as const;
const FOLDS: { d: string; turn: (typeof TURNS)[number] }[] = [
  { d: 'M34 28 C37 35 44 36 47 31', turn: 'a' },
  { d: 'M22 48 C30 45 37 50 37 58', turn: 'b' },
  { d: 'M22 74 C30 73 34 66 43 68', turn: 'c' },
  { d: 'M42 94 C40 86 44 80 51 80', turn: 'b' },
  { d: 'M60 46 C54 46 50 50 50 56', turn: 'c' },
  { d: 'M86 28 C83 35 76 36 73 31', turn: 'b' },
  { d: 'M98 48 C90 45 83 50 83 58', turn: 'a' },
  { d: 'M98 74 C90 73 86 66 77 68', turn: 'b' },
  { d: 'M78 94 C80 86 76 80 69 80', turn: 'a' },
  { d: 'M60 62 C66 62 70 66 70 72', turn: 'a' },
];
</script>

<template>
  <div
    ref="root"
    class="lb"
    role="img"
    :aria-label="label"
    :data-state="state"
    :data-motion="motion"
    :data-preview="previewing ? 'on' : undefined"
    data-testid="learning-brain"
  >
    <!-- The ring, its weekdays and the two dotted circles: still. -->
    <svg class="lb-layer" viewBox="0 0 340 340" aria-hidden="true">
      <path
        v-for="(s, i) in segments"
        :key="i"
        :d="s.d"
        :class="['lb-seg', `lb-seg-${s.state}`]"
        :data-testid="`ring-${s.state}`"
        :data-share="s.share.toFixed(2)"
        fill="none"
        stroke-width="9"
        stroke-linecap="round"
      />
      <path
        v-for="s in partial"
        :key="`p${s.d}`"
        :d="s.d"
        class="lb-seg lb-seg-part"
        data-testid="ring-part"
        fill="none"
        stroke-width="9"
        stroke-linecap="round"
        pathLength="1"
        :stroke-dasharray="`${s.share.toFixed(3)} 1`"
      />
      <text
        v-for="(s, i) in segments"
        :key="`l${i}`"
        :x="s.x"
        :y="s.y"
        :class="['lb-day font-mono text-11 uppercase', `lb-day-${s.state}`]"
        text-anchor="middle"
      >
        {{ s.label }}
      </text>
      <circle class="lb-dots" cx="170" cy="170" r="112" fill="none" stroke-dasharray="2 7" />
      <circle class="lb-dots" cx="170" cy="170" r="92" fill="none" stroke-dasharray="2 7" />
    </svg>
    <!-- Today's segment again, pulsing above the still one (opacity only). -->
    <svg v-if="!waiting" class="lb-layer lb-move lb-today" viewBox="0 0 340 340" aria-hidden="true">
      <template v-for="(s, i) in segments" :key="i">
        <path
          v-if="s.state === 'today'"
          :d="s.d"
          class="lb-seg lb-seg-glow"
          fill="none"
          stroke-width="9"
          stroke-linecap="round"
        />
      </template>
    </svg>
    <!-- The orbiting dots: three orbits while learning, two slow ones while waiting. -->
    <svg class="lb-layer lb-move lb-orbit lb-o1" viewBox="0 0 340 340" aria-hidden="true">
      <circle class="lb-dot-a" cx="170" cy="58" r="4.5" />
      <circle v-if="!waiting" class="lb-dot-a" cx="282" cy="170" r="3" opacity="0.6" />
    </svg>
    <svg class="lb-layer lb-move lb-orbit lb-o2" viewBox="0 0 340 340" aria-hidden="true">
      <circle class="lb-dot-b" cx="170" cy="78" r="3.5" />
      <circle v-if="!waiting" class="lb-dot-b" cx="78" cy="170" r="2.5" opacity="0.6" />
    </svg>
    <svg
      v-if="!waiting"
      class="lb-layer lb-move lb-orbit lb-o3"
      viewBox="0 0 340 340"
      aria-hidden="true"
    >
      <circle class="lb-dot-c" cx="249" cy="91" r="3" />
    </svg>
    <!-- The halo. -->
    <svg class="lb-layer lb-move lb-pulse" viewBox="0 0 340 340" aria-hidden="true">
      <circle class="lb-halo" cx="170" cy="170" r="70" />
    </svg>
    <!-- The brain: two halves and the line between them, still. -->
    <svg class="lb-brain" viewBox="0 0 120 120" aria-hidden="true">
      <g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path v-for="d in HALVES" :key="d" :d="d" class="lb-stroke" />
        <path d="M60 26 V94" class="lb-mid" />
      </g>
    </svg>
    <!-- Its folds, in three layers that light up in turn (opacity only). -->
    <svg
      v-for="turn in TURNS"
      :key="turn"
      :class="['lb-brain lb-move lb-turn', `lb-turn-${turn}`]"
      viewBox="0 0 120 120"
      aria-hidden="true"
    >
      <g fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <template v-for="f in FOLDS" :key="f.d">
          <path v-if="f.turn === turn" :d="f.d" class="lb-stroke lb-fold" />
        </template>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.lb {
  --lb-bright: color-mix(in srgb, var(--primary) 55%, var(--text));
  --lb-dim: color-mix(in srgb, var(--primary) 16%, var(--text-subtle));
  --lb-line: var(--lb-bright);
  position: relative;
  width: 100%;
  aspect-ratio: 1;
}
.lb[data-state='waiting'] {
  --lb-line: var(--lb-dim);
}
.lb[data-preview='on'] {
  --lb-line: var(--lb-bright);
}
.lb-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.lb-brain {
  position: absolute;
  left: 32.353%;
  top: 32.353%;
  width: 35.294%;
  height: 35.294%;
}

/* ---- the ring ---- */
.lb-seg {
  transition: stroke 0.5s ease;
}
.lb-seg-done {
  stroke: var(--primary);
}
.lb-seg-today {
  stroke: var(--warning);
}
.lb-seg-glow {
  stroke: color-mix(in srgb, var(--warning) 70%, var(--text));
}
.lb-seg-todo {
  stroke: var(--border);
}
/* The part of a day that is learned, over its empty track. */
.lb-seg-part {
  stroke: var(--primary);
}
/* The preview of day 1 on the upgrade page: the first segment fills, in Pro's own green. */
.lb[data-preview='on'] .lb-seg-today {
  stroke: var(--primary);
}
.lb-day {
  fill: var(--text-muted);
}
.lb-day-done {
  fill: var(--lb-bright);
}
.lb-day-today {
  fill: var(--warning);
}
.lb[data-preview='on'] .lb-day-today {
  fill: var(--lb-bright);
}
.lb-dots {
  stroke: var(--surface-3);
}

/* ---- the moving layers: transform and opacity only ---- */
.lb-move {
  will-change: transform, opacity;
}
.lb-orbit {
  transform-origin: 50% 50%;
}
.lb-o1 {
  animation: lb-spin 14s linear infinite;
}
.lb-o2 {
  animation: lb-spin 22s linear infinite reverse;
}
.lb-o3 {
  animation: lb-spin 31s linear infinite;
}
.lb-dot-a {
  fill: color-mix(in srgb, var(--primary) 70%, var(--text));
}
.lb-dot-b {
  fill: color-mix(in srgb, var(--info) 55%, var(--text));
}
.lb-dot-c {
  fill: color-mix(in srgb, var(--chart-4) 70%, var(--text));
}
.lb-pulse {
  transform-origin: 50% 50%;
  animation: lb-pulse 3.6s ease-in-out infinite;
}
.lb-halo {
  fill: color-mix(in srgb, var(--primary) 7%, transparent);
  stroke: var(--primary-glow);
}
.lb-today {
  animation: lb-blink 2.4s ease-in-out infinite;
}

/* ---- the brain ---- */
.lb-stroke {
  stroke: var(--lb-line);
  transition: stroke 0.5s ease;
}
.lb-mid {
  stroke: color-mix(in srgb, var(--lb-line) 45%, var(--bg));
  transition: stroke 0.5s ease;
}
/* The folds: drawn once when the page opens, then each layer lights up in its turn. */
.lb-fold {
  stroke-dasharray: 60;
  animation: lb-draw-in 1.6s ease-out both;
}
.lb-turn-b .lb-fold {
  animation-delay: 0.5s;
}
.lb-turn-c .lb-fold {
  animation-delay: 1s;
}
.lb-turn {
  animation: lb-light 5s ease-in-out infinite;
}
.lb-turn-b {
  animation-delay: 1.2s;
}
.lb-turn-c {
  animation-delay: 2.4s;
}

/* ---- waiting: dim and calm, never as if it were learning ---- */
.lb[data-state='waiting'] .lb-o1 {
  animation-duration: 46s;
}
.lb[data-state='waiting'] .lb-o2 {
  animation-duration: 64s;
}
.lb[data-state='waiting'] .lb-dot-a,
.lb[data-state='waiting'] .lb-dot-b {
  fill: var(--text-subtle);
}
.lb[data-state='waiting'] .lb-pulse {
  animation: lb-breathe 9s ease-in-out infinite;
}
.lb[data-state='waiting'] .lb-halo {
  fill: color-mix(in srgb, var(--text) 3%, transparent);
  stroke: var(--border);
}
.lb[data-state='waiting'] .lb-fold {
  animation: none;
  stroke-dasharray: none;
}
.lb[data-state='waiting'] .lb-turn {
  animation: lb-rare 16s ease-in-out infinite;
}
.lb[data-state='waiting'] .lb-turn-b {
  animation-delay: 5.3s;
}
.lb[data-state='waiting'] .lb-turn-c {
  animation-delay: 10.6s;
}
.lb[data-preview='on'] .lb-halo {
  fill: color-mix(in srgb, var(--primary) 7%, transparent);
  stroke: var(--primary-glow);
}

@keyframes lb-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes lb-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.55;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}
@keyframes lb-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.5;
  }
  50% {
    transform: scale(1.03);
    opacity: 0.8;
  }
}
@keyframes lb-blink {
  0%,
  100% {
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
}
@keyframes lb-draw-in {
  from {
    stroke-dashoffset: 60;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes lb-light {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}
/* A layer lights once, briefly, then rests for most of the cycle. */
@keyframes lb-rare {
  0%,
  78%,
  100% {
    opacity: 0.45;
  }
  88% {
    opacity: 1;
  }
}

/* Paused: the tab is hidden or the ring is out of view. */
.lb[data-motion='paused'] .lb-move,
.lb[data-motion='paused'] .lb-fold {
  animation-play-state: paused;
}
/* Reduced motion: everything still, the same information. */
.lb[data-motion='off'] .lb-move,
.lb[data-motion='off'] .lb-fold {
  animation: none;
}
.lb[data-motion='off'] .lb-today {
  opacity: 0;
}
.lb[data-motion='off'] .lb-fold {
  stroke-dasharray: none;
}
.lb[data-motion='off'] .lb-seg,
.lb[data-motion='off'] .lb-stroke,
.lb[data-motion='off'] .lb-mid {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .lb-move,
  .lb-fold {
    animation: none !important;
  }
  .lb-today {
    opacity: 0;
  }
  .lb-fold {
    stroke-dasharray: none;
  }
}
</style>
