<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "Its own metrics" on a workload's or a server's page (1.0.0, ADR-236): the metrics pinned
// there, at most 6, each with its value now and its last hour. Nothing is shown for a
// workload or server that reports no metric of its own.
import type { OwnOwner, OwnPin } from '@watchlog/api-types';
import { X } from '@lucide/vue';
import { computed, watch } from 'vue';
import { ownMetricsApi } from '@/api/own-metrics';
import SparkLine from '@/components/overview/SparkLine.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { outside, ownerText, usualText, written } from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ clusterId: string; owner: OwnOwner }>();
const auth = useAuthStore();

const page = useLoader(() => ownMetricsApi.pins(props.clusterId, props.owner));
watch(
  () => [props.clusterId, props.owner.kind, props.owner.namespace, props.owner.name],
  () => void page.load(),
  { immediate: true },
);
const poll = usePolling(() => page.load(), 30_000);
poll.start();

const data = computed(() => page.data.value);
const name = computed(() => props.owner.name);
const all = computed(() => ({
  name: 'your-metrics',
  query: { cluster: props.clusterId, tab: 'metrics', q: ownerText(props.owner) ?? undefined },
}));
const metricLink = (p: OwnPin) => ({
  name: 'your-metrics',
  query: { cluster: props.clusterId, tab: 'metrics', metric: p.metric.id },
});
async function unpin(p: OwnPin) {
  await ownMetricsApi.unpin(props.clusterId, p.id).catch(() => undefined);
  await page.load();
}
</script>

<template>
  <section
    v-if="data && (data.pins.length > 0 || data.metrics > 0)"
    class="rounded-card border border-border bg-surface-1 px-5 py-4"
    data-testid="own-pins"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div>
        <h3 class="text-16 font-semibold text-text">{{ $t('ownMetrics.pins.title') }}</h3>
        <p class="mt-0.5 text-13 text-text-muted">
          <template v-if="data.pins.length">{{
            $t('ownMetrics.pins.about', { max: data.max })
          }}</template>
          <template v-else>{{
            $t('ownMetrics.pins.offer', { name, n: data.metrics, max: data.max }, data.metrics)
          }}</template>
        </p>
      </div>
      <RouterLink
        :to="all"
        class="text-13 text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
        data-testid="own-pins-all"
      >
        {{ $t('ownMetrics.pins.all', { n: data.metrics, name }, data.metrics) }} →
      </RouterLink>
    </div>
    <ul v-if="data.pins.length" class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <li
        v-for="p in data.pins"
        :key="p.id"
        class="relative rounded-card border border-border bg-surface-2 px-4 py-3"
        data-testid="own-pin-tile"
      >
        <RouterLink :to="metricLink(p)" class="block after:absolute after:inset-0">
          <span class="block truncate pr-6 text-13 text-text-muted">{{ p.metric.words }}</span>
          <span class="mt-1 block text-24 leading-tight font-semibold tabular-nums text-text">
            {{ written(p.metric.value, p.metric).value }}
            <span class="text-13 font-normal text-text-muted">{{
              written(p.metric.value, p.metric).ago
                ? $t('ownMetrics.ago')
                : written(p.metric.value, p.metric).unit
            }}</span>
          </span>
          <span
            v-if="usualText(p.metric.usual, p.metric)"
            :class="[
              'mt-0.5 block text-12',
              outside(p.metric.value, p.metric.usual)
                ? 'font-semibold text-warning-text'
                : 'text-text-muted',
            ]"
            data-testid="own-pin-usual"
          >
            {{
              $t(
                outside(p.metric.value, p.metric.usual)
                  ? 'ownMetrics.watch.outside'
                  : 'ownMetrics.watch.usual',
                { range: usualText(p.metric.usual, p.metric) },
              )
            }}
          </span>
          <SparkLine :values="p.spark.map((x) => x[1] ?? null)" color-token="--chart-1" />
          <span class="mt-1 block truncate font-mono text-12 text-text-subtle">{{
            p.metric.name
          }}</span>
        </RouterLink>
        <button
          v-if="auth.canManage"
          type="button"
          class="absolute top-1.5 right-1.5 z-10 inline-flex size-7 items-center justify-center rounded-control text-text-subtle hover:bg-surface-3 hover:text-text max-lg:size-11"
          :aria-label="$t('ownMetrics.pins.unpin', { name: p.metric.words })"
          data-testid="own-pin-remove"
          @click="unpin(p)"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </li>
    </ul>
  </section>
</template>
