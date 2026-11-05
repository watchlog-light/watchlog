<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { KubeNodeList } from '@watchlog/api-types';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { capacity, diskTone, fullestDisk, type Capacity, type NodeModel } from '@/lib/nodes';
import { formatCores } from '@/lib/resources';
import { formatBytes } from '@/lib/units';

// The cluster's capacity (ADR-111): CPU and memory used
// against requested and allocatable, pods against their slots, and the fullest disk
// mount, linked to its alert while one fires.
// Docker hosts have no requests: no request tick, and running containers of all.
const props = defineProps<{ nodes: NodeModel[]; diskAlerts: KubeNodeList['diskAlerts'] }>();
const hosts = computed(() => props.nodes[0]?.kind === 'host');
const c = computed(() => capacity(props.nodes));
const disk = computed(() => fullestDisk(props.nodes, props.diskAlerts));
const pct = (v: number | null, of: number) =>
  v === null || of <= 0 ? null : Math.min(1, Math.max(0, v / of));
const show = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const width = (v: number | null) => `${(v ?? 0) * 100}%`;
const tiles = computed(() =>
  (['cpu', 'memory'] as const).map((k) => {
    const x: Capacity = c.value[k];
    const fmt = (v: number) => (k === 'cpu' ? formatCores(v) : formatBytes(v));
    return {
      key: k,
      x,
      fmt,
      used: pct(x.used, x.allocatable),
      requested: pct(x.requested, x.allocatable),
      free: x.used === null ? null : Math.max(0, x.allocatable - x.used),
    };
  }),
);
const podShare = computed(() => pct(c.value.pods.count, c.value.pods.capacity));
</script>

<template>
  <div class="tiles" data-testid="node-tiles">
    <section v-for="tl in tiles" :key="tl.key" class="tile" :data-testid="`tile-${tl.key}`">
      <span class="k">{{
        $t(`kube.nodes.tiles.${tl.key}`, {
          v: tl.key === 'cpu' ? formatCores(tl.x.allocatable) : formatBytes(tl.x.allocatable),
        })
      }}</span>
      <span class="v"
        >{{ tl.x.used === null ? '–' : tl.fmt(tl.x.used)
        }}<small>{{
          $t(tl.x.used === null ? 'kube.nodes.noDataYet' : 'kube.nodes.tiles.used')
        }}</small></span
      >
      <span
        class="track"
        role="img"
        :aria-label="
          $t('kube.nodes.tiles.aria', { used: show(tl.used), requested: show(tl.requested) })
        "
      >
        <span
          class="u"
          :class="tl.key === 'cpu' ? 'bg-info' : 'bg-violet'"
          :style="{ width: width(tl.used) }"
        />
        <span v-if="!hosts" class="rq" :style="{ left: width(tl.requested) }" />
      </span>
      <span class="tl">
        <span>{{ $t('kube.nodes.tiles.usedPct', { v: show(tl.used) }) }}</span>
        <span v-if="!hosts">{{
          $t('kube.nodes.tiles.requestedPct', { v: show(tl.requested) })
        }}</span>
        <span>{{
          $t('kube.nodes.tiles.free', { v: tl.free === null ? '–' : tl.fmt(tl.free) })
        }}</span>
      </span>
    </section>

    <section class="tile" data-testid="tile-pods">
      <span class="k">{{
        $t(hosts ? 'docker.hosts.tiles.containers' : 'kube.nodes.tiles.pods')
      }}</span>
      <span class="v"
        >{{ c.pods.count
        }}<small>{{
          $t(hosts ? 'docker.hosts.tiles.of' : 'kube.nodes.tiles.capacity', { n: c.pods.capacity })
        }}</small></span
      >
      <span class="track"><span class="u bg-ok" :style="{ width: width(podShare) }" /></span>
      <span class="tl"
        ><span>{{
          $t(hosts ? 'docker.hosts.tiles.running' : 'kube.nodes.tiles.slots', {
            v: show(podShare),
          })
        }}</span></span
      >
    </section>

    <section class="tile" data-testid="tile-disk">
      <span class="k">{{ $t('kube.nodes.tiles.disk') }}</span>
      <template v-if="disk">
        <span class="v" :class="`t-${diskTone(disk.utilization)}`">{{
          show(disk.utilization)
        }}</span>
        <span class="track"
          ><span
            class="u"
            :class="`bg-${diskTone(disk.utilization)}`"
            :style="{ width: width(disk.utilization) }"
        /></span>
        <span class="tl">
          <span class="truncate" :title="disk.nodes.join(', ')">{{
            disk.nodes.length === nodes.length && nodes.length > 1
              ? $t('kube.nodes.tiles.onAll', { mount: disk.mount, n: disk.nodes.length })
              : disk.nodes.length > 1
                ? $t('kube.nodes.tiles.onSome', { mount: disk.mount, n: disk.nodes.length })
                : $t('kube.nodes.tiles.onOne', { mount: disk.mount, node: disk.nodes[0] })
          }}</span>
          <RouterLink
            v-if="disk.alertId"
            :to="{ name: 'alert', params: { id: disk.alertId } }"
            class="t-warning hover:underline"
            data-testid="disk-alert"
            >▲ {{ $t('kube.nodes.tiles.alert') }}</RouterLink
          >
        </span>
      </template>
      <template v-else>
        <span class="v">–</span>
        <span class="tl"
          ><span>{{ $t('kube.nodes.tiles.noDisk') }}</span></span
        >
      </template>
    </section>
  </div>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
@container (max-width: 1000px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 480px) {
  .tiles {
    grid-template-columns: minmax(0, 1fr);
  }
}
.tile {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-1);
}
.k {
  color: var(--text-muted);
  font-size: 12px;
}
.v {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.v small {
  margin-left: 4px;
  color: var(--text-subtle);
  font-size: 13px;
}
.track {
  position: relative;
  display: block;
  height: 8px;
  border-radius: 4px;
  background: var(--surface-3);
}
.u {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
}
.rq {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: var(--text-muted);
}
.tl {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}
.bg-info {
  background: var(--info);
}
.bg-violet {
  background: var(--chart-4);
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
.t-warning {
  color: var(--warning);
}
.t-critical {
  color: var(--critical);
}
</style>
