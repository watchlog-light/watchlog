<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Hourglass, ScrollText, SearchX } from '@lucide/vue';
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
import { useLoader } from '@/composables/useLoader';
import { useNamespaceFilter, withQuery } from '@/composables/useNamespaceFilter';
import { groupEvents, ungrouped } from '@/lib/events';
import { clockTime, RANGE_SECONDS } from '@/lib/time';
import { useClustersStore } from '@/stores/clusters';
import { useUiStore } from '@/stores/ui';

// Kubernetes events (SPEC §4.6, ADR-111): events per
// hour with notable events marked (drag to zoom), facets with counts, and the list
// newest first with day separators, grouped by default, paged with "Load older".
// Warnings are the default (?type=all|Normal); facets are ?kinds=, ?ns= ("-" is
// cluster-wide), ?reasons=; a zoomed range is ?from=&to= (Unix seconds).
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
const str = (v: unknown) => (typeof v === 'string' && v ? v : '');
const csv = (v: unknown) => str(v).split(',').filter(Boolean);

const type = computed(() =>
  route.query.type === 'all' ? 'all' : route.query.type === 'Normal' ? 'Normal' : 'Warning',
);
const selected = computed<Record<Facet, string[]>>(() => ({
  // ?kind= is the single-kind link other pages use.
  kinds: [...new Set([...csv(route.query.kinds), ...csv(route.query.kind)])],
  // A fleet's top bar filters by host and Compose project (?host=&project=).
  ns: [...new Set([...csv(route.query.ns), ...csv(route.query.project)])],
  reasons: csv(route.query.reasons),
  hosts: [...new Set([...csv(route.query.hosts), ...csv(route.query.host)])],
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
  return { summary };
});
const summary = computed(() => page.data.value?.summary ?? null);

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
            class="min-w-48"
            :label="$t('kube.events.search.label')"
            :placeholder="$t('kube.events.search.placeholder')"
            @clear="filter.clearText"
          />
          <LoadingIndicator :active="page.refreshing.value" />
          <span class="flex-1" />
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
              class="text-12 text-primary hover:underline"
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
          <EventFacets
            :facets="summary?.facets ?? null"
            :selected="selected"
            :docker="kube.cluster.kind === 'docker'"
            @change="setFacet"
          />
          <div class="flex min-w-0 flex-col gap-3">
            <EventFeed
              v-if="items.length"
              :items="items"
              :nodes="kube.cluster.nodeCount || undefined"
            />
            <EmptyState
              v-else-if="filtered"
              :icon="SearchX"
              :title="$t('kube.eventsPage.noMatch.title')"
              :description="$t('kube.events.noMatch')"
              data-testid="no-events"
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
              :title="$t('kube.eventsPage.empty.title')"
              :description="$t('kube.eventsPage.empty.description')"
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
              <p v-if="moreError" class="text-13 text-critical" role="alert">
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
.text-critical {
  color: var(--critical);
}
</style>
