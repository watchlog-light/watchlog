<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { EyeOff, Hourglass, ScrollText, SearchX } from '@lucide/vue';
import type { KubeEvent, KubeEventPage, KubeEventSummary } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import EventFacets, { type Facet } from '@/components/kube/EventFacets.vue';
import EventFeed from '@/components/kube/EventFeed.vue';
import EventHistogram from '@/components/kube/EventHistogram.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useListFilter } from '@/composables/useListFilter';
import { useNarrow } from '@/composables/useNarrow';
import { useLoader } from '@/composables/useLoader';
import { useNamespaceFilter, withQuery } from '@/composables/useNamespaceFilter';
import { agentBefore, groupEvents, ungrouped } from '@/lib/events';
import { clockTime, RANGE_SECONDS } from '@/lib/time';
import { useClustersStore } from '@/stores/clusters';
import { useDockerScopeStore } from '@/stores/dockerScope';
import { useUiStore } from '@/stores/ui';

// Kubernetes events (SPEC §4.6, ADR-111): events per
// hour with notable events marked (drag to zoom), facets with counts, and the list
// newest first with day separators, grouped by default, paged with "Load older".
// Warnings are the default (?type=all|Normal); facets are ?kinds=, ?ns= ("-" is
// cluster-wide), ?reasons=; a zoomed range is ?from=&to= (Unix seconds).
// Server fleets (0.9.2, ADR-207/208 amended): their services', process groups' and
// containers' events, with Server and Workload facets (?hosts=, ?workloads=; the top bar's
// ?host= and ?workload= add to them) and "Hide system" on by default (?system=show).
// Grouping folds many events into few rows, so grouped pages are larger.
const PAGE = 100;
const GROUPED_PAGE = 300;
const pageSize = () => (route.query.group !== '0' ? GROUPED_PAGE : PAGE);
const route = useRoute();
const router = useRouter();
// Kubernetes clusters and Docker fleets alike (Docker events have hosts and projects).
const clusters = useClustersStore();
const kube = computed(() => ({ cluster: clusters.selected }));
const ui = useUiStore();
const ns = useNamespaceFilter();
const filter = useListFilter();
const scope = useDockerScopeStore();
const isServer = computed(() => clusters.selected?.kind === 'server');
const showSystem = computed(() => route.query.system === 'show');
// Services' and process groups' events come from the 0.9.2 agent; an older one sends only
// its containers' events.
const oldAgent = computed(
  () => isServer.value && agentBefore(clusters.selected?.agentVersion, '0.9.2'),
);
const str = (v: unknown) => (typeof v === 'string' && v ? v : '');
const csv = (v: unknown) => str(v).split(',').filter(Boolean);

const type = computed(() =>
  route.query.type === 'all' ? 'all' : route.query.type === 'Normal' ? 'Normal' : 'Warning',
);
// Phones: the facets fold into one "Filters" row above the feed, closed at first.
const narrow = useNarrow();
const facetsOpen = ref(!narrow.value);
watch(narrow, (n) => (facetsOpen.value = !n));
const selectedCount = computed(() =>
  Object.values(selected.value).reduce((n, v) => n + v.length, 0),
);
const selected = computed<Record<Facet, string[]>>(() => ({
  // ?kind= is the single-kind link other pages use.
  kinds: [...new Set([...csv(route.query.kinds), ...csv(route.query.kind)])],
  // A fleet's top bar filters by host and Compose project (?host=&project=).
  ns: [...new Set([...csv(route.query.ns), ...csv(route.query.project)])],
  reasons: csv(route.query.reasons),
  hosts: [...new Set([...csv(route.query.hosts), ...csv(route.query.host)])],
  workloads: [...new Set([...csv(route.query.workloads), ...csv(route.query.workload)])],
}));
const name = computed(() => str(route.query.name));
const grouped = computed(() => route.query.group !== '0');
const zoom = computed(() => {
  const from = Number(route.query.from);
  const to = Number(route.query.to);
  return from > 0 && to > from ? { from, to } : null;
});

function window() {
  if (zoom.value) return zoom.value;
  const to = Math.floor(Date.now() / 1000);
  return { from: to - RANGE_SECONDS[ui.timeRange], to };
}
function params(w: { from: number; to: number }) {
  const q = new URLSearchParams();
  if (type.value !== 'all') q.set('types', type.value);
  if (selected.value.kinds.length) q.set('kinds', selected.value.kinds.join(','));
  if (selected.value.ns.length) q.set('ns', selected.value.ns.join(','));
  if (selected.value.reasons.length) q.set('reasons', selected.value.reasons.join(','));
  if (selected.value.hosts.length) q.set('hosts', selected.value.hosts.join(','));
  if (selected.value.workloads.length) q.set('workloads', selected.value.workloads.join(','));
  if (isServer.value && !showSystem.value) q.set('system', 'hide');
  if (name.value) q.set('name', name.value);
  if (filter.query.value.trim()) q.set('q', filter.query.value.trim());
  q.set('from', String(w.from));
  q.set('to', String(w.to));
  return q;
}

const events = ref<KubeEvent[]>([]);
const cursor = ref<string | null>(null);
const more = ref(false);
const moreError = ref(false);
let lastWindow = window();

const page = useLoader(async () => {
  const cluster = await clusters.ensure();
  if (!cluster) return null;
  lastWindow = window();
  const q = params(lastWindow);
  const list = new URLSearchParams(q);
  list.set('limit', String(pageSize()));
  const [summary, res] = await Promise.all([
    api<KubeEventSummary>(withQuery(`/clusters/${cluster.id}/events/summary?${q}`, ns.query.value)),
    api<KubeEventPage>(withQuery(`/clusters/${cluster.id}/events?${list}`, ns.query.value)),
  ]);
  events.value = res.events;
  cursor.value = res.nextCursor;
  if (cluster.kind === 'server') {
    scope.workloads = (summary.facets.workloads ?? []).map((w) => w.value);
    scope.hosts = [...new Set([...scope.hosts, ...summary.facets.hosts.map((h) => h.value)])];
  }
  return { summary };
});
const summary = computed(() => page.data.value?.summary ?? null);
// Services' or process groups' events in this range: some server's agent is 0.9.2 already.
const hostEvents = computed(() =>
  (summary.value?.facets.kinds ?? []).some((k) => k.value === 'Service' || k.value === 'Process'),
);

async function loadMore() {
  if (!kube.value.cluster || !cursor.value) return;
  more.value = true;
  moreError.value = false;
  try {
    const q = params(lastWindow);
    q.set('limit', String(pageSize()));
    q.set('cursor', cursor.value);
    const res = await api<KubeEventPage>(
      withQuery(`/clusters/${kube.value.cluster.id}/events?${q}`, ns.query.value),
    );
    events.value = [...events.value, ...res.events];
    cursor.value = res.nextCursor;
  } catch {
    moreError.value = true;
  } finally {
    more.value = false;
  }
}

const items = computed(() => (grouped.value ? groupEvents(events.value) : ungrouped(events.value)));
const filtered = computed(
  () =>
    type.value !== 'all' ||
    !!name.value ||
    !!filter.query.value.trim() ||
    Object.values(selected.value).some((v) => v.length > 0) ||
    ns.selected.value.length > 0,
);

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}
function setFacet(f: Facet, values: string[]) {
  setQuery({
    [f]: values.length ? values.join(',') : undefined,
    ...(f === 'kinds' ? { kind: undefined } : {}),
  });
}
function clearFilters() {
  filter.clearText();
  setQuery({
    type: 'all',
    kinds: undefined,
    kind: undefined,
    ns: undefined,
    reasons: undefined,
    hosts: undefined,
    workloads: undefined,
    name: undefined,
  });
}
const time = (ts: number) => clockTime(new Date(ts * 1000).toISOString()).slice(0, 5);

watch(
  () => [
    type.value,
    selected.value,
    name.value,
    zoom.value,
    filter.query.value,
    ns.query.value,
    ui.timeRange,
    showSystem.value,
  ],
  () => void page.load(),
  { deep: true },
);
onMounted(page.load);
</script>

<template>
  <div class="events flex flex-col gap-3.5">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-3" data-testid="events-skeleton">
      <Skeleton shape="rect" class="h-9 w-full sm:max-w-xl" />
      <Skeleton shape="rect" class="h-36 w-full rounded-[12px]" />
      <div class="evwrap">
        <Skeleton shape="rect" class="h-72 w-full rounded-[12px]" />
        <Skeleton shape="rect" class="h-72 w-full rounded-[12px]" />
      </div>
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!kube.cluster"
        :icon="ScrollText"
        :title="$t('kube.eventsPage.noCluster.title')"
        :description="$t('kube.eventsPage.noCluster.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />
      <template v-else>
        <div class="flex flex-wrap items-center gap-2.5">
          <SegmentedControl
            :model-value="type"
            :label="$t('kube.eventsPage.type')"
            :options="[
              { value: 'Warning', label: $t('kube.events.types.warnings') },
              { value: 'all', label: $t('kube.events.types.all') },
              { value: 'Normal', label: $t('kube.events.types.normal') },
            ]"
            data-testid="event-type"
            @update:model-value="(v: string) => setQuery({ type: v === 'Warning' ? undefined : v })"
          />
          <SearchField
            v-model="filter.input.value"
            class="min-w-48 max-md:basis-full"
            :label="$t('kube.events.search.label')"
            :placeholder="$t('kube.events.search.placeholder')"
            @clear="filter.clearText"
          />
          <LoadingIndicator :active="page.refreshing.value" />
          <span class="flex-1" />
          <ToggleSwitch
            v-if="isServer"
            :model-value="!showSystem"
            data-testid="hide-system"
            @update:model-value="(v: boolean) => setQuery({ system: v ? undefined : 'show' })"
            >{{ $t('servers.fleetWorkloads.hideSystem') }}</ToggleSwitch
          >
          <ToggleSwitch
            :model-value="grouped"
            data-testid="group-toggle"
            @update:model-value="(v: boolean) => setQuery({ group: v ? undefined : '0' })"
            >{{ $t('kube.events.groupRepeated') }}</ToggleSwitch
          >
        </div>

        <section v-if="summary" class="card" data-testid="event-chart">
          <header class="ch">
            <h2 class="text-14 font-semibold">
              {{
                zoom
                  ? $t('kube.events.zoomed', { from: time(zoom.from), to: time(zoom.to) })
                  : $t(`kube.events.last.${ui.timeRange}`)
              }}
            </h2>
            <span class="text-12 text-text-subtle">{{ $t('kube.events.dragHint') }}</span>
            <button
              v-if="zoom"
              type="button"
              class="text-12 text-link hover:underline"
              data-testid="reset-zoom"
              @click="setQuery({ from: undefined, to: undefined })"
            >
              {{ $t('kube.events.resetZoom') }}
            </button>
            <span class="ml-auto flex items-center gap-3 text-12 text-text-subtle">
              <span class="tabular-nums">{{
                $t('kube.events.total', { n: summary.total }, summary.total)
              }}</span>
              <span><i class="key w" />{{ $t('kube.events.types.Warning') }}</span>
              <span><i class="key n" />{{ $t('kube.events.types.Normal') }}</span>
            </span>
          </header>
          <div class="px-3 py-2.5">
            <EventHistogram
              :summary="summary"
              :show-warning="type !== 'Normal'"
              :show-normal="type !== 'Warning'"
              @zoom="(from, to) => setQuery({ from: String(from), to: String(to) })"
            />
          </div>
        </section>

        <div class="evwrap">
          <details
            class="fold"
            :open="facetsOpen"
            @toggle="facetsOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary data-testid="facets-toggle">
              {{ $t('kube.events.facets.toggle', { n: selectedCount }, selectedCount) }}
            </summary>
            <EventFacets
              :facets="summary?.facets ?? null"
              :selected="selected"
              :docker="kube.cluster.kind === 'server'"
              @change="setFacet"
            />
          </details>
          <div class="flex min-w-0 flex-col gap-3">
            <p v-if="oldAgent && !hostEvents" class="note" data-testid="events-old-agent">
              {{ $t('kube.eventsPage.server.oldAgent', { v: kube.cluster.agentVersion }) }}
            </p>
            <EventFeed
              v-if="items.length"
              :items="items"
              :nodes="kube.cluster.nodeCount || undefined"
            />
            <EmptyState
              v-else-if="filtered"
              :icon="SearchX"
              :title="$t('kube.eventsPage.noMatch.title')"
              :description="
                isServer && !showSystem
                  ? `${$t('kube.events.noMatch')} ${$t('kube.eventsPage.server.hidden.note')}`
                  : $t('kube.events.noMatch')
              "
              data-testid="no-events"
            >
              <template #action>
                <BaseButton variant="secondary" @click="clearFilters">{{
                  $t('docker.filter.clear')
                }}</BaseButton>
                <BaseButton
                  v-if="isServer && !showSystem"
                  variant="ghost"
                  data-testid="show-system"
                  @click="setQuery({ system: 'show' })"
                  >{{ $t('kube.eventsPage.server.hidden.show') }}</BaseButton
                >
              </template>
            </EmptyState>
            <EmptyState
              v-else-if="isServer && !showSystem"
              :icon="EyeOff"
              :title="$t('kube.eventsPage.server.hidden.title')"
              :description="$t('kube.eventsPage.server.hidden.description')"
              data-testid="no-events-system-hidden"
            >
              <template #action>
                <BaseButton variant="secondary" @click="setQuery({ system: 'show' })">{{
                  $t('kube.eventsPage.server.hidden.show')
                }}</BaseButton>
              </template>
            </EmptyState>
            <EmptyState
              v-else
              :icon="Hourglass"
              :title="$t('kube.eventsPage.empty.title')"
              :description="
                isServer
                  ? $t('kube.eventsPage.server.empty')
                  : $t('kube.eventsPage.empty.description')
              "
              data-testid="no-events-yet"
            />
            <div v-if="events.length" class="flex flex-wrap items-center gap-3">
              <BaseButton
                v-if="cursor"
                variant="secondary"
                :loading="more"
                data-testid="load-more"
                @click="loadMore"
              >
                {{ $t('kube.eventsPage.loadMore') }}
              </BaseButton>
              <p v-else class="text-13 text-text-muted" data-testid="events-end">
                {{ $t('kube.eventsPage.end', { n: events.length }, events.length) }}
              </p>
              <p v-if="moreError" class="text-13 text-critical-text" role="alert">
                {{ $t('kube.eventsPage.moreError') }}
              </p>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.events {
  container-type: inline-size;
}
.card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
}
.ch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.key {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 2px;
  vertical-align: -1px;
}
.key.w {
  background: var(--warning);
}
.key.n {
  background: var(--border-strong);
}
.evwrap {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@container (max-width: 900px) {
  .evwrap {
    grid-template-columns: minmax(0, 1fr);
  }
}
.fold > summary {
  display: none;
}
@media (max-width: 767px) {
  .fold {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-1);
  }
  .fold > summary {
    display: flex;
    min-height: 44px;
    align-items: center;
    padding: 0 14px;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
  }
  .fold[open] > summary {
    border-bottom: 1px solid var(--border);
  }
  .fold > :not(summary) {
    border: 0;
  }
}
.note {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 13px;
}
.text-critical-text {
  color: var(--critical-text);
}
</style>
