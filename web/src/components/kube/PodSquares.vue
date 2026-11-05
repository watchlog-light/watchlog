<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeWorkload } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { squares } from '@/lib/workloads';

// Ready as "r/d" and one square per pod: ready, starting, failing (✕) or missing.
const MAX = 12;
const props = defineProps<{
  states: KubeWorkload['podStates'];
  ready: number;
  desired: number;
}>();
const { t } = useI18n();
const all = computed(() => squares(props.states, props.desired));
const label = computed(() =>
  [
    t('kube.workloads.readyOf', { r: props.ready, d: props.desired }),
    ...(['starting', 'failing', 'missing'] as const)
      .map((s) => [s, all.value.filter((x) => x === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => t(`kube.workloads.squares.${s}`, { n })),
  ].join(' · '),
);
</script>

<template>
  <span class="flex items-center gap-2" :title="label" :aria-label="label" role="img">
    <span
      class="font-mono text-13 tabular-nums"
      :class="ready < desired ? 'text-critical' : 'text-text'"
      >{{ ready }}/{{ desired }}</span
    >
    <span v-if="all.length" class="sq" aria-hidden="true">
      <span v-for="(s, i) in all.slice(0, MAX)" :key="i" :class="`s-${s}`" />
      <small v-if="all.length > MAX" class="text-12 text-text-subtle"
        >+{{ all.length - MAX }}</small
      >
    </span>
  </span>
</template>

<style scoped>
.sq {
  display: inline-grid;
  grid-auto-flow: column;
  align-items: center;
  gap: 2px;
}
.sq span {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}
.s-ready {
  background: color-mix(in srgb, var(--ok) 75%, transparent);
}
.s-starting {
  background: var(--warning);
}
.s-failing {
  background: var(--critical);
}
.s-missing {
  box-shadow: inset 0 0 0 1px var(--critical);
}
.text-critical {
  color: var(--critical);
}
</style>
