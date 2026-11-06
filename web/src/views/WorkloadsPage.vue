<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Boxes, Hourglass, SearchX, X } from '@lucide/vue';
import type { KubePodList, KubeWorkloadList } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import PodList from '@/components/kube/PodList.vue';
import WorkloadList from '@/components/kube/WorkloadList.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useListFilter } from '@/composables/useListFilter';
import { useLoader } from '@/composables/useLoader';
import { useNamespaceFilter, withQuery } from '@/composables/useNamespaceFilter';
import { RANGE_SECONDS } from '@/lib/time';
import { filterPods, filterWorkloads, severityOf } from '@/lib/workloads';
import { useKubeStore } from '@/stores/kube';
import { useUiStore } from '@/stores/ui';

// Workloads and pods (SPEC §4.3, ADR-111), one page with
// two levels (?view=pods) so filters, namespaces and search carry over. Kinds are a
// multi-select (?kind=A,B); "Failing" shows only rows that need attention (?problems=1);
// system namespaces are hidden unless ?system=show.
const REFRESH_MS = 30_000;
const KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;
const route = useRoute();
const router = useRouter();
const kube = useKubeStore();
const ui = useUiStore();
const ns = useNamespaceFilter();
let timer: ReturnType<typeof setInterval> | undefined;

const view = computed(() => (route.query.view === 'pods' ? 'pods' : 'workloads'));
const str = (v: unknown) => (typeof v === 'string' && v ? v : '');
const kinds = computed(() =>
  str(route.query.kind)
    .split(',')
    .filter((k) => (KINDS as readonly string[]).includes(k)),
);
const failing = computed(() => route.query.problems === '1');
const hideSystem = computed(() => route.query.system !== 'show');
const owner = computed(() =>
  route.query.wname
    ? {
        kind: str(route.query.wkind),
        name: str(route.query.wname),
        namespace: str(route.query.wns),
      }
    : null,
);
const range = computed(() => Math.max(300, RANGE_SECONDS[ui.timeRange]));

// The pod list (7 MB at 15,000 pods) is loaded only for the Pods level.
const page = useLoader(async () => {
  const cluster = await kube.ensure();
  if (!cluster) return null;
  const [w, p] = await Promise.all([
    api<KubeWorkloadList>(
      withQuery(`/clusters/${cluster.id}/workloads?range=${range.value}`, ns.query.value),
    ),
    view.value === 'pods'
      ? api<KubePodList>(withQuery(`/clusters/${cluster.id}/pods`, ns.query.value))
      : null,
  ]);
  return { workloads: w, pods: p?.pods ?? null, clusterId: cluster.id };
});
const workloads = computed(() => page.data.value?.workloads.workloads ?? []);
const pods = computed(() => page.data.value?.pods ?? []);
// Workloads are listed even before the pods have loaded.
const podsLoaded = computed(() => page.data.value?.pods !== null);
const system = computed(() => new Set(page.data.value?.workloads.systemNamespaces ?? []));

const filter = useListFilter();
const base = computed(() => ({
  failing: false,
  hideSystem: hideSystem.value,
  system: system.value,
  terms: filter.terms.value,
}));
const shownWorkloads = computed(() =>
  filterWorkloads(workloads.value, { ...base.value, kinds: kinds.value, failing: failing.value }),
);
const shownPods = computed(() =>
  filterPods(pods.value, { ...base.value, failing: failing.value, owner: owner.value }),
);
// Chip counts follow the other filters, not the chips themselves.
const kindCount = (k: string) =>
  filterWorkloads(workloads.value, { ...base.value, kinds: [k], failing: failing.value }).length;
const failingCount = computed(() =>
  view.value === 'pods'
    ? filterPods(pods.value, { ...base.value, failing: true, owner: owner.value }).length
    : filterWorkloads(workloads.value, { ...base.value, kinds: kinds.value, failing: true }).length,
);
const hiddenSystem = computed(() =>
  hideSystem.value
    ? (view.value === 'pods' ? pods.value : workloads.value).filter((r) =>
        system.value.has(r.namespace),
      ).length
    : 0,
);
const shown = computed(() => (view.value === 'pods' ? shownPods.value : shownWorkloads.value));
const attention = computed(() => shown.value.filter((r) => severityOf(r)).length);
const total = computed(() => (view.value === 'pods' ? pods.value : workloads.value).length);

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}
function toggleKind(k: string) {
  const next = kinds.value.includes(k) ? kinds.value.filter((x) => x !== k) : [...kinds.value, k];
  setQuery({ kind: next.length ? next.join(',') : undefined });
}
function clearFilters() {
  filter.clearText();
  setQuery({
    kind: undefined,
    problems: undefined,
    system: undefined,
    wkind: undefined,
    wname: undefined,
    wns: undefined,
  });
}

watch([ns.query, () => ui.timeRange], () => void page.load());
watch(view, (v) => {
  if (v === 'pods' && !podsLoaded.value) void page.load();
});
onMounted(() => {
  void page.load();
  timer = setInterval(page.load, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-4" data-testid="workloads-skeleton">
      <Skeleton shape="rect" class="h-9 w-full sm:max-w-md" />
      <Skeleton shape="rect" class="h-7 w-full sm:max-w-xl" />
      <SkeletonTable :columns="9" :label="$t('common.loading')" />
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!kube.cluster"
        :icon="Boxes"
        :title="$t('empty.workloads.title')"
        :description="$t('empty.workloads.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />
      <EmptyState
        v-else-if="workloads.length === 0 && pods.length === 0 && ns.selected.value.length === 0"
        :icon="Hourglass"
        :title="$t('kube.waiting.title')"
        :description="$t('kube.waiting.description')"
        :action-label="$t('kube.waiting.action')"
        :action-to="{ name: 'cluster-settings', params: { id: kube.cluster.id } }"
      />
      <template v-else>
        <div class="flex flex-wrap items-center gap-2.5">
          <SegmentedControl
            :model-value="view"
            :label="$t('kube.workloads.level')"
            :options="[
              { value: 'workloads', label: $t('kube.workloads.tabs.workloads') },
              { value: 'pods', label: $t('kube.workloads.tabs.pods') },
            ]"
            data-testid="level"
            @update:model-value="
              (v: string) => setQuery({ view: v === 'pods' ? 'pods' : undefined })
            "
          />
          <SearchField
            v-model="filter.input.value"
            class="min-w-48"
            :label="$t('kube.workloads.filter.label')"
            :placeholder="$t(`kube.workloads.filter.placeholder.${view}`)"
            @clear="filter.clearText"
          />
          <span class="flex-1" />
          <ToggleSwitch
            :model-value="hideSystem"
            data-testid="hide-system"
            @update:model-value="(v: boolean) => setQuery({ system: v ? undefined : 'show' })"
            >{{ $t('kube.workloads.hideSystem') }}</ToggleSwitch
          >
        </div>

        <div class="flex flex-wrap items-center gap-2" data-testid="chips">
          <template v-if="view === 'workloads'">
            <button
              v-for="k in KINDS"
              :key="k"
              type="button"
              class="chip"
              :aria-pressed="kinds.includes(k)"
              :data-testid="`kind-${k}`"
              @click="toggleKind(k)"
            >
              {{ k }} <b>{{ kindCount(k) }}</b>
            </button>
          </template>
          <span v-else-if="owner" class="chip" aria-pressed="true" data-testid="owner-chip">
            {{ owner.kind }} {{ owner.namespace }}/{{ owner.name }}
            <button
              type="button"
              class="rounded-full p-0.5 hover:bg-surface-3"
              :aria-label="$t('kube.workloads.clearOwner')"
              @click="setQuery({ wkind: undefined, wname: undefined, wns: undefined })"
            >
              <X class="size-3" aria-hidden="true" />
            </button>
          </span>
          <span class="flex-1" />
          <button
            type="button"
            class="chip"
            :aria-pressed="failing"
            data-testid="failing-chip"
            @click="setQuery({ problems: failing ? undefined : '1' })"
          >
            ✕ {{ $t('kube.workloads.failing') }} <b class="text-critical">{{ failingCount }}</b>
          </button>
        </div>

        <p
          class="flex flex-wrap items-center gap-x-1.5 text-13 text-text-muted"
          data-testid="summary"
        >
          <span>{{ $t(`kube.workloads.total.${view}`, { n: shown.length }, shown.length) }}</span>
          <template v-if="hiddenSystem">
            ·
            <span>
              {{ $t('kube.workloads.systemHidden', { n: hiddenSystem }, hiddenSystem) }}
              (<RouterLink
                :to="{ name: 'settings', query: { tab: 'general' } }"
                class="text-primary hover:underline"
                >{{ $t('kube.workloads.editList') }}</RouterLink
              >)
            </span>
          </template>
          ·
          <span :class="{ 'text-critical': attention > 0 }">{{
            $t('kube.workloads.needAttention', { n: attention }, attention)
          }}</span>
          <LoadingIndicator :active="page.refreshing.value" class="ml-1" />
        </p>

        <SkeletonTable
          v-if="view === 'pods' && !podsLoaded"
          :columns="8"
          :label="$t('common.loading')"
        />
        <template v-else-if="shown.length > 0">
          <WorkloadList
            v-if="view === 'workloads'"
            :workloads="shownWorkloads"
            :cluster-id="page.data.value!.clusterId"
            :range="range"
            :terms="filter.terms.value"
          />
          <PodList v-else :pods="shownPods" :terms="filter.terms.value" />
        </template>
        <EmptyState
          v-else
          :icon="SearchX"
          :title="$t('kube.workloads.noMatch.title')"
          :description="
            ns.selected.value.length && total === 0
              ? $t('kube.workloads.noMatch.namespaces')
              : $t('kube.workloads.noMatch.description')
          "
          data-testid="no-matches"
        >
          <template #action>
            <BaseButton variant="secondary" @click="clearFilters">{{
              $t('docker.filter.clear')
            }}</BaseButton>
          </template>
        </EmptyState>
      </template>
    </template>
  </div>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
.chip b {
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.chip[aria-pressed='true'] {
  border-color: color-mix(in srgb, var(--primary) 50%, transparent);
  background: var(--primary-soft);
  color: var(--text);
}
.chip[aria-pressed='true'] b {
  color: var(--primary);
}
.chip b.text-critical,
.text-critical {
  color: var(--critical);
}
.chip:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
/* Touch screens: 44 px targets. */
@media (max-width: 1023px) {
  .chip {
    min-height: 44px;
    padding-inline: 14px;
  }
}
</style>
