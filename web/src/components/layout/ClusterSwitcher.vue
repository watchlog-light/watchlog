<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Container, Layers, Network } from '@lucide/vue';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import ComboBox from '@/components/ui/ComboBox.vue';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';

// The selected cluster or Docker fleet, with each one's kind icon. Choosing one is the
// only way the selection changes (besides a link's ?cluster=); it opens its Overview.
defineProps<{ collapsed: boolean }>();
const { t } = useI18n();
const router = useRouter();
const clusters = useClustersStore();

const current = computed(() => clusters.selected);
const KIND_ICON = { docker: Container, kubernetes: Network } as const;
const options = computed(() =>
  clusters.list.map((c) => ({
    value: c.id,
    label: c.name,
    description: t(`clusters.kind.${c.kind}`),
    icon: KIND_ICON[c.kind],
  })),
);
const icon = computed(() => (current.value ? KIND_ICON[current.value.kind] : Layers));
function choose(id: string | null) {
  if (!id || id === current.value?.id || !clusters.select(id)) return;
  void router.push({ name: 'overview', query: { cluster: id } });
}

onMounted(() => {
  if (!useAuthStore().user || clusters.loaded) return;
  clusters.load().catch(() => {});
});
</script>

<template>
  <div
    v-if="collapsed"
    class="flex h-10 items-center justify-center rounded-control border border-border bg-surface-2 text-text-muted"
    :title="current?.name ?? $t('clusterSwitcher.none')"
  >
    <component :is="icon" class="size-4" aria-hidden="true" />
    <span class="sr-only">{{ current?.name ?? $t('clusterSwitcher.none') }}</span>
  </div>
  <ComboBox
    v-else
    :model-value="current?.id ?? null"
    :options="options"
    :label="$t('clusterSwitcher.label')"
    :placeholder="$t('clusterSwitcher.none')"
    :icon="icon"
    :disabled="options.length === 0"
    testid="cluster-switcher"
    @update:model-value="choose"
  />
</template>
