<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Pause,
  RotateCw,
  Square,
  TriangleAlert,
} from '@lucide/vue';
import { computed } from 'vue';
import TooltipHint from '@/components/ui/TooltipHint.vue';

// State and health are never shown by colour alone: icon + label (SPEC §11.1).
// `reason` (the one-line diagnosis) becomes a tooltip on the bad-state pill.
const props = defineProps<{ state: string; health?: string | null; reason?: string | null }>();

const STATES: Record<string, { icon: object; tone: string }> = {
  running: { icon: CircleCheck, tone: 'text-ok' },
  restarting: { icon: RotateCw, tone: 'text-warning' },
  exited: { icon: Square, tone: 'text-text-subtle' },
  paused: { icon: Pause, tone: 'text-info' },
  created: { icon: CircleDashed, tone: 'text-text-subtle' },
  dead: { icon: CircleX, tone: 'text-critical' },
};

const state = computed(
  () => STATES[props.state] ?? { icon: CircleDashed, tone: 'text-text-subtle' },
);
const known = computed(() => props.state in STATES);
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1.5">
    <!-- Exited/restarting: the reason sits on the state pill; unhealthy: on the health pill. -->
    <component
      :is="reason && health !== 'unhealthy' ? TooltipHint : 'span'"
      :text="reason ?? undefined"
    >
      <span
        class="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-12 text-text"
      >
        <component :is="state.icon" :class="['size-3.5', state.tone]" aria-hidden="true" />
        {{ known ? $t(`docker.state.${props.state}`) : props.state }}
      </span>
    </component>
    <component
      :is="reason ? TooltipHint : 'span'"
      v-if="health === 'unhealthy'"
      :text="reason ?? undefined"
      data-testid="unhealthy-pill"
    >
      <span
        class="inline-flex items-center gap-1 rounded-full border border-critical px-2 py-0.5 text-12 text-text"
      >
        <TriangleAlert class="size-3.5 text-critical" aria-hidden="true" />
        {{ $t('docker.health.unhealthy') }}
      </span>
    </component>
    <span
      v-else-if="health === 'healthy'"
      class="inline-flex items-center gap-1 text-12 text-text-muted"
    >
      <CircleCheck class="size-3.5 text-ok" aria-hidden="true" />
      {{ $t('docker.health.healthy') }}
    </span>
    <span
      v-else-if="health === 'starting'"
      class="inline-flex items-center gap-1 text-12 text-text-muted"
    >
      <CircleDashed class="size-3.5 text-info" aria-hidden="true" />
      {{ $t('docker.health.starting') }}
    </span>
  </span>
</template>
