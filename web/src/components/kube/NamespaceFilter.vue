<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Filter } from '@lucide/vue';
import type { NamespaceList } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import ComboBox from '@/components/ui/ComboBox.vue';
import { useNamespaceFilter } from '@/composables/useNamespaceFilter';
import { useKubeStore } from '@/stores/kube';

// The top bar's namespace selector (SPEC §4.3: multi-select, applies everywhere).
const { t } = useI18n();
const kube = useKubeStore();
const ns = useNamespaceFilter();
const list = ref<{ name: string; pods: number }[]>([]);

async function load() {
  const cluster = await kube.ensure().catch(() => null);
  if (!cluster) return;
  try {
    list.value = (await api<NamespaceList>(`/clusters/${cluster.id}/namespaces`)).namespaces;
    kube.namespaces = list.value.map((n) => n.name);
  } catch {
    // The filter keeps what the URL says; the pages show their own load errors.
  }
}

const options = computed(() =>
  list.value.map((n) => ({
    value: n.name,
    label: n.name,
    description: t('topBar.pods', { n: n.pods }, n.pods),
  })),
);
const selected = computed({
  get: () => ns.selected.value,
  set: (v: string[]) => ns.set(v),
});

onMounted(() => void load());
</script>

<template>
  <ComboBox
    v-model="selected"
    multiple
    clearable
    :options="options"
    :label="$t('topBar.namespace')"
    :placeholder="$t('topBar.allNamespaces')"
    :empty-text="list.length ? undefined : $t('topBar.noNamespaces')"
    :icon="Filter"
    variant="toolbar"
    class="w-72"
    testid="namespace-filter"
  />
</template>
