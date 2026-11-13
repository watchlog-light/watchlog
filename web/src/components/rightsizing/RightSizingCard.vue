<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import type { RightSizing } from '@watchlog/api-types';
import { formatBytes, formatCores } from '@watchlog/cause-words';
import { computed, ref, watch } from 'vue';
import { api } from '@/api/client';
import OverviewCard from '@/components/overview/OverviewCard.vue';
import { useLoader } from '@/composables/useLoader';
import { rightSizingPath } from '@/lib/rightsizing';
import RightSizingList from './RightSizingList.vue';

// The overview's right-sizing card (ADR-168): how many workloads or containers could give
// CPU or memory back, and how much, how many are at risk at their memory limit, and the
// first three hints (OOM risk first); "Show all" opens the whole list in place.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'docker';
  /** The top bar's namespace filter (Kubernetes); empty is every namespace. */
  namespaces?: string[];
}>();

const page = useLoader(() => api<RightSizing>(rightSizingPath(props.clusterId, {})));
watch(() => props.clusterId, page.load, { immediate: true });
const open = ref(false);

const hints = computed(() => {
  const all = page.data.value?.hints ?? [];
  const ns = props.namespaces ?? [];
  return ns.length ? all.filter((h) => ns.includes(h.object.namespace ?? '')) : all;
});
// Counted again after the namespace filter, as the API counts them.
const summary = computed(() => {
  const key = (h: (typeof hints.value)[number]) =>
    `${h.object.namespace ?? h.object.host}/${h.object.kind}/${h.object.name}`;
  const back = new Set<string>();
  const risk = new Set<string>();
  let cores = 0;
  let bytes = 0;
  for (const h of hints.value) {
    if (h.giveBack > 0) {
      back.add(key(h));
      if (h.resource === 'cpu') cores += h.giveBack;
      else bytes += h.giveBack;
    }
    if (h.code === 'memory_limit_oom' || h.code === 'memory_limit_tight') risk.add(key(h));
  }
  return { back: back.size, risk: risk.size, cores, bytes };
});
const objects = computed(
  () =>
    new Set(hints.value.map((h) => `${h.object.namespace ?? h.object.host}/${h.object.name}`)).size,
);
const shown = computed(() => (open.value ? hints.value : hints.value.slice(0, 3)));
const what = computed(() => (props.kind === 'docker' ? 'containers' : 'workloads'));
</script>

<template>
  <OverviewCard
    :title="$t('rightSizing.title')"
    :loading="page.skeleton.value"
    testid="rightsizing-card"
  >
    <template v-if="page.data.value">
      <div class="flex flex-col gap-1 px-3.5 py-3 text-13" data-testid="rightsizing-summary">
        <p v-if="summary.back" class="text-text">
          {{
            $t(
              `rightSizing.card.giveBack.${what}.${summary.cores && summary.bytes ? 'both' : summary.cores ? 'cpu' : 'memory'}`,
              {
                n: summary.back,
                cpu: formatCores(summary.cores),
                memory: formatBytes(summary.bytes),
              },
              summary.back,
            )
          }}
        </p>
        <p v-if="summary.risk" class="text-critical">
          {{ $t(`rightSizing.card.risk.${what}`, { n: summary.risk }, summary.risk) }}
        </p>
        <p v-if="!hints.length" class="text-text-muted">
          {{ $t(`rightSizing.card.none.${what}`) }}
        </p>
      </div>
      <div v-if="hints.length" class="border-t border-border">
        <RightSizingList id="rightsizing-card-list" :hints="shown" objects />
      </div>
      <button
        v-if="hints.length > 3"
        type="button"
        class="flex min-h-11 items-center justify-center gap-1.5 border-t border-border px-3.5 text-13 text-primary hover:bg-surface-2"
        :aria-expanded="open"
        aria-controls="rightsizing-card-list"
        data-testid="rightsizing-more"
        @click="open = !open"
      >
        {{
          open
            ? $t('rightSizing.card.fewer')
            : $t(`rightSizing.card.all.${what}`, { n: objects }, objects)
        }}
        <ChevronDown
          :class="['size-4 transition-transform', { 'rotate-180': open }]"
          aria-hidden="true"
        />
      </button>
    </template>
    <p
      v-else-if="page.error.value"
      class="px-3.5 py-3 text-13 text-text-muted"
      role="status"
      data-testid="rightsizing-error"
    >
      {{ $t('rightSizing.error') }}
    </p>
  </OverviewCard>
</template>
