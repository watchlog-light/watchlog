<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Container, Hourglass, SearchX, X } from '@lucide/vue';
import type { DockerContainerList } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import CausePanel from '@/components/causes/CausePanel.vue';
import RightSizingPanel from '@/components/rightsizing/RightSizingPanel.vue';
import ContainerList from '@/components/docker/ContainerList.vue';
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
import { containerRows, filterContainerRows } from '@/lib/containers';
import { CONTAINER_STATUSES, hasStatus } from '@/lib/filter';
import { RANGE_SECONDS } from '@/lib/time';
import { useDockerScopeStore } from '@/stores/dockerScope';
import { useFleetStore } from '@/stores/fleet';
import { useUiStore } from '@/stores/ui';

// A Docker fleet's containers (Docker parity of the Workloads page): grouped by Compose
// project, problem groups first, with search, state chips (?status=), Failing
// (?problems=1), and WatchLog's own containers hidden unless ?own=show. The top bar's
// host and project filters apply.
const REFRESH_MS = 30_000;
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const fleet = useFleetStore();
const ui = useUiStore();
let timer: ReturnType<typeof setInterval> | undefined;

const range = computed(() => Math.max(300, RANGE_SECONDS[ui.timeRange]));
const failing = computed(() => route.query.problems === '1');
const hideOwn = computed(() => route.query.own !== 'show');

const page = useLoader(async () => {
  const f = await fleet.ensure();
  if (!f) return null;
  const r = await api<DockerContainerList>(
    `/clusters/${f.id}/docker/containers?range=${range.value}`,
  );
  return { rows: containerRows(r.containers), fleetId: f.id };
});
const rows = computed(() => page.data.value?.rows ?? []);
const filter = useListFilter();
const base = computed(() => ({
  terms: filter.terms.value,
  statuses: filter.statuses.value,
  scope: filter.scope.value,
  failing: failing.value,
  hideOwn: hideOwn.value,
}));
// A Compose service's page (?project=&service=): its containers and its probable cause.
const service = computed(() =>
  typeof route.query.service === 'string' && filter.scope.value.project ? route.query.service : '',
);
const shown = computed(() =>
  filterContainerRows(rows.value, base.value).filter(
    (r) => !service.value || r.composeService === service.value,
  ),
);
// Chip counts follow the other filters, not the chips themselves.
const stateCount = (s: (typeof CONTAINER_STATUSES)[number]) =>
  filterContainerRows(rows.value, { ...base.value, statuses: [] }).filter((c) => hasStatus(c, s))
    .length;
const failingCount = computed(
  () => filterContainerRows(rows.value, { ...base.value, failing: true }).length,
);
const ownHidden = computed(() => (hideOwn.value ? rows.value.filter((r) => r.watchlog).length : 0));
const attention = computed(() => shown.value.filter((r) => r.problem).length);
const hosts = computed(() => new Set(rows.value.map((r) => r.host)).size);
const summaryParts = computed(() => [
  { text: t('docker.list.summary', { n: shown.value.length }, shown.value.length) },
  ...(ownHidden.value ? [{ text: t('docker.list.ownHidden', { n: ownHidden.value }) }] : []),
  {
    text: t('kube.workloads.needAttention', { n: attention.value }, attention.value),
    critical: attention.value > 0,
  },
]);

// The top bar's host and project lists.
const dockerScope = useDockerScopeStore();
watch(rows, () => {
  dockerScope.hosts = [...new Set(rows.value.map((r) => r.host))];
  dockerScope.projects = [
    ...new Set(rows.value.map((r) => r.composeProject).filter((p): p is string => !!p)),
  ];
});

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}
// One URL change: the search box follows the URL.
function clearFilters() {
  void router.replace({ query: {} });
}

watch(
  () => ui.timeRange,
  () => void page.load(),
);
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
      :message="$t('docker.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-4" data-testid="containers-skeleton">
      <Skeleton shape="rect" class="h-9 w-full sm:max-w-md" />
      <Skeleton shape="rect" class="h-7 w-full sm:max-w-xl" />
      <SkeletonTable :columns="9" :label="$t('common.loading')" />
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!fleet.fleet"
        :icon="Container"
        :title="$t('empty.docker.title')"
        :description="$t('empty.docker.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />
      <EmptyState
        v-else-if="rows.length === 0"
        :icon="Hourglass"
        :title="$t('docker.noHosts.title')"
        :description="$t('docker.noHosts.description')"
        :action-label="$t('docker.noHosts.action')"
        :action-to="{ name: 'cluster-settings', params: { id: fleet.fleet.id } }"
      />
      <template v-else>
        <div class="flex flex-wrap items-center gap-2.5">
          <SearchField
            v-model="filter.input.value"
            class="min-w-48"
            :label="$t('docker.filter.label')"
            :placeholder="$t('docker.list.filter')"
            @clear="filter.clearText"
          />
          <LoadingIndicator :active="page.refreshing.value" />
          <span class="flex-1" />
          <ToggleSwitch
            :model-value="hideOwn"
            data-testid="hide-own"
            @update:model-value="(v: boolean) => setQuery({ own: v ? undefined : 'show' })"
            >{{ $t('docker.list.hideOwn') }}</ToggleSwitch
          >
        </div>

        <div class="flex flex-wrap items-center gap-2" data-testid="chips">
          <button
            v-for="s in CONTAINER_STATUSES"
            :key="s"
            type="button"
            class="chip"
            :aria-pressed="filter.statuses.value.includes(s)"
            :data-testid="`state-${s}`"
            @click="filter.toggleStatus(s)"
          >
            {{ $t(`docker.filter.status.${s}`) }} <b>{{ stateCount(s) }}</b>
          </button>
          <span v-if="service" class="chip" aria-pressed="true" data-testid="service-chip">
            {{ $t('causes.object.compose_service') }} {{ filter.scope.value.project }}/{{ service }}
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-full p-0.5 hover:bg-surface-3 max-lg:min-h-11 max-lg:min-w-11"
              :aria-label="$t('docker.list.clearService')"
              @click="setQuery({ service: undefined })"
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
            ✕ {{ $t('docker.list.failing') }} <b class="text-critical">{{ failingCount }}</b>
          </button>
        </div>

        <p class="text-13 text-text-muted" data-testid="summary">
          <template v-for="(part, i) in summaryParts" :key="i"
            >{{ i ? ' · ' : ''
            }}<span :class="{ 'text-critical': part.critical }">{{ part.text }}</span></template
          >
        </p>

        <CausePanel
          v-if="service && page.data.value"
          :key="`${filter.scope.value.project}/${service}`"
          :cluster-id="page.data.value.fleetId"
          :subject="`compose_service:${filter.scope.value.project}/${service}`"
          :name="`${filter.scope.value.project}/${service}`"
          quiet
        />
        <RightSizingPanel
          v-if="service && page.data.value"
          :key="`rs-${filter.scope.value.project}/${service}`"
          :cluster-id="page.data.value.fleetId"
          :query="{ project: filter.scope.value.project, service, system: 'true' }"
          :name="`${filter.scope.value.project}/${service}`"
        />

        <ContainerList
          v-if="shown.length"
          :containers="shown"
          :range="range"
          :terms="filter.terms.value"
          :show-host="hosts > 1"
        />
        <EmptyState
          v-else
          :icon="SearchX"
          :title="
            filter.query.value.trim()
              ? $t('docker.filter.noMatch.title', { q: filter.query.value.trim() })
              : $t('docker.filter.noMatch.scopeTitle')
          "
          :description="$t('docker.filter.noMatch.description')"
          data-testid="no-matches"
        >
          <template #action>
            <BaseButton variant="secondary" data-testid="clear-filters" @click="clearFilters">{{
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
