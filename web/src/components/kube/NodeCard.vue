<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ShieldAlert } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import SparkLine from '@/components/overview/SparkLine.vue';
import HighlightText from '@/components/ui/HighlightText.vue';
import { share } from '@/lib/kube';
import { conditionChips, diskTone, type NodeModel } from '@/lib/nodes';
import { values } from '@/lib/overview';
import { formatDateTime } from '@/lib/format';
import { since } from '@/lib/time';
import { formatBytes } from '@/lib/units';
import PodHeatmap, { type HeatPod } from './PodHeatmap.vue';

// One node (ADR-111): name, Ready, role, version, OS,
// kernel and uptime; condition chips; CPU and memory with sparklines and request share;
// a bar per disk mount; its pods as a heatmap. Kubelet TLS is a small shield hint.
const props = withDefaults(defineProps<{ node: NodeModel; terms?: string[] }>(), {
  terms: () => [],
});
const { t } = useI18n();
const n = computed(() => props.node);
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const meta = computed(() =>
  [
    n.value.kind === 'node' && (n.value.roles.join(', ') || t('kube.nodes.worker')),
    n.value.kubeletVersion,
    n.value.osImage,
    n.value.kernelVersion && t('kube.nodes.kernel', { v: n.value.kernelVersion }),
    n.value.status === 'Ready' && up.value && t('kube.nodes.up', { d: since(up.value) }),
  ]
    .filter(Boolean)
    .join(' · '),
);
// Up since boot, else since the node last became Ready (agents before the boot time).
const up = computed(() =>
  n.value.bootTime ? new Date(n.value.bootTime * 1000).toISOString() : n.value.readySince,
);
const mets = computed(() => [
  {
    key: 'cpu',
    used: share(n.value.cpu.usageCores, n.value.cpu.allocatableCores),
    req: share(n.value.cpu.requestsCores, n.value.cpu.allocatableCores),
    series: values(n.value.cpuSeries),
    token: '--info',
  },
  {
    key: 'memory',
    used: share(n.value.memory.usageBytes, n.value.memory.allocatableBytes),
    req: share(n.value.memory.requestsBytes, n.value.memory.allocatableBytes),
    series: values(n.value.memorySeries),
    token: '--chart-4',
  },
]);
const podLink = (p: HeatPod) =>
  n.value.kind === 'host'
    ? { name: 'docker-container', params: { host: n.value.name, name: p.name } }
    : { name: 'pod', params: { namespace: p.namespace ?? '', name: p.name } };
</script>

<template>
  <article class="nc" data-testid="node-card">
    <div class="flex items-start gap-2">
      <div class="min-w-0">
        <h3 class="truncate text-14 font-semibold">
          <RouterLink :to="n.link" class="hover:underline">
            <HighlightText :text="n.name" :terms="terms" />
          </RouterLink>
        </h3>
        <p
          class="text-12 text-text-subtle"
          :title="
            n.readySince
              ? $t('kube.nodes.readySince', { t: formatDateTime(n.readySince) })
              : undefined
          "
        >
          {{ meta }}
        </p>
      </div>
      <span
        class="pill ml-auto"
        :class="n.status === 'Ready' ? (n.unschedulable ? 'warn' : 'ok') : 'crit'"
        data-testid="node-status"
        >{{ n.status === 'Ready' ? '✓' : '✕' }}
        {{
          n.unschedulable
            ? $t('kube.nodes.cordoned')
            : n.kind === 'host'
              ? $t(n.status === 'Ready' ? 'docker.hosts.reporting' : 'docker.hosts.silent')
              : $t(`kube.nodes.status.${n.status}`)
        }}</span
      >
    </div>

    <div class="flex flex-wrap gap-1.5">
      <span
        v-for="c in conditionChips(n)"
        :key="c.key"
        class="cond"
        :class="!c.ok && 'bad'"
        :title="c.title"
        >{{ c.ok ? '✓' : '✕' }} {{ $t(`kube.nodes.conditions.${c.key}`) }}</span
      >
      <span
        v-if="n.agent.kubeletTls === 'unverified'"
        class="cond shield"
        :title="$t('kube.kubeletTls.hint')"
        data-testid="tls-hint"
      >
        <ShieldAlert class="size-3" aria-hidden="true" /> {{ $t('kube.nodes.tlsShort') }}
      </span>
      <span v-if="n.agent.status !== 'active'" class="cond bad">{{
        $t(`kube.nodes.agent.${n.agent.status}`)
      }}</span>
    </div>

    <div class="grid grid-cols-2 gap-2.5">
      <div v-for="m in mets" :key="m.key" class="met" :data-testid="`met-${m.key}`">
        <div class="flex justify-between text-12 text-text-muted">
          <span>{{ $t(`kube.nodes.columns.${m.key}`) }}</span>
          <span>{{ $t('kube.nodes.req', { v: pct(m.req) }) }}</span>
        </div>
        <div class="font-mono text-16 tabular-nums">{{ pct(m.used) }}</div>
        <SparkLine :values="m.series" :color-token="m.token" />
      </div>
    </div>

    <div v-if="n.disks.length" class="flex flex-col gap-2">
      <div v-for="d in n.disks" :key="d.mount" class="disk" data-testid="node-disk">
        <div class="flex justify-between gap-2 font-mono text-12">
          <span class="truncate">{{ $t('kube.nodes.diskMount', { mount: d.mount }) }}</span>
          <span :class="`t-${diskTone(d.utilization)}`"
            >{{ diskTone(d.utilization) !== 'ok' ? '▲ ' : '' }}{{ pct(d.utilization)
            }}<template v-if="d.sizeBytes"> · {{ formatBytes(d.sizeBytes) }}</template></span
          >
        </div>
        <span class="track"
          ><span
            class="u"
            :class="`bg-${diskTone(d.utilization)}`"
            :style="{ width: `${d.utilization * 100}%` }"
        /></span>
      </div>
    </div>

    <div v-if="n.heat">
      <div class="mb-1.5 flex justify-between gap-2 font-mono text-12 text-text-subtle">
        <span>{{
          $t(n.kind === 'host' ? 'docker.hosts.containersOf' : 'kube.nodes.podsOf', {
            n: n.pods.count,
            cap: n.pods.capacity ?? '–',
          })
        }}</span>
        <span>{{ $t(n.kind === 'host' ? 'docker.hosts.heatHint' : 'kube.nodes.heatHint') }}</span>
      </div>
      <PodHeatmap :pods="n.heat" :link="podLink" :docker="n.kind === 'host'" />
    </div>
  </article>
</template>

<style scoped>
.nc {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
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
.pill.warn {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}
.pill.crit {
  color: var(--critical);
  background: color-mix(in srgb, var(--critical) 12%, transparent);
}
.cond {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: var(--text-12);
}
.cond.bad {
  color: var(--critical);
  background: color-mix(in srgb, var(--critical) 12%, transparent);
}
.cond.shield {
  color: var(--text-subtle);
}
.met {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-2);
}
.track {
  position: relative;
  display: block;
  height: 6px;
  margin-top: 4px;
  border-radius: 3px;
  background: var(--surface-3);
}
.u {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
}
.bg-ok {
  background: var(--info);
}
.bg-warning {
  background: var(--warning);
}
.bg-critical {
  background: var(--critical);
}
.t-warning {
  color: var(--warning);
}
.t-critical {
  color: var(--critical);
}
</style>
