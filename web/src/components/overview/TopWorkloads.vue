<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { Overview } from '@/lib/overview';
import { formatValue } from '@/lib/units';
import OverviewCard from './OverviewCard.vue';
import SegmentedControl from './SegmentedControl.vue';

// The busiest workloads (Docker: containers) by CPU or memory: a bar for usage with a
// tick at the request (Docker: CPU limit), scaled to the largest of the two. System
// namespaces (Settings → General; Docker: WatchLog's containers) are hidden by default.
const TOP = 5;
const props = defineProps<{ overview: Overview }>();
const by = ref<'cpu' | 'memory'>('cpu');
const hideSystem = ref(true);
const rows = computed(() =>
  props.overview.top[by.value].filter((r) => !hideSystem.value || !r.system).slice(0, TOP),
);
const hasSystem = computed(() => props.overview.top[by.value].some((r) => r.system));
const max = computed(() => Math.max(1e-9, ...rows.value.flatMap((r) => [r.usage, r.request ?? 0])));
/** CPU in millicores below one core ("310m", as kubectl shows it), memory in bytes. */
const fmt = (v: number) =>
  by.value === 'cpu'
    ? v < 1
      ? `${Math.round(v * 1000)}m`
      : `${+v.toFixed(2)}`
    : formatValue(v, 'bytes');
const link = (r: (typeof rows.value)[number]) =>
  props.overview.kind === 'docker'
    ? { name: 'docker-container', params: { host: r.namespace ?? '', name: r.name } }
    : {
        name: 'workloads',
        query: { view: 'pods', wkind: r.kind, wns: r.namespace, wname: r.name },
      };
</script>

<template>
  <OverviewCard
    :title="$t(overview.kind === 'docker' ? 'overview.top.containers' : 'overview.top.title')"
    testid="card-top"
  >
    <template #actions>
      <SegmentedControl
        v-model="by"
        :label="$t('overview.top.sort')"
        :options="[
          { value: 'cpu', label: $t('overview.kpi.cpu') },
          { value: 'memory', label: $t('overview.kpi.memory') },
        ]"
      />
    </template>
    <ul v-if="rows.length" class="flex flex-col py-1.5">
      <li v-for="r in rows" :key="`${r.namespace}/${r.name}`">
        <RouterLink :to="link(r)" class="twr" data-testid="top-row">
          <span class="block min-w-0 truncate text-13 text-text">
            {{ r.name }} <small class="text-text-subtle">{{ r.namespace }}</small>
          </span>
          <span
            class="bar"
            role="img"
            :aria-label="
              $t('overview.top.barLabel', {
                usage: fmt(r.usage),
                request: r.request === null ? '–' : fmt(r.request),
              })
            "
          >
            <span
              class="u"
              :class="by === 'cpu' ? 'bg-info' : 'bg-violet'"
              :style="{ width: `${(r.usage / max) * 100}%` }"
            />
            <span
              v-if="r.request !== null"
              class="q"
              :style="{ left: `${(r.request / max) * 100}%` }"
            />
          </span>
          <span
            class="text-right font-mono text-12 text-text-muted"
            :title="by === 'cpu' ? $t('overview.top.cores', { v: r.usage.toFixed(3) }) : undefined"
            >{{ fmt(r.usage) }}</span
          >
        </RouterLink>
      </li>
    </ul>
    <p v-else class="px-3.5 py-6 text-13 text-text-muted">{{ $t('overview.top.empty') }}</p>
    <div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pb-3 text-12">
      <span class="text-text-subtle">{{
        $t(overview.kind === 'docker' ? 'overview.top.legendDocker' : 'overview.top.legend')
      }}</span>
      <label
        v-if="hasSystem || !hideSystem"
        class="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-text-muted"
      >
        <input
          v-model="hideSystem"
          type="checkbox"
          class="accent-primary"
          data-testid="top-hide-system"
        />
        {{ $t(overview.kind === 'docker' ? 'overview.top.hideOwn' : 'overview.top.hideSystem') }}
      </label>
    </div>
  </OverviewCard>
</template>

<style scoped>
.twr {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 64px;
  gap: 10px;
  align-items: center;
  padding: 7px 14px;
}
.twr:hover {
  background: var(--surface-2);
}
.twr:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.bar {
  position: relative;
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-3);
}
.bar .u {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
}
.bar .q {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: var(--text-muted);
}
.bg-info {
  background: var(--info);
}
.bg-violet {
  background: var(--chart-4);
}
</style>
