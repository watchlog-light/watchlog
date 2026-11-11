<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { latency, perSecond } from '@/lib/servicemap';
import { comparison, values, type Overview } from '@/lib/overview';
import { formatValue } from '@/lib/units';
import { useUiStore } from '@/stores/ui';
import SparkLine from './SparkLine.vue';

// The KPI row: nodes, pods (Docker: hosts, containers), restarts against the previous
// period, service traffic from the flows, CPU and memory as usage vs requests vs
// allocatable in one bar. Every figure has a trend or its context.
const props = defineProps<{ overview: Overview }>();
const { t } = useI18n();
const ui = useUiStore();
const k = computed(() => props.overview.kpis);
const docker = computed(() => props.overview.kind === 'docker');
const period = computed(() => ui.timeRange);

const restarts = computed(() => comparison(k.value.restarts.total, k.value.restarts.previous));
const restartsText = computed(() => {
  const c = restarts.value;
  if (c.direction === null) return t('overview.kpi.noPrevious');
  if (c.direction === 'flat') return t('overview.kpi.sameAsBefore', { period: period.value });
  const n = Math.round(c.change!);
  return t('overview.kpi.vsBefore', { change: `${n > 0 ? '+' : ''}${n}`, period: period.value });
});
const traffic = computed(() => k.value.traffic);

function bar(r: { usage: number | null; requests: number | null; allocatable: number | null }) {
  const alloc = r.allocatable ?? 0;
  const used = r.usage !== null && alloc > 0 ? r.usage / alloc : null;
  const req = r.requests !== null && alloc > 0 ? r.requests / alloc : null;
  return { used, req };
}
const cpu = computed(() => bar(k.value.cpu));
const mem = computed(() => bar(k.value.memory));
/** "1.41 / 12 cores", "7.3 / 17.3 GiB": one unit for both numbers. */
function usedOf(r: 'cpu' | 'memory') {
  const m = k.value[r];
  if (r === 'cpu')
    return `${m.usage === null ? '–' : m.usage.toFixed(2)} / ${m.allocatable === null ? '–' : +m.allocatable.toFixed(1)} ${t('overview.kpi.cores')}`;
  const used = formatValue(m.usage, 'bytes');
  const all = formatValue(m.allocatable, 'bytes');
  const unit = all.split(' ')[1];
  return used.endsWith(` ${unit}`) ? `${used.split(' ')[0]} / ${all}` : `${used} / ${all}`;
}
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
</script>

<template>
  <div class="kpis" data-testid="kpis">
    <!-- Nodes ready (Docker: hosts reporting) -->
    <div class="kpi" data-testid="kpi-nodes">
      <div class="k">{{ $t(docker ? 'overview.kpi.hosts' : 'overview.kpi.nodes') }}</div>
      <div class="v">
        {{ k.nodes.ready }}<small> / {{ k.nodes.total }}</small>
      </div>
      <div
        class="d"
        :class="k.nodes.ready === k.nodes.total && k.nodes.total > 0 ? 'text-ok' : 'text-critical'"
      >
        <template v-if="k.nodes.total === 0">{{ $t('overview.kpi.noNodes') }}</template>
        <template v-else-if="k.nodes.ready === k.nodes.total"
          >✓ {{ $t(docker ? 'overview.kpi.allReporting' : 'overview.kpi.allReady') }}</template
        >
        <template v-else
          >✕
          {{
            $t(docker ? 'overview.kpi.notReporting' : 'overview.kpi.notReady', {
              n: k.nodes.total - k.nodes.ready,
            })
          }}</template
        >
      </div>
      <SparkLine :values="values(k.nodes.series)" color-token="--ok" />
    </div>
    <!-- Pods (Docker: containers) -->
    <div class="kpi" data-testid="kpi-pods">
      <div class="k">{{ $t(docker ? 'overview.kpi.containers' : 'overview.kpi.pods') }}</div>
      <div class="v">
        {{ k.pods.running }}<small v-if="docker"> / {{ k.pods.total }}</small>
      </div>
      <div class="d" :class="k.pods.failed || k.pods.pending ? 'text-warning' : ''">
        {{
          docker
            ? $t('overview.kpi.stoppedUnhealthy', {
                stopped: k.pods.pending,
                unhealthy: k.pods.failed,
              })
            : $t('overview.kpi.pendingFailed', { pending: k.pods.pending, failed: k.pods.failed })
        }}
      </div>
      <SparkLine :values="values(k.pods.series)" color-token="--info" />
    </div>
    <!-- Restarts vs the previous period -->
    <div class="kpi" data-testid="kpi-restarts">
      <div class="k">
        {{ $t('overview.kpi.restarts') }} <span class="font-mono">{{ period }}</span>
      </div>
      <div class="v" :class="(k.restarts.total ?? 0) > 0 ? 'text-critical' : ''">
        {{ k.restarts.total === null ? '–' : Math.round(k.restarts.total) }}
      </div>
      <div
        class="d"
        :class="
          restarts.direction === 'up'
            ? 'text-critical'
            : restarts.direction === 'down'
              ? 'text-ok'
              : ''
        "
      >
        <span v-if="restarts.direction === 'up'" aria-hidden="true">▲ </span
        ><span v-else-if="restarts.direction === 'down'" aria-hidden="true">▼ </span
        >{{ restartsText }}
      </div>
      <SparkLine :values="values(k.restarts.series)" color-token="--critical" />
    </div>
    <!-- Service traffic from the flows -->
    <div class="kpi" data-testid="kpi-traffic">
      <div class="k">{{ $t('overview.kpi.traffic') }}</div>
      <template v-if="traffic">
        <div class="v">
          {{ perSecond(traffic.connectionsPerSecond).replace('/s', '')
          }}<small> {{ $t('overview.kpi.connPerSec') }}</small>
        </div>
        <!-- One line: the failed share and the latency. The traffic's change against the
             previous period read as the failures' ("▲ 390%"): the sparkline shows the trend. -->
        <div
          class="d whitespace-nowrap"
          data-testid="kpi-traffic-sub"
          :class="
            (traffic.failedRatio ?? 0) >= 0.05
              ? 'text-critical'
              : (traffic.failedRatio ?? 0) >= 0.01
                ? 'text-warning'
                : ''
          "
        >
          {{
            $t('overview.kpi.failedP95', {
              failed: formatValue(traffic.failedRatio ?? 0, 'ratio'),
              p95: latency(traffic.p95Seconds),
            })
          }}
        </div>
        <SparkLine :values="values(traffic.series)" color-token="--ok" />
      </template>
      <template v-else>
        <div class="v text-text-subtle">–</div>
        <div class="d">{{ $t('overview.kpi.noFlows') }}</div>
      </template>
    </div>
    <!-- CPU and memory: usage vs requests vs allocatable -->
    <div v-for="r in ['cpu', 'memory'] as const" :key="r" class="kpi" :data-testid="`kpi-${r}`">
      <div class="k">
        {{ $t(`overview.kpi.${r}`) }}
        <span class="font-mono whitespace-nowrap">{{ usedOf(r) }}</span>
      </div>
      <div class="v">{{ pct((r === 'cpu' ? cpu : mem).used) }}</div>
      <div
        class="tri"
        role="img"
        :aria-label="
          $t('overview.kpi.barLabel', {
            used: pct((r === 'cpu' ? cpu : mem).used),
            requested: pct((r === 'cpu' ? cpu : mem).req),
          })
        "
      >
        <div
          class="u"
          :class="r === 'cpu' ? 'bg-info' : 'bg-violet'"
          :style="{ width: `${Math.min(100, ((r === 'cpu' ? cpu : mem).used ?? 0) * 100)}%` }"
        />
        <div
          v-if="(r === 'cpu' ? cpu : mem).req !== null"
          class="q"
          :style="{ left: `${Math.min(100, (r === 'cpu' ? cpu : mem).req! * 100)}%` }"
        />
      </div>
      <div class="tri-l">
        <span>{{ $t('overview.kpi.used', { v: pct((r === 'cpu' ? cpu : mem).used) }) }}</span>
        <span v-if="(r === 'cpu' ? cpu : mem).req !== null">{{
          $t('overview.kpi.requested', { v: pct((r === 'cpu' ? cpu : mem).req) })
        }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
@container (max-width: 1000px) {
  .kpis {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@container (max-width: 480px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 12px 14px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-1);
}
.k {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.v {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 24px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  color: var(--text);
}
.v small {
  font-size: 14px;
  color: var(--text-subtle);
}
.d {
  font-size: 12px;
  color: var(--text-subtle);
}
.text-critical {
  color: var(--critical);
}
.text-warning {
  color: var(--warning);
}
.text-ok {
  color: var(--ok);
}
.tri {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--surface-3);
  margin-top: 10px;
}
.tri .u {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
}
.tri .q {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: var(--text);
}
.bg-info {
  background: var(--info);
}
.bg-violet {
  background: var(--chart-4);
}
.tri-l {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: var(--text-12);
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
}
</style>
