<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowUp } from '@lucide/vue';
import type { ServiceMapEdge } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import TonePill from '@/components/kube/TonePill.vue';
import { useNarrow } from '@/composables/useNarrow';
import { HEALTH_TONE, latency, perSecond } from '@/lib/servicemap';
import { tableRows, throughput, type SortKey } from '@/lib/servicemap-model';
import { formatValue } from '@/lib/units';

// The Connections view: every edge in scope, grouped Needs attention / Healthy / Idle,
// sortable by any column. Only the rows in view are rendered (virtual list), so
// thousands of connections scroll smoothly. A row opens the edge on the map.
const props = defineProps<{
  edges: ServiceMapEdge[];
  name: (id: string) => string;
  ns: (id: string) => string | null;
}>();
const emit = defineEmits<{ open: [id: string] }>();

const sort = ref<{ key: SortKey; desc: boolean } | null>(null);
const rows = computed(() => tableRows(props.edges, props.name, sort.value));
const ROW_H = 44;
const VIEW_H = 640;
// Phones: each connection is a two-line card (name and health, then the numbers) in the
// page's own scroll, not virtualised, unless the list is very long.
const narrow = useNarrow();
const virtual = computed(() => !narrow.value || rows.value.length > 300);
const scrollTop = ref(0);
const window_ = computed(() => {
  if (!virtual.value) return { first: 0, list: rows.value };
  const first = Math.max(0, Math.floor(scrollTop.value / ROW_H) - 6);
  const count = Math.ceil(VIEW_H / ROW_H) + 12;
  return { first, list: rows.value.slice(first, first + count) };
});
const columns: { key: SortKey; num?: boolean }[] = [
  { key: 'name' },
  { key: 'health' },
  { key: 'rate', num: true },
  { key: 'failed', num: true },
  { key: 'p95', num: true },
  { key: 'throughput', num: true },
];
function sortBy(key: SortKey) {
  const cur = sort.value;
  // First click: numbers high to low, names A–Z; second click reverses; third resets.
  if (!cur || cur.key !== key) sort.value = { key, desc: key !== 'name' && key !== 'health' };
  else if (cur.desc === (key !== 'name' && key !== 'health')) sort.value = { key, desc: !cur.desc };
  else sort.value = null;
}
const ariaSort = (key: SortKey) =>
  sort.value?.key === key ? (sort.value.desc ? 'descending' : 'ascending') : 'none';
const failedText = (e: ServiceMapEdge) =>
  e.failedRatio === null ? '–' : formatValue(e.failedRatio, 'ratio');
</script>

<template>
  <section
    class="overflow-hidden rounded-card border border-border bg-surface-1"
    role="table"
    :aria-label="$t('serviceMap.views.connections')"
    :aria-rowcount="rows.length + 1"
    data-testid="connections-table"
  >
    <div role="rowgroup" class="border-b border-border">
      <div role="row" class="conn-grid conn-head text-12 font-medium text-text-muted">
        <div
          v-for="c in columns"
          :key="c.key"
          role="columnheader"
          :aria-sort="ariaSort(c.key)"
          :class="c.num ? 'justify-end' : ''"
          class="flex"
        >
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-control px-1 py-0.5 hover:text-text max-lg:min-h-11 max-lg:px-2"
            :data-testid="`sort-${c.key}`"
            @click="sortBy(c.key)"
          >
            {{
              $t(
                `serviceMap.columns.${c.key === 'name' ? 'edge' : c.key === 'rate' ? 'connections' : c.key === 'throughput' ? 'bytes' : c.key}`,
              )
            }}
            <ArrowDown v-if="sort?.key === c.key && sort.desc" class="size-3" aria-hidden="true" />
            <ArrowUp v-else-if="sort?.key === c.key" class="size-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
    <div
      role="rowgroup"
      class="overflow-y-auto"
      :style="
        virtual ? { height: `${Math.min(VIEW_H, Math.max(rows.length, 1) * ROW_H)}px` } : undefined
      "
      data-testid="connections-scroll"
      @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
    >
      <div
        :style="virtual ? { height: `${rows.length * ROW_H}px`, position: 'relative' } : undefined"
      >
        <div :style="virtual ? { transform: `translateY(${window_.first * ROW_H}px)` } : undefined">
          <template
            v-for="(r, i) in window_.list"
            :key="r.type === 'group' ? `g-${r.group}` : r.edge.id"
          >
            <div
              v-if="r.type === 'group'"
              role="row"
              :aria-rowindex="window_.first + i + 2"
              class="flex items-center bg-surface-2 px-3 text-12 font-medium text-text-muted max-md:min-h-9"
              :style="virtual ? { height: `${ROW_H}px` } : undefined"
              data-testid="conn-group"
            >
              <span role="cell">{{ $t(`serviceMap.groups.${r.group}`, { n: r.count }) }}</span>
            </div>
            <div
              v-else
              role="row"
              tabindex="0"
              :aria-rowindex="window_.first + i + 2"
              class="conn-grid cursor-pointer border-b border-border text-13 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              :style="virtual ? { height: `${ROW_H}px` } : undefined"
              data-testid="conn-row"
              @click="emit('open', r.edge.id)"
              @keydown.enter="emit('open', r.edge.id)"
            >
              <div role="cell" class="min-w-0 leading-tight">
                <div class="truncate text-text">
                  {{ name(r.edge.source) }} → {{ name(r.edge.target)
                  }}<span v-if="r.edge.port" class="text-text-subtle">:{{ r.edge.port }}</span>
                </div>
                <div class="truncate text-12 text-text-subtle">
                  {{ [ns(r.edge.source), ns(r.edge.target)].filter(Boolean).join(' → ') }}
                  <template v-if="r.edge.service">
                    · {{ $t('serviceMap.edge.via', { service: r.edge.service }) }}</template
                  >
                </div>
              </div>
              <div role="cell">
                <TonePill
                  :tone="HEALTH_TONE[r.edge.health] ?? 'neutral'"
                  :label="$t(`serviceMap.health.${r.edge.health}`)"
                />
              </div>
              <div role="cell" class="num">
                <span class="lbl">{{ $t('serviceMap.columns.connections') }}</span>
                {{ perSecond(r.edge.connectionsPerSecond) }}
              </div>
              <div
                role="cell"
                class="num"
                :class="(r.edge.failedRatio ?? 0) >= 0.01 ? 'text-critical' : ''"
              >
                <span class="lbl">{{ $t('serviceMap.columns.failed') }}</span>
                {{ failedText(r.edge) }}
              </div>
              <div role="cell" class="num">
                <span class="lbl">{{ $t('serviceMap.columns.p95') }}</span>
                {{ latency(r.edge.latencyP95Seconds) }}
              </div>
              <div role="cell" class="num">
                <span class="lbl">{{ $t('serviceMap.columns.bytes') }}</span>
                {{
                  r.edge.bytesSentPerSecond === null
                    ? '–'
                    : formatValue(throughput(r.edge), 'bytes_per_second')
                }}
              </div>
            </div>
          </template>
        </div>
      </div>
      <p v-if="!rows.length" class="px-3 py-3 text-13 text-text-muted" data-testid="conn-empty">
        {{ $t('serviceMap.connectionsEmpty') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.conn-grid {
  display: grid;
  grid-template-columns: minmax(0, 2.4fr) 120px 100px 80px 100px 110px;
  gap: 8px;
  align-items: center;
  padding: 0 12px;
  min-height: 36px;
}
.lbl {
  display: none;
}
.num {
  text-align: right;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
/* Phones: a two-line card per connection; the sort buttons wrap above the list. */
@media (max-width: 767px) {
  .conn-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-template-rows: auto auto;
    row-gap: 6px;
    padding: 10px 12px;
  }
  .conn-grid > :first-child {
    grid-column: 1 / 4;
  }
  .conn-grid > :nth-child(2) {
    justify-self: end;
  }
  .conn-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0 4px;
    padding: 4px 8px;
  }
  .num {
    text-align: left;
    font-size: 12px;
  }
  .lbl {
    display: block;
    color: var(--text-subtle);
    font-family: var(--font-sans, inherit);
    font-size: 12px;
  }
}
</style>
