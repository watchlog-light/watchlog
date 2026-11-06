<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import ComboBox, { type ComboboxOption } from '@/components/ui/ComboBox.vue';
import type { Filters } from '@/lib/servicemap-model';

// The service map's left column: what to show, namespaces with their number of
// services (a searchable multi-select above 10), and the legend.
// Docker fleets group by Compose project.
const props = defineProps<{
  namespaces: { name: string; count: number; watchlog: boolean; color: string }[];
  docker?: boolean;
}>();
const filters = defineModel<Filters>({ required: true });

const toggles = ['onlyProblems', 'hideIdle', 'externals', 'watchlog'] as const;
function set<K extends keyof Filters>(k: K, v: Filters[K]) {
  filters.value = { ...filters.value, [k]: v };
}
const many = computed(() => props.namespaces.length > 10);
const options = computed<ComboboxOption[]>(() =>
  props.namespaces.map((n) => ({ value: n.name, label: n.name, description: String(n.count) })),
);
const selectedNs = computed({
  get: () => filters.value.namespaces,
  set: (v: string[]) => set('namespaces', v),
});
/** Checked when nothing is selected (all) or when it is one of the selected. */
const checked = (ns: string) =>
  !filters.value.namespaces.length || filters.value.namespaces.includes(ns);
function toggleNs(ns: string, on: boolean) {
  const all = props.namespaces.map((n) => n.name);
  const current = filters.value.namespaces.length ? filters.value.namespaces : all;
  const next = on ? [...new Set([...current, ns])] : current.filter((x) => x !== ns);
  // Every namespace checked is the same as none selected: show all.
  set('namespaces', next.length === all.length ? [] : next);
}
</script>

<template>
  <aside
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-3"
    :aria-label="$t('serviceMap.filters.label')"
    data-testid="map-filters"
  >
    <div>
      <h3 class="mb-1.5 text-11 font-medium tracking-wide text-text-subtle uppercase">
        {{ $t('serviceMap.filters.show') }}
      </h3>
      <label
        v-for="k in toggles"
        :key="k"
        class="flex cursor-pointer items-center gap-2 rounded-control px-1.5 py-1 text-13 text-text select-none hover:bg-surface-2 max-lg:min-h-11"
      >
        <input
          type="checkbox"
          role="switch"
          class="switch"
          :checked="filters[k]"
          :data-testid="`filter-${k}`"
          @change="set(k, ($event.target as HTMLInputElement).checked)"
        />
        {{ $t(`serviceMap.filters.${k}`) }}
      </label>
    </div>

    <div>
      <h3 class="mb-1.5 text-11 font-medium tracking-wide text-text-subtle uppercase">
        {{ $t(docker ? 'serviceMap.filters.projects' : 'serviceMap.filters.namespaces') }}
      </h3>
      <ComboBox
        v-if="many"
        v-model="selectedNs"
        multiple
        clearable
        variant="toolbar"
        :options="options"
        :label="$t(docker ? 'serviceMap.filters.projects' : 'serviceMap.filters.namespaces')"
        :placeholder="$t('serviceMap.filters.allNamespaces')"
        testid="filter-namespaces"
      />
      <div v-else class="flex flex-col">
        <label
          v-for="n in namespaces"
          :key="n.name"
          class="flex cursor-pointer items-center gap-2 rounded-control px-1.5 py-1 text-13 text-text select-none hover:bg-surface-2 max-lg:min-h-11"
          data-testid="filter-namespace"
        >
          <input
            type="checkbox"
            class="accent-primary"
            :checked="checked(n.name)"
            @change="toggleNs(n.name, ($event.target as HTMLInputElement).checked)"
          />
          <span
            class="size-2 shrink-0 rounded-[2px]"
            :style="{ background: n.color }"
            aria-hidden="true"
          />
          <span class="min-w-0 truncate">{{ n.name }}</span>
          <span v-if="n.watchlog" class="text-12 text-text-subtle">{{
            $t('serviceMap.filters.ownNs')
          }}</span>
          <span class="ml-auto font-mono text-12 text-text-subtle">{{ n.count }}</span>
        </label>
        <p v-if="!namespaces.length" class="px-1.5 text-12 text-text-subtle">
          {{ $t('serviceMap.filters.noNamespaces') }}
        </p>
      </div>
    </div>

    <div>
      <h3 class="mb-1.5 text-11 font-medium tracking-wide text-text-subtle uppercase">
        {{ $t('serviceMap.legend.title') }}
      </h3>
      <ul class="flex flex-col gap-1.5 text-12 text-text-muted">
        <li class="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="34" y2="4" class="stroke-ok" stroke-width="2" />
            <circle cx="20" cy="4" r="2.5" class="fill-ok" />
          </svg>
          {{ $t('serviceMap.legend.ok') }}
        </li>
        <li class="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="34" y2="4" class="stroke-warning" stroke-width="2" />
          </svg>
          {{ $t('serviceMap.legend.warning') }}
        </li>
        <li class="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="34" y2="4" class="stroke-critical" stroke-width="2.5" />
          </svg>
          {{ $t('serviceMap.legend.critical') }}
        </li>
        <li class="flex items-center gap-2">
          <svg width="34" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="34"
              y2="4"
              class="stroke-idle"
              stroke-width="1.5"
              stroke-dasharray="3 3"
            />
          </svg>
          {{ $t('serviceMap.legend.idle') }}
        </li>
        <li>{{ $t('serviceMap.legend.width') }}</li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.switch {
  appearance: none;
  width: 30px;
  height: 18px;
  border-radius: 999px;
  background: var(--surface-3);
  position: relative;
  margin: 0;
  flex: none;
  cursor: pointer;
}
.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-subtle);
  transition: left 0.15s;
}
.switch:checked {
  background: var(--primary);
}
.switch:checked::after {
  left: 15px;
  background: var(--on-primary);
}
.switch:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.stroke-ok {
  stroke: var(--ok);
}
.fill-ok {
  fill: var(--ok);
}
.stroke-warning {
  stroke: var(--warning);
}
.stroke-critical {
  stroke: var(--critical);
}
.stroke-idle {
  stroke: var(--text-subtle);
}
@media (prefers-reduced-motion: reduce) {
  .switch::after {
    transition: none;
  }
}
</style>
