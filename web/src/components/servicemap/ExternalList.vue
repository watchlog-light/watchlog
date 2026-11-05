<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Globe } from '@lucide/vue';
import type { ServiceMapEdge, ServiceMapNode } from '@watchlog/api-types';
import { computed } from 'vue';
import TonePill from '@/components/kube/TonePill.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { HEALTH_TONE, latency, perSecond } from '@/lib/servicemap';
import { isExternal, throughput } from '@/lib/servicemap-model';
import { formatValue } from '@/lib/units';

// The External view: each external service (named by DNS where the workload looked it
// up, else its /24 network, ADR-104) with its traffic and who calls it.
const props = defineProps<{
  nodes: ServiceMapNode[];
  edges: ServiceMapEdge[];
  name: (id: string) => string;
}>();
const emit = defineEmits<{ open: [id: string] }>();
const RANK: Record<string, number> = { critical: 0, warning: 1, ok: 2, idle: 3, unknown: 4 };

const cards = computed(() =>
  props.nodes
    .filter(isExternal)
    .map((n) => {
      const list = props.edges.filter((e) => e.target === n.id);
      const health =
        list.map((e) => e.health).sort((a, b) => (RANK[a] ?? 5) - (RANK[b] ?? 5))[0] ?? 'idle';
      const p95 = Math.max(...list.map((e) => e.latencyP95Seconds ?? 0));
      return {
        node: n,
        health,
        rate: list.reduce((s, e) => s + e.connectionsPerSecond, 0),
        bytes: list.reduce((s, e) => s + throughput(e), 0),
        p95: p95 > 0 ? p95 : null,
        from: [...new Set(list.map((e) => props.name(e.source)))],
      };
    })
    .sort((a, b) => (RANK[a.health] ?? 5) - (RANK[b.health] ?? 5) || b.rate - a.rate),
);
</script>

<template>
  <section data-testid="external-view">
    <EmptyState
      v-if="!cards.length"
      :icon="Globe"
      :title="$t('serviceMap.external.emptyTitle')"
      :description="$t('serviceMap.external.empty')"
    />
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
      <button
        v-for="c in cards"
        :key="c.node.id"
        type="button"
        class="flex flex-col gap-1.5 rounded-card border border-border bg-surface-1 p-3 text-left hover:border-border-strong focus-visible:outline-2 focus-visible:outline-primary"
        data-testid="external-card"
        @click="emit('open', c.node.id)"
      >
        <span class="flex items-start justify-between gap-2">
          <span class="font-mono text-13 break-all text-text">{{ c.node.name }}</span>
          <TonePill
            :tone="HEALTH_TONE[c.health] ?? 'neutral'"
            :label="$t(`serviceMap.health.${c.health}`)"
          />
        </span>
        <span class="text-12 text-text-muted">
          {{ c.rate > 0 ? perSecond(c.rate) : formatValue(c.bytes, 'bytes_per_second')
          }}<template v-if="c.p95"> · p95 {{ latency(c.p95) }}</template>
        </span>
        <span class="text-12 text-text-subtle">{{
          $t('serviceMap.from', { list: c.from.join(', ') })
        }}</span>
      </button>
    </div>
  </section>
</template>
