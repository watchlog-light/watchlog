<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Panel } from '@watchlog/api-types';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import { chartToken, SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';
import { formatWhen } from '@/lib/format';
import BarsPanel from './BarsPanel.vue';
import CauseCardPanel from './CauseCardPanel.vue';
import ChecksPanel from './ChecksPanel.vue';
import ClientsPanel from './ClientsPanel.vue';
import FactsPanel from './FactsPanel.vue';
import FlowPanel from './FlowPanel.vue';
import GaugePanel from './GaugePanel.vue';
import NodesPanel from './NodesPanel.vue';
import QueueAlertsPanel from './QueueAlertsPanel.vue';
import QueuesPanel from './QueuesPanel.vue';
import TimelinePanel from './TimelinePanel.vue';
import HeatPanel from './HeatPanel.vue';
import HistPanel from './HistPanel.vue';
import PanelCard from './PanelCard.vue';
import StatPanel from './StatPanel.vue';
import TablePanel from './TablePanel.vue';

// One panel of a service page, drawn by its kind (ADR-135). Lines and stacked areas use
// the dashboard's chart over the page's own window; the others draw in a PanelCard.
const props = defineProps<{
  panel: Panel;
  window: [number, number];
  loading?: boolean;
  error?: boolean;
}>();
defineEmits<{ retry: []; changed: [] }>();
const { t } = useI18n();

// What happened, on the chart (1.1.0): a consumer OOM-killed, the last consumer gone.
const markers = computed(() => {
  const p = props.panel;
  if (p.kind !== 'line' && p.kind !== 'stack') return [];
  return ((p as PanelOf<'line'>).markers ?? []).map((m) => {
    const v = { ...(m.text.values ?? {}) } as Record<string, unknown>;
    // Its time and what happened, always on the line (1.1.1): "18:15 shop/consumer OOMKilled".
    v.at = formatWhen(new Date(m.at * 1000).toISOString());
    return {
      ts: m.at,
      labelled: true,
      label: t(m.text.key, v),
      ...(m.severity && m.severity !== 'info' ? { colorToken: SEVERITY_TOKEN[m.severity] } : {}),
    };
  });
});
// The usual range of the first series, for this hour of the week (What changed).
const band = computed(() => {
  const p = props.panel;
  if (p.kind !== 'line' && p.kind !== 'stack') return undefined;
  const b = (p as PanelOf<'line'>).band;
  return b ? { label: t('integrations.panel.usualRange'), low: b.low, high: b.high } : undefined;
});

const series = computed<ChartSeries[]>(() => {
  const p = props.panel;
  if (p.kind !== 'line' && p.kind !== 'stack') return [];
  return (p as PanelOf<'line'>).series.map((s, i) => ({
    name: s.nameKey ? t(s.nameKey) : (s.name ?? ''),
    points: s.points,
    dashed: s.dashed,
    // A limit stays neutral; a status series wears its status; others go in order.
    colorToken: s.dashed
      ? '--text-subtle'
      : s.severity && s.severity !== 'info'
        ? SEVERITY_TOKEN[s.severity]
        : chartToken(i),
  }));
});
const isChart = computed(
  () =>
    (props.panel.kind === 'line' || props.panel.kind === 'stack') &&
    props.panel.state !== 'needs_permission',
);
</script>

<template>
  <TimeSeriesChart
    v-if="isChart"
    :title="$t(panel.title)"
    :note="panel.note ? $t(panel.note.key, panel.note.values ?? {}) : undefined"
    :unit="(panel as PanelOf<'line'>).unit"
    :series="series"
    :markers="markers"
    :band="band"
    :stacked="panel.kind === 'stack'"
    :window="window"
    :loading="loading"
    :error="error || panel.state === 'error'"
    :empty-text="$t('integrations.panel.empty')"
    :error-text="$t('integrations.panel.error')"
    :data-panel="panel.id"
    :data-kind="panel.kind"
    @retry="$emit('retry')"
  />
  <PanelCard v-else :panel="panel" :loading="loading" :error="error" @retry="$emit('retry')">
    <StatPanel v-if="panel.kind === 'stat'" :panel="panel" />
    <BarsPanel v-else-if="panel.kind === 'bars'" :panel="panel" />
    <HistPanel v-else-if="panel.kind === 'hist'" :panel="panel" />
    <GaugePanel v-else-if="panel.kind === 'gauge'" :panel="panel" />
    <HeatPanel v-else-if="panel.kind === 'heat'" :panel="panel" />
    <TablePanel v-else-if="panel.kind === 'table'" :panel="panel" />
    <FlowPanel v-else-if="panel.kind === 'flow'" :panel="panel" />
    <ChecksPanel v-else-if="panel.kind === 'checks'" :panel="panel" />
    <QueuesPanel v-else-if="panel.kind === 'queues'" :panel="panel" />
    <ClientsPanel v-else-if="panel.kind === 'clients'" :panel="panel" />
    <NodesPanel v-else-if="panel.kind === 'nodes'" :panel="panel" />
    <TimelinePanel v-else-if="panel.kind === 'timeline'" :panel="panel" />
    <FactsPanel v-else-if="panel.kind === 'facts'" :panel="panel" />
    <CauseCardPanel v-else-if="panel.kind === 'cause'" :panel="panel" />
    <QueueAlertsPanel
      v-else-if="panel.kind === 'queue_alerts'"
      :panel="panel"
      @changed="$emit('changed')"
    />
  </PanelCard>
</template>
