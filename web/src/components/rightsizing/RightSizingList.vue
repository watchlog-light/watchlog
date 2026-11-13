<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleAlert, Gauge, MinusCircle, TrendingDown } from '@lucide/vue';
import type { RightSizingHint } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { hintLines, type Tone } from '@/lib/rightsizing';
import { LINKS } from '@/lib/links';

// Right-sizing hints as sentences (ADR-168): one line each, a word for what kind of hint it
// is (never a score), and with `objects` the workload or container it is about as a link.
const props = defineProps<{ hints: RightSizingHint[]; objects?: boolean }>();
const { t } = useI18n();
const lines = computed(() => hintLines(props.hints, t));

const ICON: Record<Tone, typeof Gauge> = {
  risk: CircleAlert,
  held: Gauge,
  back: TrendingDown,
  unset: MinusCircle,
};

function target(h: RightSizingHint) {
  const o = h.object;
  if (o.host !== undefined) {
    return { name: 'docker-container', params: { host: o.host, name: o.name } };
  }
  return {
    name: 'workloads',
    query: { view: 'pods', wkind: o.kind, wname: o.name, wns: o.namespace },
  };
}
</script>

<template>
  <ul class="flex flex-col" data-testid="rightsizing-list">
    <li
      v-for="l in lines"
      :key="l.key"
      class="flex gap-3 border-b border-border px-4 py-3 last:border-b-0"
      :data-code="l.hint.code"
      data-testid="rightsizing-hint"
    >
      <component
        :is="ICON[l.tone]"
        :class="[
          'mt-0.5 size-4 shrink-0',
          {
            'text-critical': l.tone === 'risk',
            'text-warning': l.tone === 'held',
            'text-info': l.tone === 'back',
            'text-text-subtle': l.tone === 'unset',
          },
        ]"
        aria-hidden="true"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-12 font-medium text-text-muted">
          {{ $t(`rightSizing.tone.${l.tone}`) }}
          <template v-if="objects">
            ·
            <RouterLink
              :to="target(l.hint)"
              class="text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
              >{{
                l.hint.object.namespace
                  ? `${l.hint.object.namespace}/${l.hint.object.name}`
                  : l.hint.object.name
              }}</RouterLink
            >
          </template>
          <template v-if="l.hint.container && l.hint.container !== l.hint.object.name">
            · {{ $t('rightSizing.container', { name: l.hint.container }) }}
          </template>
        </span>
        <p class="text-13 leading-5 text-text">
          {{ $t(l.message, l.values, typeof l.values.n === 'number' ? l.values.n : 1) }}
        </p>
        <a
          v-if="l.cause"
          :href="LINKS.probableCause"
          target="_blank"
          rel="noopener"
          class="self-start text-12 text-primary hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
          :data-testid="`rightsizing-cause-${l.cause}`"
          >{{ $t(`rightSizing.cause.${l.cause}`) }}</a
        >
      </div>
    </li>
  </ul>
</template>
