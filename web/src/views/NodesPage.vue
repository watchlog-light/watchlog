<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Hourglass, Info, SearchX, Server, X } from '@lucide/vue';
import type { DockerHostList, KubeNodeList } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import NodeCard from '@/components/kube/NodeCard.vue';
import NodeTable from '@/components/kube/NodeTable.vue';
import NodeTiles from '@/components/kube/NodeTiles.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonStatTile from '@/components/ui/SkeletonStatTile.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useListFilter } from '@/composables/useListFilter';
import { useLoader } from '@/composables/useLoader';
import { LINKS } from '@/lib/links';
import { defaultLayout, hostModel, nodeModel, type NodeModel } from '@/lib/nodes';
import { RANGE_SECONDS } from '@/lib/time';
import { useClustersStore } from '@/stores/clusters';
import { useUiStore } from '@/stores/ui';

// Nodes (SPEC §4.2, ADR-111): capacity tiles, one
// dismissible notice for unverified kubelet certificates, and the nodes as cards (with
// their pod heatmaps) or a table; cards up to 12 nodes, a table beyond (?layout=).
// With `hosts`, the same page shows a Docker fleet's hosts (Docker parity: the Hosts
// page is this design, with containers for pods).
const props = defineProps<{ hosts?: boolean }>();
const REFRESH_MS = 30_000;
const route = useRoute();
const router = useRouter();
const clusters = useClustersStore();
// The selected cluster when it is of this page's kind.
const kube = computed(() => ({
  cluster:
    clusters.selected?.kind === (props.hosts ? 'docker' : 'kubernetes') ? clusters.selected : null,
}));
const ui = useUiStore();
let timer: ReturnType<typeof setInterval> | undefined;

const range = computed(() => Math.max(300, RANGE_SECONDS[ui.timeRange]));
const chosen = computed(() =>
  route.query.layout === 'cards' || route.query.layout === 'table' ? route.query.layout : null,
);
const count = ref<number | null>(null);
const layout = computed(() => chosen.value ?? defaultLayout(count.value ?? 0));

const page = useLoader(async () => {
  await clusters.ensure();
  const cluster = kube.value.cluster;
  if (!cluster) return null;
  // The heatmaps are drawn on cards only; the table does without them. Until the node
  // count is known, ask without them.
  const get = async (
    heat: boolean,
  ): Promise<{ nodes: NodeModel[]; diskAlerts: KubeNodeList['diskAlerts'] }> => {
    const q = `?range=${range.value}${heat ? '&heat=1' : ''}`;
    if (props.hosts) {
      const r = await api<DockerHostList>(`/clusters/${cluster.id}/docker/hosts${q}`);
      return { nodes: r.hosts.map(hostModel), diskAlerts: r.diskAlerts };
    }
    const r = await api<KubeNodeList>(`/clusters/${cluster.id}/nodes${q}`);
    return { nodes: r.nodes.map(nodeModel), diskAlerts: r.diskAlerts };
  };
  if (count.value === null && !chosen.value) {
    const r = await get(false);
    count.value = r.nodes.length;
    return layout.value === 'cards' ? get(true) : r;
  }
  const r = await get(layout.value === 'cards');
  count.value = r.nodes.length;
  return r;
});
const nodes = computed(() => page.data.value?.nodes ?? []);
const ready = computed(() => nodes.value.filter((n) => n.status === 'Ready').length);
const filter = useListFilter();
// Every term must match the name, a role, the kubelet version, OS or kernel.
const shown = computed(() =>
  nodes.value.filter((n) => {
    const text = [n.name, ...n.roles, n.kubeletVersion, n.osImage, n.kernelVersion]
      .join(' ')
      .toLowerCase();
    return filter.terms.value.every((term) => text.includes(term));
  }),
);
const unverified = computed(
  () => nodes.value.filter((n) => n.agent.kubeletTls === 'unverified').length,
);

// The notice stays dismissed in this browser, per cluster, until the count changes.
const noticeKey = computed(() => `watchlog.kubeletTls.${kube.value.cluster?.id}`);
const dismissed = ref<string | null>(null);
function readDismissed() {
  try {
    dismissed.value = localStorage.getItem(noticeKey.value);
  } catch {
    dismissed.value = null;
  }
}
function dismiss() {
  dismissed.value = String(unverified.value);
  try {
    localStorage.setItem(noticeKey.value, dismissed.value);
  } catch {
    // Private windows: dismissed for this visit only.
  }
}
const showNotice = computed(
  () => unverified.value > 0 && dismissed.value !== String(unverified.value),
);

function setLayout(v: string) {
  void router.replace({ query: { ...route.query, layout: v } });
}

watch([() => ui.timeRange, chosen], () => void page.load());
watch(() => kube.value.cluster?.id, readDismissed);
onMounted(() => {
  readDismissed();
  void page.load();
  timer = setInterval(page.load, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="nodes flex flex-col gap-3.5">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-4" data-testid="nodes-skeleton">
      <Skeleton shape="rect" class="h-9 w-full sm:max-w-sm" />
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div
          v-for="i in 4"
          :key="i"
          class="rounded-[12px] border border-border bg-surface-1 px-4 py-3"
        >
          <SkeletonStatTile />
        </div>
      </div>
      <SkeletonTable :columns="8" :rows="3" :label="$t('common.loading')" />
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!kube.cluster"
        :icon="Server"
        :title="$t('empty.nodes.title')"
        :description="$t('empty.nodes.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />
      <EmptyState
        v-else-if="nodes.length === 0"
        :icon="Hourglass"
        :title="$t('kube.waiting.title')"
        :description="$t('kube.waiting.description')"
        :action-label="$t('kube.waiting.action')"
        :action-to="{ name: 'cluster-settings', params: { id: kube.cluster.id } }"
      />
      <template v-else>
        <div class="flex flex-wrap items-center gap-2.5">
          <span
            class="pill"
            :class="ready === nodes.length ? 'ok' : 'crit'"
            data-testid="ready-count"
            >{{ ready === nodes.length ? '✓' : '✕' }}
            {{
              $t(hosts ? 'docker.hosts.reportingCount' : 'kube.nodes.ready', {
                n: ready,
                total: nodes.length,
              })
            }}</span
          >
          <LoadingIndicator :active="page.refreshing.value" />
          <span class="flex-1" />
          <SearchField
            v-model="filter.input.value"
            class="min-w-48"
            :label="$t('kube.nodes.filter.label')"
            :placeholder="$t(hosts ? 'docker.hosts.filter' : 'kube.nodes.filter.placeholder')"
            @clear="filter.clearText"
          />
          <SegmentedControl
            :model-value="layout"
            :label="$t('kube.nodes.layout.label')"
            :options="[
              { value: 'cards', label: $t('kube.nodes.layout.cards') },
              { value: 'table', label: $t('kube.nodes.layout.table') },
            ]"
            data-testid="layout"
            @update:model-value="setLayout"
          />
        </div>

        <NodeTiles :nodes="nodes" :disk-alerts="page.data.value!.diskAlerts" />

        <div v-if="showNotice" class="notice" role="note" data-testid="kubelet-tls-note">
          <Info class="size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {{ $t('kube.nodes.tlsNotice', { n: unverified }, unverified) }}
            <a
              :href="LINKS.kubeletTls"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary hover:underline"
              >{{ $t('kube.nodes.howToFix') }}</a
            >
          </span>
          <button
            type="button"
            class="ml-auto flex shrink-0 items-center justify-center rounded p-1 text-text-subtle hover:text-text max-lg:-my-2 max-lg:size-11"
            :aria-label="$t('kube.nodes.dismiss')"
            data-testid="dismiss-tls"
            @click="dismiss"
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
        </div>

        <template v-if="shown.length > 0">
          <div v-if="layout === 'cards'" class="ngrid">
            <NodeCard v-for="n in shown" :key="n.name" :node="n" :terms="filter.terms.value" />
          </div>
          <NodeTable v-else :nodes="shown" :terms="filter.terms.value" />
        </template>
        <EmptyState
          v-else
          :icon="SearchX"
          :title="$t('kube.nodes.filter.noMatch', { q: filter.query.value.trim() })"
          :description="$t('kube.nodes.filter.noMatchDescription')"
        >
          <template #action>
            <BaseButton variant="secondary" @click="filter.clearAll">{{
              $t('docker.filter.clear')
            }}</BaseButton>
          </template>
        </EmptyState>
      </template>
    </template>
  </div>
</template>

<style scoped>
.nodes {
  container-type: inline-size;
}
.ngrid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
@container (max-width: 1100px) {
  .ngrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 700px) {
  .ngrid {
    grid-template-columns: minmax(0, 1fr);
  }
}
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: 13px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.pill.ok {
  color: var(--primary);
  background: var(--primary-soft);
}
.pill.crit {
  color: var(--critical);
  background: color-mix(in srgb, var(--critical) 12%, transparent);
}
.text-warning {
  color: var(--warning);
}
</style>
