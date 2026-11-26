<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "Where is your number?" (1.0.3): the question that picks one of the three ways in, in a
// user's words and not in the ways' names. On Add a source it switches the tab; on the Your
// metrics page with no source yet it is the empty state and leads there (`cluster`).
import type { RouteLocationRaw } from 'vue-router';
import { WAYS } from '@/lib/own-add';
import type { Way } from '@/lib/own-metrics';

const props = defineProps<{
  /** The way that is open, on Add a source. */
  modelValue?: Way | null;
  /** The empty state: each answer is a link to Add a source for this cluster or fleet. */
  cluster?: string;
  /** Endpoints the quiet search found here, said on the /metrics answer. */
  found?: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [way: Way] }>();
const to = (w: Way): RouteLocationRaw => ({
  name: 'your-metrics-add',
  query: { cluster: props.cluster, way: w },
});
const CARD =
  'flex h-full w-full flex-col gap-2 rounded-card border px-4 py-4 text-left transition-colors';
</script>

<template>
  <fieldset class="m-0 min-w-0 border-0 p-0" data-testid="own-chooser">
    <legend class="p-0 text-16 font-semibold text-text">
      {{ $t('ownMetrics.add.chooser.q') }}
    </legend>
    <div class="mt-3 grid gap-3 md:grid-cols-3">
      <component
        :is="cluster ? 'RouterLink' : 'button'"
        v-for="w in WAYS"
        :key="w"
        v-bind="cluster ? { to: to(w) } : { type: 'button', 'aria-pressed': modelValue === w }"
        :class="[
          CARD,
          modelValue === w
            ? 'border-primary bg-primary/10'
            : 'border-border bg-surface-1 hover:border-border-strong hover:bg-surface-2',
        ]"
        :data-testid="`own-choose-${w}`"
        @click="!cluster && emit('update:modelValue', w)"
      >
        <span class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <span class="text-14 font-semibold text-text">{{
            $t(`ownMetrics.add.chooser.${w}.q`)
          }}</span>
          <span
            v-if="w === 'push'"
            class="rounded-full bg-primary px-2 py-0.5 text-12 font-semibold whitespace-nowrap text-on-primary"
            >{{ $t('ownMetrics.add.chooser.push.badge') }}</span
          >
          <span
            v-else-if="w === 'scrape' && found"
            class="rounded-full bg-ok/15 px-2 py-0.5 text-12 font-medium whitespace-nowrap text-ok-text"
            data-testid="own-choose-found"
            >{{ $t('ownMetrics.add.chooser.found', { n: found }, found) }}</span
          >
        </span>
        <span class="text-13 leading-relaxed text-text-muted">{{
          $t(`ownMetrics.add.chooser.${w}.sub`)
        }}</span>
        <span class="mt-auto pt-1 font-mono text-12 text-link"
          >→ {{ $t(`ownMetrics.ways.${w}.title`) }}</span
        >
      </component>
    </div>
  </fieldset>
</template>
