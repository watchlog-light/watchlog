<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Layers, LayoutGrid } from '@lucide/vue';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { countLine, needsAttention, showsProLabel, toneOf } from '@/lib/all-clusters';
import { usePlanStore } from '@/stores/plan';
import { useAllClustersStore } from '@/stores/allClusters';
import ComboBox from '@/components/ui/ComboBox.vue';
import { KIND_LOGO } from '@/components/ui/kindLogos';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';

// The selected cluster or Server fleet, with each one's kind logo. Choosing one is the only way
// the selection changes (besides a link's ?cluster=); it opens its Overview. "All clusters and
// fleets" comes first (ADR-226, the design's Switcher board) with a one-line summary for Pro
// ("3 need attention · 30 nodes and servers"), then Kubernetes and Server fleets as groups,
// each with its status dot when the summary is known.
defineProps<{ collapsed: boolean }>();
const { t } = useI18n();
const tr = (k: string, v?: Record<string, unknown>) => t(k, v ?? {});
const router = useRouter();
const route = useRoute();
const clusters = useClustersStore();
const all = useAllClustersStore();
const auth = useAuthStore();
const ALL = '__all__';
const DOT = {
  critical: 'bg-critical',
  warning: 'bg-warning',
  healthy: 'bg-ok',
  muted: 'bg-text-subtle',
};

const onAll = computed(() => route.name === 'all-clusters');
const current = computed(() => (onAll.value ? null : clusters.selected));
const allNote = computed(() => {
  const s = all.summary;
  if (s) {
    const bad = s.clusters.filter(needsAttention).length;
    return t('allClusters.switcher.summary', {
      attention: bad
        ? t('allClusters.switcher.attention', { n: bad })
        : t('allClusters.switcher.healthy'),
      hosts: t('allClusters.hosts.both', { n: s.hosts.nodes + s.hosts.servers }),
    });
  }
  if (all.access === 'free') return t('allClusters.switcher.free');
  if (!auth.isCloud && !auth.demoMode) return t('allClusters.switcher.community');
  return undefined;
});
const options = computed(() => {
  const rows = new Map((all.summary?.clusters ?? []).map((r) => [r.id, r]));
  return [
    {
      value: ALL,
      label: t('nav.allClusters'),
      description: allNote.value,
      icon: LayoutGrid,
      ...(showsProLabel({
        isCloud: auth.isCloud,
        demo: auth.demoMode,
        proFeatures: usePlanStore().info?.proFeatures,
        access: all.access,
      })
        ? { badge: t('nav.pro') }
        : {}),
    },
    ...clusters.list.map((c) => {
      const r = rows.get(c.id);
      return {
        value: c.id,
        label: c.name,
        description: r ? countLine(r, tr) : t(`clusters.kind.${c.kind}`),
        icon: KIND_LOGO[c.kind],
        group: t(
          c.kind === 'server' ? 'allClusters.filter.server' : 'allClusters.filter.kubernetes',
        ),
        ...(r ? { dot: DOT[toneOf(r.status)] } : {}),
      };
    }),
  ];
});
const icon = computed(() =>
  onAll.value ? LayoutGrid : current.value ? KIND_LOGO[current.value.kind] : Layers,
);
function choose(id: string | null) {
  if (id === ALL) {
    if (!onAll.value) void router.push({ name: 'all-clusters' });
    return;
  }
  if (!id || (id === current.value?.id && !onAll.value) || !clusters.select(id)) {
    if (id && onAll.value) void router.push({ name: 'overview', query: { cluster: id } });
    return;
  }
  void router.push({ name: 'overview', query: { cluster: id } });
}

onMounted(() => {
  if (!auth.user) return;
  if (auth.isCloud || auth.demoMode) void all.ensure();
  if (clusters.loaded) return;
  clusters.load().catch(() => {});
});
</script>

<template>
  <div
    v-if="collapsed"
    class="flex h-10 items-center justify-center rounded-control border border-border bg-surface-2 text-text-muted"
    :title="onAll ? $t('nav.allClusters') : (current?.name ?? $t('clusterSwitcher.none'))"
  >
    <component :is="icon" class="size-4" aria-hidden="true" />
    <span class="sr-only">{{
      onAll ? $t('nav.allClusters') : (current?.name ?? $t('clusterSwitcher.none'))
    }}</span>
  </div>
  <ComboBox
    v-else
    :model-value="onAll ? ALL : (current?.id ?? null)"
    :options="options"
    :label="$t('clusterSwitcher.label')"
    :placeholder="$t('clusterSwitcher.none')"
    :icon="icon"
    :disabled="clusters.list.length === 0"
    testid="cluster-switcher"
    @update:model-value="choose"
  />
</template>
