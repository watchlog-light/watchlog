<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import HeatLegend from '@/components/kube/HeatLegend.vue';
import PodHeatmap, { type HeatPod } from '@/components/kube/PodHeatmap.vue';
import type { Overview } from '@/lib/overview';
import OverviewCard from './OverviewCard.vue';

// Pods by node (Docker: containers by host): one row per node with its pods coloured
// by CPU against the request, failing pods marked. Beyond 20 nodes the rows scroll.
const SCROLL_AFTER = 20;
const props = defineProps<{ overview: Overview }>();
const docker = computed(() => props.overview.kind === 'docker');
const rows = computed(() => {
  const by = new Map<string, HeatPod[]>();
  for (const p of props.overview.pods) {
    const k = p.node ?? '';
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  // A large cluster draws a share of each node's pods; the count is the node's own.
  const out = props.overview.nodes.map((n) => {
    const pods = by.get(n.name) ?? [];
    return { name: n.name, pods, count: Math.max(n.pods, pods.length) };
  });
  // Pods not placed yet, and pods on nodes the list does not have.
  for (const [k, pods] of by)
    if (!props.overview.nodes.some((n) => n.name === k))
      out.push({ name: k, pods, count: pods.length });
  return out;
});
const total = computed(() => rows.value.reduce((s, r) => s + r.count, 0));
const nodeLink = (name: string) =>
  docker.value
    ? { name: 'docker-host', params: { host: name } }
    : { name: 'node', params: { name } };
const podLink = (p: HeatPod & { node?: string | null }) =>
  docker.value
    ? { name: 'docker-container', params: { host: p.node ?? '', name: p.name } }
    : { name: 'pod', params: { namespace: p.namespace ?? '', name: p.name } };
</script>

<template>
  <OverviewCard
    :title="$t(docker ? 'overview.heat.titleDocker' : 'overview.heat.title')"
    testid="card-pods-by-node"
  >
    <template #meta>
      <span class="text-12 text-text-subtle">{{
        $t(docker ? 'overview.heat.hintDocker' : 'overview.heat.hint')
      }}</span>
    </template>
    <template #actions>
      <RouterLink
        :to="{ name: docker ? 'containers' : 'workloads', query: docker ? {} : { view: 'pods' } }"
        class="text-12 text-text-muted hover:text-text max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
        >{{
          $t(docker ? 'overview.nodes.containers' : 'overview.nodes.pods', { n: total }, total)
        }}</RouterLink
      >
    </template>
    <div
      class="flex flex-col px-3.5 pt-2.5 pb-1"
      :class="rows.length > SCROLL_AFTER && 'max-h-[560px] overflow-y-auto'"
      data-testid="heat-rows"
    >
      <div v-for="r in rows" :key="r.name" class="rowheat" data-testid="heat-row">
        <RouterLink
          v-if="r.name"
          :to="nodeLink(r.name)"
          class="block truncate text-12 text-text hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center"
          :title="r.name"
          >{{ r.name }}</RouterLink
        >
        <span v-else class="block truncate text-12 text-text-muted">{{
          $t('overview.heat.unscheduled')
        }}</span>
        <span class="flex min-w-0 items-center gap-1.5">
          <PodHeatmap :pods="r.pods" :link="podLink" :docker="docker" class="min-w-0 flex-1" />
          <RouterLink
            v-if="r.count > r.pods.length && r.name"
            :to="nodeLink(r.name)"
            class="shrink-0 font-mono text-12 text-text-subtle hover:text-text max-lg:flex max-lg:min-h-11 max-lg:min-w-11 max-lg:items-center max-lg:justify-center"
            data-testid="heat-more"
            >+{{ r.count - r.pods.length }}</RouterLink
          >
        </span>
        <span class="text-right font-mono text-12 text-text-subtle tabular-nums">{{
          $t(docker ? 'overview.nodes.containers' : 'overview.nodes.pods', { n: r.count }, r.count)
        }}</span>
      </div>
      <p v-if="!rows.length" class="py-6 text-13 text-text-muted">
        {{ $t('overview.heat.empty') }}
      </p>
    </div>
    <div class="mt-auto px-3.5 pt-2 pb-3.5"><HeatLegend :docker="docker" /></div>
  </OverviewCard>
</template>

<style scoped>
.rowheat {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) 60px;
  gap: 10px;
  align-items: center;
  padding: 6px 0;
}
@container (max-width: 480px) {
  .rowheat {
    grid-template-columns: 100px minmax(0, 1fr) 52px;
  }
}
</style>
