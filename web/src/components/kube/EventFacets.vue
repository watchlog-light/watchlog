<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeEventSummary } from '@watchlog/api-types';
import { computed, reactive } from 'vue';
import { splitWorkload } from '@/lib/events';

// Facets for the Events page: kind, namespace (with "cluster-wide") and reason, each
// value with its count. Nothing ticked means all; ticking narrows to the ticked values.
// Long lists show the top values first.
export type Facet = 'kinds' | 'ns' | 'reasons' | 'hosts' | 'workloads';
const TOP = 8;
// Server fleets (`docker`): Server and Workload facets (a workload with its kind); the
// Compose project only within containers (Container ticked, or a project chosen).
const props = defineProps<{
  facets: KubeEventSummary['facets'] | null;
  selected: Record<Facet, string[]>;
  docker?: boolean;
}>();
const FACETS = computed<Facet[]>(() => {
  if (!props.docker) return ['kinds', 'ns', 'reasons'];
  const projects = props.selected.kinds.includes('Container') || props.selected.ns.length > 0;
  return projects
    ? ['kinds', 'hosts', 'workloads', 'ns', 'reasons']
    : ['kinds', 'hosts', 'workloads', 'reasons'];
});
const LABEL: Partial<Record<Facet, string>> = {
  hosts: 'servers',
  ns: 'projects',
  workloads: 'workloads',
};
const emit = defineEmits<{ change: [facet: Facet, values: string[]] }>();
const expanded = reactive<Record<Facet, boolean>>({
  kinds: false,
  ns: false,
  reasons: false,
  hosts: false,
  workloads: false,
});
const fmt = new Intl.NumberFormat('en');

const rows = (f: Facet) => {
  const list =
    f === 'kinds'
      ? props.facets?.kinds
      : f === 'ns'
        ? props.facets?.namespaces
        : f === 'hosts'
          ? props.facets?.hosts
          : f === 'workloads'
            ? props.facets?.workloads
            : props.facets?.reasons;
  const values = (list ?? []).map((x) => ({ value: x.value, count: x.count }));
  // Ticked values stay listed even when they have nothing in this range.
  for (const v of props.selected[f])
    if (!values.some((x) => x.value === v)) values.push({ value: v, count: 0 });
  return values;
};
function toggle(f: Facet, value: string) {
  const cur = props.selected[f];
  emit('change', f, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
}
</script>

<template>
  <aside class="facets" data-testid="event-facets">
    <div v-for="f in FACETS" :key="f" :data-testid="`facet-${f}`">
      <div class="mb-1.5 flex items-center justify-between">
        <h3>{{ $t(`kube.events.facets.${(docker && LABEL[f]) || f}`) }}</h3>
        <button
          v-if="selected[f].length"
          type="button"
          class="text-12 text-primary hover:underline max-lg:min-h-11 max-lg:px-2"
          @click="emit('change', f, [])"
        >
          {{ $t('kube.events.facets.all') }}
        </button>
      </div>
      <label
        v-for="r in expanded[f] ? rows(f) : rows(f).slice(0, TOP)"
        :key="r.value"
        class="fc"
        data-testid="facet-value"
      >
        <input
          type="checkbox"
          :checked="selected[f].includes(r.value)"
          @change="toggle(f, r.value)"
        />
        <template v-if="f === 'workloads'">
          <span class="min-w-0 truncate font-mono text-12" :title="r.value">{{
            splitWorkload(r.value).name
          }}</span>
          <span class="kt">{{
            $t(
              `kube.events.facets.kind.${splitWorkload(r.value).kind}`,
              splitWorkload(r.value).kind,
            )
          }}</span>
        </template>
        <span v-else class="min-w-0 truncate" :title="r.value">{{
          f === 'ns' && r.value === '-'
            ? $t(docker ? 'kube.events.facets.standalone' : 'kube.events.facets.clusterWide')
            : r.value
        }}</span>
        <span class="n">{{ fmt.format(r.count) }}</span>
      </label>
      <p v-if="!rows(f).length" class="px-1.5 text-12 text-text-subtle">
        {{ $t('kube.events.facets.none') }}
      </p>
      <button
        v-if="rows(f).length > TOP"
        type="button"
        class="mt-1 px-1.5 text-12 text-text-muted hover:text-text max-lg:min-h-11"
        @click="expanded[f] = !expanded[f]"
      >
        {{
          expanded[f]
            ? $t('kube.events.facets.less')
            : $t('kube.events.facets.more', { n: rows(f).length - TOP })
        }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.facets {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
}
h3 {
  color: var(--text-subtle);
  font-size: var(--text-11);
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.fc {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.fc:hover {
  background: var(--surface-2);
}
.fc input {
  margin: 0;
  accent-color: var(--primary);
}
.kt {
  flex-shrink: 0;
  color: var(--text-subtle);
  font-size: 12px;
}
.n {
  margin-left: auto;
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
/* Touch screens: each value is a 44 px row. */
@media (max-width: 1023px) {
  .fc {
    min-height: 44px;
  }
}
</style>
