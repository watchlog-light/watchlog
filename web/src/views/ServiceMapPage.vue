<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Filter, Network } from '@lucide/vue';
import type { Cluster, ServiceMap } from '@watchlog/api-types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import { useClustersStore } from '@/stores/clusters';
import ConnectionsTable from '@/components/servicemap/ConnectionsTable.vue';
import DnsList from '@/components/servicemap/DnsList.vue';
import EbpfStatus from '@/components/servicemap/EbpfStatus.vue';
import ExternalList from '@/components/servicemap/ExternalList.vue';
import MapFilters from '@/components/servicemap/MapFilters.vue';
import MapPanel from '@/components/servicemap/MapPanel.vue';
import MapSearch from '@/components/servicemap/MapSearch.vue';
import ServiceMapCanvas, {
  type DrawEdge,
  type DrawGroup,
  type DrawNode,
  type Selection,
} from '@/components/servicemap/ServiceMapCanvas.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { useNamespaceFilter } from '@/composables/useNamespaceFilter';
import { latency } from '@/lib/servicemap';
import { layoutStore, placeNodes, type Layout, type Pos } from '@/lib/servicemap-layout';
import {
  DEFAULT_FILTERS,
  DNS_PROBLEM,
  databases,
  edgeMatches,
  groupOf,
  isExternal,
  isInfrastructure,
  isProblem,
  liveliness,
  namespaceCounts,
  scopedEdges,
  search,
  summary,
  visibleEdges,
  visibleNodes,
  type Filters,
} from '@/lib/servicemap-model';
import { RANGE_SECONDS } from '@/lib/time';
import { formatValue } from '@/lib/units';
import { useUiStore } from '@/stores/ui';

// The service map (SPEC §4.5, ADR-109): filters on the
// left, the live graph in the middle, details on the right, and the same data as
// Connections, External and DNS views. Data refreshes every 15 s without moving
// anything: positions are computed once per topology and kept per cluster (ADR-109).
const clusters = useClustersStore();
const REFRESH_MS = 15_000;
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const nsFilter = useNamespaceFilter();
const { t } = useI18n();

// ── Data ────────────────────────────────────────────────────────────────────────
const page = useLoader(async () => {
  // The selected cluster or fleet (the switcher's; it never changes by itself).
  const cluster: Cluster | null = await clusters.ensure();
  if (!cluster) return null;
  // Every namespace is fetched: the filters work on the page, so counts stay complete.
  const range = Math.max(300, RANGE_SECONDS[ui.timeRange]);
  const map = await api<ServiceMap>(`/clusters/${cluster.id}/service-map?range=${range}`);
  return { cluster, map, at: Date.now() };
});
const map = computed(() => page.data.value?.map);
const nodes = computed(() => new Map((map.value?.nodes ?? []).map((n) => [n.id, n])));
const name = (id: string) => nodes.value.get(id)?.name ?? id;
const nsOf = (id: string) => nodes.value.get(id)?.namespace ?? null;

// ── Filters (namespaces in the URL; the toggles remembered in this browser) ─────
const PREFS = 'watchlog.serviceMap.filters.v1';
function loadPrefs(): Partial<Filters> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(PREFS) ?? '{}') as Partial<Filters>;
  } catch {
    return {};
  }
}
const toggles = ref({ ...DEFAULT_FILTERS, ...loadPrefs(), namespaces: [] as string[] });
const filters = computed<Filters>({
  get: () => ({ ...toggles.value, namespaces: nsFilter.selected.value }),
  set: (f) => {
    toggles.value = { ...f, namespaces: [] };
    nsFilter.set(f.namespaces);
    try {
      globalThis.localStorage?.setItem(PREFS, JSON.stringify({ ...f, namespaces: undefined }));
    } catch {
      // per-browser convenience only
    }
  },
});

const scoped = computed(() => (map.value ? scopedEdges(map.value, filters.value) : []));
const shown = computed(() => (map.value ? visibleEdges(map.value, filters.value) : []));
const shownNodes = computed(() => (map.value ? visibleNodes(map.value, shown.value) : []));
const db = computed(() => (map.value ? databases(map.value) : new Set<string>()));
const nsColor = computed(() => {
  const names = [
    ...new Set((map.value?.nodes ?? []).map((n) => n.namespace).filter((x): x is string => !!x)),
  ].sort();
  // Not the yellow, orange or pink chart colours: those would read as warning or failing.
  const palette = [1, 2, 4, 5, 8];
  return new Map(names.map((n, i) => [n, `var(--chart-${palette[i % palette.length]})`]));
});
const namespaces = computed(() =>
  namespaceCounts(map.value ?? { nodes: [] }, filters.value).map((n) => ({
    ...n,
    color: nsColor.value.get(n.name) ?? 'var(--text-subtle)',
  })),
);

// ── Views, selection and search (in the URL so they can be shared) ──────────────
type View = 'map' | 'connections' | 'external' | 'dns';
const VIEWS: View[] = ['map', 'connections', 'external', 'dns'];
const view = computed<View>(() =>
  VIEWS.includes(route.query.view as View) ? (route.query.view as View) : 'map',
);
const selection = computed<Selection>(() =>
  typeof route.query.edge === 'string'
    ? { type: 'edge', id: route.query.edge }
    : typeof route.query.node === 'string'
      ? { type: 'node', id: route.query.node }
      : null,
);
function go(next: { view?: View; sel?: Selection }) {
  const q: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(route.query)) if (typeof v === 'string') q[k] = v;
  if (next.view) q.view = next.view === 'map' ? undefined : next.view;
  if (next.sel !== undefined) {
    q.edge = next.sel?.type === 'edge' ? next.sel.id : undefined;
    q.node = next.sel?.type === 'node' ? next.sel.id : undefined;
  }
  void router.replace({ query: q });
}
const query = ref('');
const results = computed(() =>
  map.value && query.value.trim() ? search(map.value, query.value) : [],
);

const counts = computed(() => ({
  connections: scoped.value.filter(isProblem).length,
  external: new Set(
    scoped.value
      .filter((e) => isProblem(e) && isExternal(nodes.value.get(e.target)!))
      .map((e) => e.target),
  ).size,
  dns: (map.value?.dns ?? []).filter((d) => d.errorRatio >= DNS_PROBLEM).length,
}));

// ── Stable layout ────────────────────────────────────────────────────────────────
// Nodes are placed when they are first shown and keep their position from then on:
// refreshes and filters never move a placed node, and hidden nodes leave no gaps.
const positions = shallowRef<Layout>({});
let store: ReturnType<typeof layoutStore> | null = null;
function place() {
  if (!store) return;
  const placed = placeNodes(
    positions.value,
    shownNodes.value.map((n) => ({ id: n.id, group: groupOf(n).key })),
    shown.value,
  );
  if (!placed.added.length) return;
  positions.value = placed.layout;
  store.save(placed.layout, new Set((map.value?.nodes ?? []).map((n) => n.id)));
}
watch([() => page.data.value?.cluster.id, shownNodes], ([clusterId]) => {
  if (!clusterId) return;
  if (!store) {
    store = layoutStore(clusterId);
    positions.value = store.load();
  }
  place();
});
function onMove(id: string, p: Pos, done: boolean) {
  positions.value = { ...positions.value, [id]: p };
  if (done) store?.save(positions.value);
}
const canvas = ref<InstanceType<typeof ServiceMapCanvas>>();
function resetLayout() {
  store?.clear();
  positions.value = {};
  place();
  void nextTick(() => canvas.value?.fit());
}

// ── What the graph draws ─────────────────────────────────────────────────────────
const RANK: Record<string, number> = { critical: 0, warning: 1, ok: 2, unknown: 3, idle: 4 };
const drawNodes = computed<DrawNode[]>(() => {
  const worst = new Map<string, string>();
  for (const e of shown.value)
    for (const id of [e.source, e.target]) {
      const cur = worst.get(id);
      if (!cur || (RANK[e.health] ?? 9) < (RANK[cur] ?? 9)) worst.set(id, e.health);
    }
  return shownNodes.value.map((n) => ({
    id: n.id,
    title: n.namespace ? `${n.name} · ${n.namespace}` : n.name,
    label: n.name,
    health: (worst.get(n.id) ?? 'idle') as DrawNode['health'],
    group: groupOf(n).key,
    shape: isExternal(n)
      ? 'external'
      : n.kind === 'node'
        ? 'node'
        : db.value.has(n.id)
          ? 'database'
          : 'service',
  }));
});
const pct = (v: number | null) => formatValue(v, 'ratio');
const drawEdges = computed<DrawEdge[]>(() =>
  shown.value.map((e) => {
    const live = liveliness(e);
    const failed = (e.failedRatio ?? 0) >= 0.01;
    const badge =
      e.health === 'critical'
        ? `✕ ${t('serviceMap.edge.failed', { pct: pct(e.failedRatio) })}`
        : e.health === 'warning'
          ? failed
            ? `▲ ${t('serviceMap.edge.failed', { pct: pct(e.failedRatio) })}`
            : `▲ ${t('serviceMap.edge.slow', { p95: latency(e.latencyP95Seconds) })}`
          : null;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      health: e.health as DrawEdge['health'],
      label: `${name(e.source)} → ${name(e.target)}${e.port ? `:${e.port}` : ''}, ${t(`serviceMap.health.${e.health}`)}`,
      ...live,
      badge,
    };
  }),
);
const drawGroups = computed<DrawGroup[]>(() => {
  const seen = new Map<string, DrawGroup>();
  for (const n of shownNodes.value) {
    const g = groupOf(n);
    if (seen.has(g.key)) continue;
    seen.set(g.key, {
      key: g.key,
      label:
        g.kind === 'external'
          ? t('serviceMap.groupLabel.external')
          : g.kind === 'nodes'
            ? t('serviceMap.groupLabel.nodes')
            : g.label,
      color:
        g.kind === 'external'
          ? 'var(--warning)'
          : g.kind === 'nodes'
            ? 'var(--text-subtle)'
            : (nsColor.value.get(g.label) ?? 'var(--text-subtle)'),
    });
  }
  return [...seen.values()];
});

const tableEdges = computed(() =>
  shown.value.filter((e) => edgeMatches(e, nodes.value, query.value)),
);
const totals = computed(() => summary(shown.value, nodes.value));
const scope = computed(
  () =>
    `${filters.value.namespaces.length ? filters.value.namespaces.join(', ') : t('serviceMap.panel.allNamespaces')} · ${t('serviceMap.panel.window')}`,
);

// ── Actions ──────────────────────────────────────────────────────────────────────
async function focusNode(id: string) {
  const n = nodes.value.get(id);
  if (!n) return;
  // Make sure the filters show it.
  const f = { ...filters.value };
  if (f.namespaces.length && n.namespace && !f.namespaces.includes(n.namespace))
    f.namespaces = [...f.namespaces, n.namespace];
  if (isInfrastructure(n)) f.watchlog = true;
  if (isExternal(n)) f.externals = true;
  const visible = (ff: Filters) =>
    map.value && visibleNodes(map.value, visibleEdges(map.value, ff)).some((x) => x.id === id);
  if (!visible(f)) {
    f.onlyProblems = false;
    f.hideIdle = false;
  }
  filters.value = f;
  go({ view: 'map', sel: { type: 'node', id } });
  await nextTick();
  canvas.value?.focusNode(id);
}
async function openEdge(id: string) {
  go({ view: 'map', sel: { type: 'edge', id } });
  await nextTick();
  canvas.value?.focusEdge(id);
}

// ── Live: refresh every 15 s, "updated Ns ago" ───────────────────────────────────
const now = ref(Date.now());
const ago = computed(() => {
  const at = page.data.value?.at;
  if (!at) return null;
  return Math.max(0, Math.round((now.value - at) / 1000));
});
let refresh: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
watch(
  () => ui.timeRange,
  () => void page.load(),
);
watch(
  () => clusters.selectedId,
  (id, old) => {
    if (old && id !== old) void page.load();
  },
);
onMounted(() => {
  void page.load();
  refresh = setInterval(() => void page.load(), REFRESH_MS);
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  clearInterval(refresh);
  clearInterval(clock);
});
</script>

<template>
  <div class="flex flex-col gap-3.5">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-20 font-semibold text-text">{{ $t('serviceMap.title') }}</h2>
      <span
        v-if="map"
        class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 py-0.5 text-12 text-text-muted"
        role="status"
        data-testid="live"
      >
        <i v-if="map.mode === 'flows'" class="live-dot" aria-hidden="true" />
        {{
          map.mode === 'topology'
            ? $t('serviceMap.live.topology')
            : ago === null || ago < 2
              ? $t('serviceMap.live.now')
              : $t('serviceMap.live.ago', { s: ago })
        }}
      </span>
      <span class="flex-1" />
      <MapSearch v-model="query" :results="results" @pick="focusNode" />
      <div
        class="inline-flex flex-wrap gap-0.5 rounded-control border border-border bg-surface-1 p-0.5"
        role="group"
        :aria-label="$t('serviceMap.views.label')"
      >
        <button
          v-for="v in VIEWS"
          :key="v"
          type="button"
          class="rounded-[6px] px-3 py-1 text-13"
          :class="view === v ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
          :aria-pressed="view === v"
          :data-testid="`view-${v}`"
          @click="go({ view: v })"
        >
          {{ $t(`serviceMap.views.${v}`) }}
          <span v-if="v !== 'map' && counts[v]" class="ml-1 text-12 text-critical">
            {{ counts[v] }}<span class="sr-only"> {{ $t('serviceMap.views.problems') }}</span>
          </span>
        </button>
      </div>
    </div>

    <EbpfStatus
      v-if="map"
      :agents="map.agents"
      :mode="map.mode"
      :docker="page.data.value?.cluster.kind === 'docker'"
    />
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('serviceMap.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />

    <div v-if="page.skeleton.value" class="work" role="status" :aria-label="$t('common.loading')">
      <Skeleton class="h-[420px] rounded-card" />
      <Skeleton class="h-[640px] rounded-card" />
      <Skeleton class="h-[420px] rounded-card" />
    </div>
    <EmptyState
      v-else-if="page.loaded.value && !page.data.value"
      :icon="Network"
      :title="$t('empty.serviceMap.title')"
      :description="$t('empty.serviceMap.description')"
      :action-label="$t('empty.connectCluster')"
      action-to="/settings"
    />

    <div v-else-if="map && page.data.value" class="work">
      <MapFilters
        v-model="filters"
        :namespaces="namespaces"
        :docker="page.data.value?.cluster.kind === 'docker'"
      />

      <div class="min-w-0">
        <section
          v-show="view === 'map'"
          class="relative h-[640px] overflow-hidden rounded-card border border-border bg-surface-1"
          data-testid="view-map-panel"
        >
          <ServiceMapCanvas
            v-if="drawNodes.length"
            ref="canvas"
            :nodes="drawNodes"
            :edges="drawEdges"
            :groups="drawGroups"
            :positions="positions"
            :selected="selection"
            @select="(s) => go({ sel: s })"
            @move="onMove"
            @reset-layout="resetLayout"
          >
            <template #footer>
              <p
                class="pointer-events-none absolute bottom-2.5 left-2.5 font-mono text-11 text-text-subtle"
              >
                {{ $t('serviceMap.footer', { nodes: drawNodes.length, edges: drawEdges.length }) }}
              </p>
            </template>
          </ServiceMapCanvas>
          <div v-else class="flex h-full items-center justify-center p-6">
            <EmptyState
              v-if="map.edges.length"
              :icon="Filter"
              :title="$t('serviceMap.empty.filtered.title')"
              :description="$t('serviceMap.empty.filtered.description')"
            >
              <template #action>
                <BaseButton
                  variant="secondary"
                  data-testid="reset-filters"
                  @click="filters = { ...DEFAULT_FILTERS }"
                >
                  {{ $t('serviceMap.empty.filtered.reset') }}
                </BaseButton>
              </template>
            </EmptyState>
            <EmptyState
              v-else
              :icon="Network"
              :title="$t(`serviceMap.empty.${map.mode}.title`)"
              :description="$t(`serviceMap.empty.${map.mode}.description`)"
            />
          </div>
        </section>
        <ConnectionsTable
          v-if="view === 'connections'"
          :edges="tableEdges"
          :name="name"
          :ns="nsOf"
          @open="openEdge"
        />
        <ExternalList
          v-else-if="view === 'external'"
          :nodes="map.nodes"
          :edges="scoped"
          :name="name"
          @open="focusNode"
        />
        <DnsList v-else-if="view === 'dns'" :rows="map.dns" />
      </div>

      <MapPanel
        :cluster-id="page.data.value.cluster.id"
        :selection="selection"
        :nodes="nodes"
        :edges="scoped"
        :summary="totals"
        :scope="scope"
        @select="(s) => go({ sel: s })"
      />
    </div>
  </div>
</template>

<style scoped>
.work {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr) 340px;
  gap: 12px;
  align-items: start;
}
@media (max-width: 1280px) {
  .work {
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .work > :last-child {
    grid-column: 1 / -1;
  }
}
@media (max-width: 760px) {
  .work {
    grid-template-columns: minmax(0, 1fr);
  }
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--ok) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 0%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }
}
</style>
