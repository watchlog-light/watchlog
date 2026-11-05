<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Search } from '@lucide/vue';
import type { ServiceMap } from '@watchlog/api-types';
import { computed } from 'vue';
import TonePill from '@/components/kube/TonePill.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { perSecond } from '@/lib/servicemap';
import { DNS_PROBLEM, idLabel } from '@/lib/servicemap-model';
import { formatValue } from '@/lib/units';

// The DNS view: lookups per workload over the last 5 minutes, worst first, with the
// failed share as a bar and in words (NXDOMAIN, SERVFAIL and timeouts). Search-path
// misses (ADR-113) are not failures: a muted line of their own.
const props = defineProps<{ rows: ServiceMap['dns'] }>();
const sorted = computed(() =>
  [...props.rows].sort(
    (a, b) => b.errorRatio - a.errorRatio || b.requestsPerSecond - a.requestsPerSecond,
  ),
);
const parts = (id: string) => {
  const [name, ns] = idLabel(id).split(' · ');
  return { name: name ?? id, ns: ns ?? null };
};
const tone = (r: number) => (r >= 0.05 ? 'critical' : r >= DNS_PROBLEM ? 'warning' : 'ok');
</script>

<template>
  <section data-testid="dns-view">
    <EmptyState
      v-if="!sorted.length"
      :icon="Search"
      :title="$t('serviceMap.dns.emptyTitle')"
      :description="$t('serviceMap.dns.empty')"
    />
    <div v-else class="flex flex-col rounded-card border border-border bg-surface-1">
      <div
        v-for="d in sorted"
        :key="d.node"
        class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
        data-testid="dns-row"
      >
        <div class="min-w-0 truncate">
          <span class="font-semibold text-text">{{ parts(d.node).name }}</span>
          <span v-if="parts(d.node).ns" class="ml-1.5 text-12 text-text-subtle">{{
            parts(d.node).ns
          }}</span>
        </div>
        <div class="min-w-0">
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
            <i
              class="block h-full"
              :class="`bar-${tone(d.errorRatio)}`"
              :style="{ width: `${Math.max(d.errorRatio > 0 ? 1 : 0, d.errorRatio * 100)}%` }"
            />
          </div>
          <p class="mt-1 text-12 text-text-subtle">
            {{
              $t('serviceMap.dns.detail', {
                nx: perSecond(d.nxdomainPerSecond),
                servfail: perSecond(d.servfailPerSecond),
                timeout: perSecond(d.timeoutPerSecond),
                total: perSecond(d.requestsPerSecond),
              })
            }}
          </p>
          <p
            v-if="d.searchMissPerSecond > 0"
            class="text-12 italic text-text-subtle"
            :title="$t('serviceMap.dns.searchMissHint')"
            data-testid="dns-search-miss"
          >
            {{ $t('serviceMap.dns.searchMiss', { n: perSecond(d.searchMissPerSecond) }) }}
          </p>
        </div>
        <TonePill
          :tone="tone(d.errorRatio)"
          :label="
            d.errorRatio >= DNS_PROBLEM
              ? `✕ ${$t('serviceMap.dns.failed', { pct: formatValue(d.errorRatio, 'ratio') })}`
              : `✓ ${$t('serviceMap.health.ok')}`
          "
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.bar-critical {
  background: var(--critical);
}
.bar-warning {
  background: var(--warning);
}
.bar-ok {
  background: var(--ok);
}
</style>
