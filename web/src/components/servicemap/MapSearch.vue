<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SearchField from '@/components/ui/SearchField.vue';
import type { SearchResult } from '@/lib/servicemap-model';

// Find a service, database or external (`/` focuses it): ↑/↓ choose a suggestion, Enter
// zooms to it on the map and selects it. The text also filters the Connections table.
const props = defineProps<{ results: SearchResult[] }>();
const emit = defineEmits<{ pick: [id: string] }>();
const query = defineModel<string>({ required: true });
const active = ref(0);
const open = ref(false);
watch(query, (q) => {
  active.value = 0;
  open.value = !!q.trim();
});
const shown = computed(() => (open.value ? props.results : []));

function pick(r: SearchResult | undefined) {
  if (!r) return;
  query.value = r.node.name;
  open.value = false;
  emit('pick', r.node.id);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!props.results.length) return;
    e.preventDefault();
    open.value = true;
    const n = props.results.length;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    pick(props.results[active.value]);
  }
}
</script>

<template>
  <div
    class="relative w-full sm:max-w-xs"
    @keydown="onKey"
    @focusout="open = false"
    @focusin="open = !!query.trim()"
  >
    <SearchField
      v-model="query"
      :label="$t('serviceMap.search.label')"
      :placeholder="$t('serviceMap.search.placeholder')"
      @clear="query = ''"
    />
    <ul
      v-if="open && query.trim()"
      id="map-search-results"
      role="listbox"
      :aria-label="$t('serviceMap.search.label')"
      class="absolute inset-x-0 top-[calc(100%+4px)] z-20 flex flex-col rounded-control border border-border-strong bg-surface-2 p-1 shadow-lg"
      data-testid="map-search-results"
    >
      <li
        v-for="(r, i) in shown"
        :key="r.node.id"
        role="option"
        :aria-selected="i === active"
        class="flex cursor-pointer items-center justify-between gap-2 rounded-control px-2 py-1.5 text-13 text-text"
        :class="i === active ? 'bg-surface-3' : 'hover:bg-surface-3'"
        @mousedown.prevent="pick(r)"
      >
        <span class="min-w-0 truncate">{{ r.node.name }}</span>
        <span class="shrink-0 font-mono text-12 text-text-subtle">
          {{ $t(`serviceMap.search.kind.${r.kind}`)
          }}{{ r.node.namespace ? ` · ${r.node.namespace}` : '' }}
        </span>
      </li>
      <li v-if="!shown.length" class="px-2 py-1.5 text-13 text-text-subtle">
        {{ $t('serviceMap.search.none') }}
      </li>
    </ul>
  </div>
</template>
