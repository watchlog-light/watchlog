<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Globe, Hourglass, SearchX } from '@lucide/vue';
import type { Cluster, Egress, EgressSource } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import EgressTable from '@/components/egress/EgressTable.vue';
import ExpectationsList from '@/components/egress/ExpectationsList.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useListFilter } from '@/composables/useListFilter';
import { useLoader } from '@/composables/useLoader';
import {
  EGRESS_BADGE_FILTERS,
  egressRanges,
  egressPath,
  learningText,
  type EgressBadgeFilter,
  type EgressQuery,
  type EgressRange,
} from '@/lib/egress';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { useEgressStore } from '@/stores/egress';

// The Egress page (ADR-188, SPEC §4.14): what a cluster or a fleet talks to on the internet,
// in its own words (ADR-124). Kubernetes filters by namespace and workload; Docker by host,
// Compose project and container. Everything is in the URL, so a source page can link here.
const REFRESH_MS = 60_000;
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const clusters = useClustersStore();
const egress = useEgressStore();
let timer: ReturnType<typeof setInterval> | undefined;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const auth = useAuthStore();
// The demo answers at most 24 hours, so it offers only 1 h and 24 h (a 7 d link opens 24 h).
const ranges = computed(() => egressRanges(auth.demoMode));
const range = computed<EgressRange>(() =>
  (ranges.value as string[]).includes(String(route.query.range))
    ? (route.query.range as EgressRange)
    : '24h',
);
const badge = computed<EgressBadgeFilter | undefined>(() =>
  (EGRESS_BADGE_FILTERS as readonly string[]).includes(String(route.query.badge))
    ? (route.query.badge as EgressBadgeFilter)
    : undefined,
);
const SOURCE_KEYS = ['namespace', 'kind', 'workload', 'host', 'project', 'service', 'container'];
const sourceQuery = computed<EgressQuery>(() =>
  Object.fromEntries(SOURCE_KEYS.map((k) => [k, str(route.query[k])]).filter(([, v]) => v)),
);
const filter = useListFilter();
const query = computed<EgressQuery>(() => ({
  ...sourceQuery.value,
  ...(badge.value ? { badge: badge.value } : {}),
  ...(filter.terms.value.length ? { q: filter.terms.value.join(' ') } : {}),
}));

/** Every source of the unfiltered answer, kept for the filters' options. */
const known = ref<EgressSource[]>([]);
const page = useLoader(async () => {
  const cluster: Cluster | null = await clusters.ensure();
  if (!cluster) return null;
  const answer = await api<Egress>(egressPath(cluster.id, query.value, range.value));
  const unfiltered = !Object.keys(query.value).length;
  if (unfiltered) {
    known.value = answer.rows.flatMap((r) => r.sources);
    if (range.value === '24h') egress.set(cluster.id, answer.summary.new);
  }
  return { cluster, answer };
});
const cluster = computed(() => page.data.value?.cluster ?? null);
const answer = computed(() => page.data.value?.answer ?? null);
const docker = computed(() => cluster.value?.kind === 'docker');
const unit = (n: number) => t(docker.value ? 'egress.unit.docker' : 'egress.unit.kubernetes', n);
const filtered = computed(() => Object.keys(query.value).length > 0);
/** Bumped when a row's "Mark expected" or "Undo" changes the expectations list. */
const expectationsVersion = ref(0);
function onRowChanged() {
  expectationsVersion.value++;
  void page.load();
}

const uniq = (xs: (string | undefined)[]) =>
  [...new Set(xs.filter((x): x is string => !!x))].sort();
/** The filters' options, the selected value kept even when it isn't in the cache. */
const options = (key: string, values: (string | undefined)[]) =>
  uniq([...values, str(route.query[key])]);
const namespaces = computed(() =>
  options(
    'namespace',
    known.value.map((s) => s.namespace),
  ),
);
const workloads = computed(() =>
  options(
    'workload',
    known.value
      .filter((s) => !sourceQuery.value.namespace || s.namespace === sourceQuery.value.namespace)
      .map((s) => s.workload),
  ),
);
const hosts = computed(() =>
  options(
    'host',
    known.value.map((s) => s.host),
  ),
);
const projects = computed(() =>
  options(
    'project',
    known.value.map((s) => s.composeProject),
  ),
);
const containers = computed(() =>
  options(
    'container',
    known.value.map((s) => s.container),
  ),
);

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}
function clearFilters() {
  filter.clearText();
  setQuery(Object.fromEntries([...SOURCE_KEYS, 'badge'].map((k) => [k, undefined])));
}
const onSelect = (key: string, e: Event) => {
  const v = (e.target as HTMLSelectElement).value || undefined;
  setQuery(
    key === 'namespace'
      ? { namespace: v, workload: undefined, kind: undefined }
      : key === 'project'
        ? { project: v, service: undefined }
        : { [key]: v },
  );
};

const chips = computed(() => [
  { id: undefined, label: t('egress.filter.all') },
  ...EGRESS_BADGE_FILTERS.map((b) => ({ id: b, label: t(`egress.filter.${b}`) })),
]);

watch([query, range], () => void page.load());
onMounted(() => {
  void page.load();
  timer = setInterval(page.load, REFRESH_MS);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="flex flex-col gap-4">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('egress.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-4" data-testid="egress-skeleton">
      <Skeleton shape="rect" class="h-8 w-full sm:max-w-lg" />
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Skeleton v-for="i in 4" :key="i" shape="rect" class="h-20" />
      </div>
      <SkeletonTable :columns="7" :label="$t('common.loading')" />
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!cluster"
        :icon="Globe"
        :title="$t('egress.empty.noCluster.title')"
        :description="$t('egress.empty.noCluster.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />
      <template v-else-if="answer">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="text-18 font-semibold text-text" data-testid="egress-title">
              {{ $t('egress.title', { cluster: cluster.name }) }}
            </h2>
            <p class="text-13 text-text-muted" data-testid="egress-learning">
              {{ learningText(answer.learning, t) }}
              {{ $t('egress.namesFrom', { units: unit(2) }) }}
            </p>
          </div>
          <SegmentedControl
            :model-value="range"
            :label="$t('egress.range')"
            :options="ranges.map((r) => ({ value: r, label: $t(`egress.ranges.${r}`) }))"
            data-testid="egress-range"
            @update:model-value="(v: string) => setQuery({ range: v === '24h' ? undefined : v })"
          />
        </div>

        <dl class="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="egress-summary">
          <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
            <dt class="text-12 text-text-subtle">{{ $t('egress.summary.destinations') }}</dt>
            <dd class="font-mono text-20 text-text tabular">{{ answer.summary.destinations }}</dd>
            <dd class="mt-0.5 text-12 text-text-muted">
              {{
                $t('egress.summary.from', {
                  n: answer.summary.sources,
                  units: unit(answer.summary.sources),
                })
              }}
            </dd>
          </div>
          <div
            :class="[
              'rounded-card border bg-surface-1 px-4 py-3',
              answer.summary.new ? 'border-warning' : 'border-border',
            ]"
            data-testid="summary-new"
          >
            <dt class="text-12 text-text-subtle">{{ $t('egress.summary.new') }}</dt>
            <dd
              :class="[
                'font-mono text-20 tabular',
                answer.summary.new ? 'text-warning' : 'text-text',
              ]"
            >
              {{ answer.summary.new }}
            </dd>
            <dd class="mt-0.5 text-12 text-text-muted">
              {{ $t('egress.summary.newSub', { unit: unit(1) }) }}
            </dd>
          </div>
          <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
            <dt class="text-12 text-text-subtle">{{ $t('egress.summary.rawIp') }}</dt>
            <dd class="font-mono text-20 text-text tabular">{{ answer.summary.rawIp }}</dd>
            <dd class="mt-0.5 text-12 text-text-muted">{{ $t('egress.summary.rawIpSub') }}</dd>
          </div>
          <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
            <dt class="text-12 text-text-subtle">{{ $t('egress.summary.failing') }}</dt>
            <dd
              :class="[
                'font-mono text-20 tabular',
                answer.summary.failing ? 'text-critical' : 'text-text',
              ]"
            >
              {{ answer.summary.failing }}
            </dd>
            <dd class="mt-0.5 text-12 text-text-muted">{{ $t('egress.summary.failingSub') }}</dd>
          </div>
        </dl>

        <div class="flex flex-wrap items-center gap-2" data-testid="egress-filters">
          <div
            class="flex flex-wrap items-center gap-2"
            role="group"
            :aria-label="$t('egress.filter.label')"
          >
            <button
              v-for="c in chips"
              :key="c.id ?? 'all'"
              type="button"
              class="chip"
              :aria-pressed="badge === c.id"
              :data-testid="`chip-${c.id ?? 'all'}`"
              @click="setQuery({ badge: c.id })"
            >
              {{ c.label }}
            </button>
          </div>
          <template v-if="!docker">
            <select
              class="select"
              :aria-label="$t('egress.filter.namespace')"
              :value="sourceQuery.namespace ?? ''"
              data-testid="filter-namespace"
              @change="onSelect('namespace', $event)"
            >
              <option value="">{{ $t('egress.filter.allNamespaces') }}</option>
              <option v-for="n in namespaces" :key="n" :value="n">{{ n }}</option>
            </select>
            <select
              class="select"
              :aria-label="$t('egress.filter.workload')"
              :value="sourceQuery.workload ?? ''"
              data-testid="filter-workload"
              @change="onSelect('workload', $event)"
            >
              <option value="">{{ $t('egress.filter.allWorkloads') }}</option>
              <option v-for="w in workloads" :key="w" :value="w">{{ w }}</option>
            </select>
          </template>
          <template v-else>
            <select
              class="select"
              :aria-label="$t('egress.filter.host')"
              :value="sourceQuery.host ?? ''"
              data-testid="filter-host"
              @change="onSelect('host', $event)"
            >
              <option value="">{{ $t('egress.filter.allHosts') }}</option>
              <option v-for="h in hosts" :key="h" :value="h">{{ h }}</option>
            </select>
            <select
              class="select"
              :aria-label="$t('egress.filter.project')"
              :value="sourceQuery.project ?? ''"
              data-testid="filter-project"
              @change="onSelect('project', $event)"
            >
              <option value="">{{ $t('egress.filter.allProjects') }}</option>
              <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
            </select>
            <select
              class="select"
              :aria-label="$t('egress.filter.container')"
              :value="sourceQuery.container ?? ''"
              data-testid="filter-container"
              @change="onSelect('container', $event)"
            >
              <option value="">{{ $t('egress.filter.allContainers') }}</option>
              <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
            </select>
          </template>
          <SearchField
            v-model="filter.input.value"
            class="min-w-48 flex-1 md:ml-auto md:max-w-xs"
            :label="$t('egress.filter.search')"
            :placeholder="
              $t(
                docker
                  ? 'egress.filter.placeholder.docker'
                  : 'egress.filter.placeholder.kubernetes',
              )
            "
            @clear="filter.clearText"
          />
        </div>
        <p v-if="sourceQuery.service" class="text-13 text-text-muted" data-testid="egress-service">
          {{
            $t('egress.filter.service', {
              project: sourceQuery.project,
              service: sourceQuery.service,
            })
          }}
        </p>

        <EgressTable
          v-if="answer.rows.length"
          :rows="answer.rows"
          :cluster-id="cluster.id"
          :kind="docker ? 'docker' : 'kubernetes'"
          @changed="onRowChanged"
        />
        <EmptyState
          v-else-if="filtered"
          :icon="SearchX"
          :title="$t('egress.empty.noMatch.title')"
          :description="$t('egress.empty.noMatch.description')"
          data-testid="egress-no-match"
        >
          <template #action>
            <BaseButton variant="secondary" @click="clearFilters">{{
              $t('docker.filter.clear')
            }}</BaseButton>
          </template>
        </EmptyState>
        <EmptyState
          v-else
          :icon="Hourglass"
          :title="$t('egress.empty.none.title')"
          :description="$t(`egress.empty.none.${docker ? 'docker' : 'kubernetes'}`)"
          data-testid="egress-empty"
        />

        <ExpectationsList
          :cluster-id="cluster.id"
          :kind="docker ? 'docker' : 'kubernetes'"
          :version="expectationsVersion"
          @changed="page.load"
        />

        <p
          class="flex flex-wrap items-center gap-x-1.5 text-12 text-text-subtle"
          data-testid="egress-footer"
        >
          <span v-if="answer.truncated">{{
            $t('egress.truncated', { shown: answer.rows.length, total: answer.total })
          }}</span>
          <span v-else>{{
            $t('egress.showing', { n: answer.rows.length }, answer.rows.length)
          }}</span>
          <span>{{ $t('egress.forgotten') }}</span>
          <span>{{ $t('egress.shortLived') }}</span>
          <LoadingIndicator :active="page.refreshing.value" class="ml-1" />
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
}
.chip[aria-pressed='true'] {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}
.chip:focus-visible,
.select:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.select {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--text);
  font-size: 13px;
  padding: 5px 8px;
  max-width: 14rem;
}
/* Touch screens: 44 px targets. */
@media (max-width: 1023px) {
  .chip,
  .select {
    min-height: 44px;
    padding-inline: 14px;
  }
}
</style>
