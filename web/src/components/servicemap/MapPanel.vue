<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight, X } from '@lucide/vue';
import type { ServiceMapEdge, ServiceMapEdgeSeries, ServiceMapNode } from '@watchlog/api-types';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { api } from '@/api/client';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import TonePill from '@/components/kube/TonePill.vue';
import { useLoader } from '@/composables/useLoader';
import { formatDateTime } from '@/lib/format';
import { HEALTH_TONE, edgeReason, latency, perSecond } from '@/lib/servicemap';
import { isExternal, throughput, type Summary } from '@/lib/servicemap-model';
import { RANGE_SECONDS } from '@/lib/time';
import { formatValue } from '@/lib/units';
import { useUiStore } from '@/stores/ui';
import type { Selection } from './ServiceMapCanvas.vue';

// The right column of the service map: with nothing selected, the traffic summary and
// what needs attention; a node, who calls it and whom it calls; an edge, its health in
// words, the related alert, its numbers and its series.
const props = defineProps<{
  clusterId: string;
  selection: Selection;
  nodes: Map<string, ServiceMapNode>;
  /** Edges in scope (filters for namespaces, WatchLog and externals applied). */
  edges: ServiceMapEdge[];
  summary: Summary;
  scope: string;
}>();
const emit = defineEmits<{ select: [sel: Selection] }>();
const { t } = useI18n();
const ui = useUiStore();

const node = computed(() =>
  props.selection?.type === 'node' ? (props.nodes.get(props.selection.id) ?? null) : null,
);
const edge = computed(() =>
  props.selection?.type === 'edge'
    ? (props.edges.find((e) => e.id === props.selection!.id) ?? null)
    : null,
);
const name = (id: string) => props.nodes.get(id)?.name ?? id;
const SYMBOL: Record<string, string> = {
  critical: '✕',
  warning: '▲',
  ok: '✓',
  idle: '○',
  unknown: '○',
};

const incoming = computed(() =>
  node.value ? props.edges.filter((e) => e.target === node.value!.id) : [],
);
const outgoing = computed(() =>
  node.value ? props.edges.filter((e) => e.source === node.value!.id) : [],
);
const sum = (list: ServiceMapEdge[]) => list.reduce((s, e) => s + e.connectionsPerSecond, 0);
const nodeHealth = computed(() => {
  const all = [...incoming.value, ...outgoing.value];
  if (all.some((e) => e.health === 'critical')) return 'critical';
  if (all.some((e) => e.health === 'warning')) return 'warning';
  return all.some((e) => e.health === 'ok') ? 'ok' : 'idle';
});
const workloadLink = computed(() => {
  const n = node.value;
  if (!n || n.kind !== 'workload') return null;
  return {
    name: 'workloads',
    query: { view: 'pods', wkind: n.workloadKind, wname: n.name, wns: n.namespace },
  };
});

function rowText(e: ServiceMapEdge): string {
  if (e.health === 'critical' || e.health === 'warning')
    return (e.failedRatio ?? 0) >= 0.01
      ? t('serviceMap.edge.failed', { pct: formatValue(e.failedRatio, 'ratio') })
      : t('serviceMap.edge.slow', { p95: latency(e.latencyP95Seconds) });
  if (e.health === 'idle' || e.health === 'unknown') return t(`serviceMap.health.${e.health}`);
  return e.connectionsPerSecond > 0
    ? perSecond(e.connectionsPerSecond)
    : formatValue(throughput(e), 'bytes_per_second');
}

// The selected edge's series and context.
const series = useLoader(async () => {
  const e = edge.value;
  if (!e) return null;
  const q = new URLSearchParams({
    source: e.source,
    target: e.target,
    range: String(Math.max(300, RANGE_SECONDS[ui.timeRange])),
  });
  if (e.port !== null) q.set('port', String(e.port));
  return api<ServiceMapEdgeSeries>(`/clusters/${props.clusterId}/service-map/edge?${q.toString()}`);
});
// Reload on a different edge or range, not on every 15 s refresh of the same edge.
watch(
  () => [edge.value?.id, ui.timeRange],
  () => void series.load(),
  { immediate: true },
);
const pts = (k: 'connections' | 'failed' | 'latencyP95') =>
  (series.data.value?.[k] ?? []) as (number | null)[][];
const traffic = computed(() => [
  { name: t('serviceMap.charts.connections'), points: pts('connections'), colorToken: '--ok' },
  { name: t('serviceMap.charts.failed'), points: pts('failed'), colorToken: '--critical' },
]);
const slow = computed(() => [{ name: 'p95', points: pts('latencyP95'), colorToken: '--info' }]);
const time = (iso: string) => formatDateTime(iso);
const reason = computed(() =>
  edge.value
    ? edgeReason(edge.value, name(edge.value.target), series.data.value?.context ?? null, t, time)
    : null,
);
const alert = computed(() => series.data.value?.context.alert ?? null);
</script>

<template>
  <aside
    class="flex min-h-[200px] flex-col gap-3.5 rounded-card border border-border bg-surface-1 p-3.5"
    aria-live="polite"
    data-testid="map-panel"
  >
    <!-- Nothing selected: the traffic now. -->
    <template v-if="!node && !edge">
      <div>
        <h2 class="text-15 font-semibold text-text">{{ $t('serviceMap.panel.now') }}</h2>
        <p class="text-12 text-text-muted">{{ scope }}</p>
      </div>
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.connections') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ perSecond(summary.connectionsPerSecond) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.failed') }}</dt>
          <dd
            class="font-mono text-16 tabular-nums"
            :class="(summary.failedRatio ?? 0) >= 0.01 ? 'text-critical' : 'text-text'"
          >
            {{ formatValue(summary.failedRatio, 'ratio') }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.active') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ summary.active }}</dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.externals') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ summary.externals }}</dd>
        </div>
      </dl>
      <section data-testid="panel-attention">
        <h3 class="mb-1 text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.panel.attention', { n: summary.attention.length }) }}
        </h3>
        <p v-if="!summary.attention.length" class="px-1.5 text-13 text-text-muted">
          {{ $t('serviceMap.panel.allHealthy') }}
        </p>
        <button
          v-for="e in summary.attention.slice(0, 8)"
          :key="e.id"
          type="button"
          class="lrow"
          @click="emit('select', { type: 'edge', id: e.id })"
        >
          <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
          <span class="truncate text-13 text-text"
            >{{ name(e.source) }} → {{ name(e.target) }}</span
          >
          <span class="font-mono text-12 whitespace-nowrap text-text-muted"
            >{{ SYMBOL[e.health] }} {{ rowText(e) }}</span
          >
        </button>
      </section>
      <section>
        <h3 class="mb-1 text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t('serviceMap.panel.busiest') }}
        </h3>
        <button
          v-for="e in summary.busiest"
          :key="e.id"
          type="button"
          class="lrow"
          @click="emit('select', { type: 'edge', id: e.id })"
        >
          <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
          <span class="truncate text-13 text-text"
            >{{ name(e.source) }} → {{ name(e.target) }}</span
          >
          <span class="font-mono text-12 whitespace-nowrap text-text-muted">{{ rowText(e) }}</span>
        </button>
      </section>
    </template>

    <!-- A node: who calls it and whom it calls. -->
    <template v-else-if="node">
      <header class="flex items-start gap-2">
        <div class="min-w-0">
          <h2 class="text-15 font-semibold break-words text-text">{{ node.name }}</h2>
          <p class="text-12 text-text-muted">
            {{
              isExternal(node)
                ? $t('serviceMap.panel.externalService')
                : [node.workloadKind, node.namespace].filter(Boolean).join(' · ')
            }}
          </p>
        </div>
        <button
          type="button"
          class="close"
          :aria-label="$t('common.close')"
          @click="emit('select', null)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>
      <div>
        <TonePill
          :tone="HEALTH_TONE[nodeHealth] ?? 'neutral'"
          :label="$t(`serviceMap.health.${nodeHealth}`)"
        />
      </div>
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.incoming') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ perSecond(sum(incoming)) }}</dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.outgoing') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">{{ perSecond(sum(outgoing)) }}</dd>
        </div>
      </dl>
      <section
        v-for="[key, list, dir] in [
          ['calledBy', incoming, 'in'],
          ['calls', outgoing, 'out'],
        ] as const"
        :key="key"
        :data-testid="`panel-${key}`"
      >
        <h3 class="mb-1 text-11 font-medium tracking-wide text-text-subtle uppercase">
          {{ $t(`serviceMap.panel.${key}`, { n: list.length }) }}
        </h3>
        <p v-if="!list.length" class="px-1.5 text-13 text-text-muted">
          {{ $t(`serviceMap.panel.${key}None`) }}
        </p>
        <button
          v-for="e in list"
          :key="e.id"
          type="button"
          class="lrow"
          @click="emit('select', { type: 'edge', id: e.id })"
        >
          <span class="dot" :class="`bg-${e.health}`" aria-hidden="true" />
          <span class="truncate text-13 text-text"
            >{{ name(dir === 'in' ? e.source : e.target)
            }}<span v-if="e.port" class="text-text-subtle">:{{ e.port }}</span></span
          >
          <span class="font-mono text-12 whitespace-nowrap text-text-muted"
            >{{ SYMBOL[e.health] }} {{ rowText(e) }}</span
          >
        </button>
      </section>
      <RouterLink v-if="workloadLink" :to="workloadLink" class="link">
        {{
          $t('serviceMap.panel.openWorkload', {
            kind: node.workloadKind,
            name: `${node.namespace}/${node.name}`,
          })
        }}
        <ArrowRight class="size-3.5" aria-hidden="true" />
      </RouterLink>
    </template>

    <!-- An edge: health in words, the alert, numbers and series. -->
    <template v-else-if="edge">
      <header class="flex items-start gap-2">
        <div class="min-w-0">
          <h2 class="text-15 font-semibold break-words text-text">
            {{ name(edge.source) }} → {{ name(edge.target)
            }}<span v-if="edge.port" class="text-text-subtle">:{{ edge.port }}</span>
          </h2>
          <p class="text-12 text-text-muted">
            {{
              [
                nodes.get(edge.source)?.namespace,
                nodes.get(edge.target)?.namespace ?? $t('serviceMap.panel.external'),
              ]
                .filter(Boolean)
                .join(' → ')
            }}
            <template v-if="edge.service">
              · {{ $t('serviceMap.edge.via', { service: edge.service }) }}</template
            >
          </p>
        </div>
        <button
          type="button"
          class="close"
          :aria-label="$t('common.close')"
          @click="emit('select', null)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </header>
      <div>
        <TonePill
          :tone="HEALTH_TONE[edge.health] ?? 'neutral'"
          :label="$t(`serviceMap.health.${edge.health}`)"
        />
      </div>
      <div
        v-if="reason"
        class="why"
        :class="edge.health === 'critical' ? 'border-critical' : 'border-warning'"
        data-testid="edge-reason"
      >
        <p class="font-semibold text-text">{{ reason.lead }}</p>
        <p v-if="reason.detail">{{ reason.detail }}</p>
        <RouterLink
          v-if="alert"
          :to="`/alerts/${alert.id}`"
          class="link mt-1"
          data-testid="edge-alert"
        >
          {{ $t('serviceMap.reason.alert', { time: time(alert.since) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </RouterLink>
      </div>
      <dl class="grid grid-cols-2 gap-2">
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.connections') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ perSecond(edge.connectionsPerSecond) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.panel.failed') }}</dt>
          <dd
            class="font-mono text-16 tabular-nums"
            :class="(edge.failedRatio ?? 0) >= 0.01 ? 'text-critical' : 'text-text'"
          >
            {{ formatValue(edge.failedRatio, 'ratio') }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.columns.p95') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{ latency(edge.latencyP95Seconds) }}
          </dd>
        </div>
        <div class="rounded-control bg-surface-2 px-2.5 py-2">
          <dt class="text-12 text-text-muted">{{ $t('serviceMap.columns.bytes') }}</dt>
          <dd class="font-mono text-16 tabular-nums text-text">
            {{
              edge.bytesSentPerSecond === null
                ? '–'
                : formatValue(throughput(edge), 'bytes_per_second')
            }}
          </dd>
        </div>
      </dl>
      <TimeSeriesChart
        :title="$t('serviceMap.charts.traffic')"
        unit="per_second"
        :series="traffic"
        :loading="series.loading.value && !series.data.value"
        :error="!!series.error.value"
        :empty-text="$t('serviceMap.charts.empty')"
        :error-text="$t('serviceMap.charts.error')"
        @retry="series.load"
      />
      <TimeSeriesChart
        :title="$t('serviceMap.charts.latency')"
        unit="seconds"
        :series="slow"
        :loading="series.loading.value && !series.data.value"
        :error="!!series.error.value"
        :empty-text="$t('serviceMap.charts.empty')"
        :error-text="$t('serviceMap.charts.error')"
        @retry="series.load"
      />
      <div class="flex flex-wrap gap-3">
        <button
          type="button"
          class="link"
          @click="emit('select', { type: 'node', id: edge.source })"
        >
          {{ $t('serviceMap.panel.open', { name: name(edge.source) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="link"
          @click="emit('select', { type: 'node', id: edge.target })"
        >
          {{ $t('serviceMap.panel.open', { name: name(edge.target) }) }}
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.lrow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 6px;
  border-radius: 6px;
  text-align: left;
}
.lrow:hover {
  background: var(--surface-2);
}
.lrow:focus-visible,
.link:focus-visible,
.close:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.bg-ok {
  background: var(--ok);
}
.bg-warning {
  background: var(--warning);
}
.bg-critical {
  background: var(--critical);
}
.bg-idle,
.bg-unknown {
  background: var(--text-subtle);
}
.why {
  font-size: 13px;
  color: var(--text-muted);
  background: var(--surface-2);
  border-left-width: 2px;
  padding: 8px 10px;
  border-radius: 0 6px 6px 0;
}
.border-critical {
  border-left-color: var(--critical);
}
.border-warning {
  border-left-color: var(--warning);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--primary);
  font-size: 13px;
}
.close {
  margin-left: auto;
  color: var(--text-muted);
  border-radius: 6px;
  padding: 2px;
}
.close:hover {
  color: var(--text);
}
</style>
