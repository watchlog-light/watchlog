<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The list of a cluster's own metrics (1.0.0, ADR-236): a search box, a chip per place they
// come from, one row per metric with its words, its last hour and its value now. The Go,
// process and scrape internals stay behind "Show all".
import type { OwnMetricList } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import SparkLine from '@/components/overview/SparkLine.vue';
import SearchField from '@/components/ui/SearchField.vue';
import { chipsOf, filterMetrics, ownerText, written } from '@/lib/own-metrics';

type Row = OwnMetricList['metrics'][number];

const props = defineProps<{
  metrics: Row[];
  /** Metrics left off the list (the internals). */
  hidden: number;
  selected: string | null;
  /** What the search box starts with (a link from a workload's or a server's page). */
  initialQuery?: string;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const showAll = defineModel<boolean>('showAll', { required: true });

const q = ref(props.initialQuery ?? '');
const chip = ref('all');
const chips = computed(() => chipsOf(props.metrics));
// A chip that no longer exists (its last metric went) falls back to All.
watch(chips, (list) => {
  if (!list.some((c) => c.key === chip.value)) chip.value = 'all';
});
const rows = computed(() => filterMetrics(props.metrics, q.value, chip.value));

function from(m: Row): string | null {
  const names = m.owners.map((o) => ownerText(o)).filter((x): x is string => !!x);
  if (names.length === 0) return null;
  return m.ownerCount > names.length || names.length > 2
    ? `${names.slice(0, 2).join(', ')} +${m.ownerCount - 2}`
    : names.join(', ');
}
</script>

<template>
  <section
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    :aria-label="$t('ownMetrics.tabs.metrics')"
    data-testid="own-list"
  >
    <div class="flex flex-wrap items-center gap-2 px-4 py-3.5">
      <SearchField
        v-model="q"
        class="min-w-44 flex-1"
        :label="$t('ownMetrics.list.search')"
        :placeholder="$t('ownMetrics.list.search')"
        data-testid="own-search"
        @clear="q = ''"
      />
      <div
        v-if="chips.length > 1"
        class="flex flex-wrap gap-1.5"
        role="group"
        :aria-label="$t('ownMetrics.list.from')"
      >
        <button
          v-for="c in chips"
          :key="c.key"
          type="button"
          :aria-pressed="chip === c.key"
          :class="[
            'inline-flex h-8 items-center rounded-control border px-3 text-13 transition-colors max-lg:h-11',
            chip === c.key
              ? 'border-primary bg-primary/10 text-text'
              : 'border-border text-text-muted hover:text-text',
          ]"
          :data-testid="`own-chip-${c.key}`"
          @click="chip = c.key"
        >
          {{ c.label || $t(`ownMetrics.list.chips.${c.key}`) }}
        </button>
      </div>
    </div>
    <ul>
      <li v-for="m in rows" :key="m.id">
        <button
          type="button"
          :aria-current="selected === m.id ? 'true' : undefined"
          :class="[
            'flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left transition-colors hover:bg-surface-2',
            selected === m.id ? 'bg-surface-2' : '',
          ]"
          data-testid="own-row"
          @click="emit('select', m.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-13 text-text">{{ m.name }}</span>
            <span class="mt-0.5 block truncate text-12 text-text-muted">
              {{ m.words }} ·
              {{ from(m) ?? $t(m.pushed ? 'ownMetrics.from.pushed' : 'ownMetrics.from.untied') }}
            </span>
          </span>
          <span
            v-if="m.refused"
            class="shrink-0 rounded-control bg-warning/15 px-2 py-0.5 text-12 text-warning-text"
            data-testid="own-row-refused"
          >
            {{ $t('ownMetrics.refused.short') }}
          </span>
          <SparkLine
            v-else
            class="shrink-0 max-sm:hidden"
            size="row"
            :values="m.spark ?? []"
            color-token="--chart-1"
          />
          <span class="w-24 shrink-0 text-right text-14 font-semibold tabular-nums text-text">
            {{ written(m.value, m).value }}
            <span class="text-12 font-normal text-text-muted">
              {{ written(m.value, m).ago ? $t('ownMetrics.ago') : written(m.value, m).unit }}
            </span>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="rows.length === 0" class="border-t border-border px-4 py-6 text-14 text-text-muted">
      {{ $t('ownMetrics.list.none') }}
    </p>
    <p
      v-if="hidden > 0 || showAll"
      class="border-t border-border px-4 py-3 text-13 text-text-muted"
      data-testid="own-hidden"
    >
      <template v-if="!showAll">
        {{
          $t('ownMetrics.list.hidden', { shown: metrics.length, total: metrics.length + hidden })
        }}
      </template>
      <template v-else>{{ $t('ownMetrics.list.all', { total: metrics.length }) }}</template>
      <button
        type="button"
        class="ml-1 text-link hover:underline"
        data-testid="own-show-all"
        @click="showAll = !showAll"
      >
        {{ $t(showAll ? 'ownMetrics.list.hideInternals' : 'ownMetrics.list.showAll') }}
      </button>
    </p>
  </section>
</template>
