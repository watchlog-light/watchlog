<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Server } from '@lucide/vue';
import type { ServerList, ServerRow } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { api } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import SourceChip from '@/components/servers/SourceChip.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { shortOs } from '@/lib/servers';
import { useFleetStore } from '@/stores/fleet';

// A Server fleet's servers (ADR-207; the canvas "Main"): what needs attention first.
const REFRESH_MS = 30_000;
const fleetStore = useFleetStore();
const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  return api<ServerList>(`/clusters/${f.id}/servers`);
});
const servers = computed(() => page.data.value?.servers ?? []);
const totals = computed(() => page.data.value?.totals);
const addTo = computed(() =>
  fleetStore.fleet ? { name: 'cluster-settings', params: { id: fleetStore.fleet.id } } : undefined,
);

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`);
const width = (v: number | null | undefined) => `${Math.min(100, Math.max(0, (v ?? 0) * 100))}%`;
const barTone = (v: number | null | undefined) =>
  (v ?? 0) >= 0.9 ? 'bg-critical' : (v ?? 0) >= 0.8 ? 'bg-warning' : 'bg-primary';
const link = (s: ServerRow) => ({ name: 'server', params: { server: s.name } });
const problemLink = (s: ServerRow, p: ServerRow['problems'][number]) =>
  p.source === 'container'
    ? { name: 'docker-container', params: { host: s.name, name: p.name } }
    : { name: 'server-workload', params: { server: s.name, workload: p.id } };

const poll = usePolling(() => page.load(), REFRESH_MS);
onMounted(() => {
  void page.load();
  poll.start();
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('servers.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-24 font-semibold text-text">
          {{ $t('servers.title', totals?.servers ?? 0) }}
          <LoadingIndicator :active="page.refreshing.value" />
        </h2>
        <p class="mt-1 text-14 text-text-muted">{{ $t('servers.intro') }}</p>
      </div>
      <RouterLink
        v-if="addTo"
        :to="addTo"
        class="inline-flex min-h-9 items-center rounded-control bg-primary px-3.5 text-13 font-semibold text-on-primary hover:bg-primary-hover max-lg:min-h-11"
      >
        {{ $t('servers.addServers') }}
      </RouterLink>
    </header>

    <dl v-if="totals" class="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="server-tiles">
      <div class="rounded-card border border-border bg-surface-1 px-5 py-4">
        <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">
          {{ $t('servers.tiles.needAttention') }}
        </dt>
        <dd
          class="text-24 font-semibold tabular"
          :class="totals.needAttention ? 'text-warning' : 'text-text'"
        >
          {{ totals.needAttention }}
        </dd>
      </div>
      <div class="rounded-card border border-border bg-surface-1 px-5 py-4">
        <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">
          {{ $t('servers.tiles.services') }}
        </dt>
        <dd class="text-24 font-semibold text-text tabular">
          {{ totals.services }}
          <span
            v-if="totals.servicesFailed"
            class="text-14 font-medium text-critical max-lg:block max-lg:text-13"
          >
            {{ $t('servers.tiles.servicesFailed', { n: totals.servicesFailed }) }}
          </span>
        </dd>
      </div>
      <div class="rounded-card border border-border bg-surface-1 px-5 py-4">
        <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">
          {{ $t('servers.tiles.processes') }}
        </dt>
        <dd class="text-24 font-semibold text-text tabular">
          {{ totals.processes }}
          <span
            v-if="totals.crashLooping"
            class="text-14 font-medium text-warning max-lg:block max-lg:text-13"
          >
            {{ $t('servers.tiles.crashLooping', { n: totals.crashLooping }) }}
          </span>
        </dd>
      </div>
      <div class="rounded-card border border-border bg-surface-1 px-5 py-4">
        <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">
          {{ $t('servers.tiles.containers') }}
        </dt>
        <dd class="text-24 font-semibold text-text tabular">{{ totals.containers }}</dd>
      </div>
    </dl>

    <SkeletonTable v-if="page.skeleton.value" :label="$t('common.loading')" />
    <EmptyState
      v-else-if="page.loaded.value && servers.length === 0 && !page.error.value"
      :icon="Server"
      :title="$t('servers.empty.title')"
      :description="$t('servers.empty.description')"
      :action-label="addTo ? $t('servers.addServers') : undefined"
      :action-to="addTo"
    />
    <section
      v-else-if="servers.length"
      class="overflow-hidden rounded-card border border-border bg-surface-1"
    >
      <div class="flex items-center justify-end border-b border-border px-4 py-3">
        <span class="text-12 text-text-muted">{{ $t('servers.problemsFirst') }}</span>
      </div>
      <!-- Wide screens: the table. -->
      <table class="w-full text-left text-13 max-lg:hidden" data-testid="server-table">
        <thead class="text-11 tracking-[0.08em] text-text-muted uppercase">
          <tr>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.server') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.cpu') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.memory') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.disk') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.workloads') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.attention') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in servers"
            :key="s.name"
            class="border-t border-border align-middle"
            data-testid="server-row"
          >
            <td class="px-4 py-3">
              <RouterLink :to="link(s)" class="font-semibold text-text hover:underline">
                {{ s.name }}
              </RouterLink>
              <p class="text-12 text-text-subtle">
                {{ shortOs(s.os) ?? '–' }}
                <span v-if="s.status === 'inactive'" class="text-warning">
                  · {{ $t('clusters.status.inactive') }}</span
                >
              </p>
            </td>
            <td
              v-for="(v, i) in [s.cpuUtilization, s.memoryUtilization, s.diskUtilization]"
              :key="i"
              class="w-[14%] px-4 py-3"
            >
              <span class="font-mono text-12 text-text tabular">{{ pct(v) }}</span>
              <div class="mt-1 h-1 rounded-full bg-surface-3">
                <div class="h-1 rounded-full" :class="barTone(v)" :style="{ width: width(v) }" />
              </div>
            </td>
            <td class="px-4 py-3">
              <div class="flex flex-wrap gap-1.5">
                <SourceChip
                  source="service"
                  :label="$t('servers.chips.service', { n: s.workloads.services })"
                />
                <SourceChip
                  source="process"
                  :label="$t('servers.chips.process', { n: s.workloads.processes })"
                />
                <SourceChip
                  v-if="s.workloads.containers"
                  source="container"
                  :label="$t('servers.chips.container', { n: s.workloads.containers })"
                />
              </div>
            </td>
            <td class="px-4 py-3">
              <div v-if="s.problems.length" class="flex flex-col items-start gap-1">
                <RouterLink
                  v-for="p in s.problems"
                  :key="p.id"
                  :to="problemLink(s, p)"
                  class="hover:underline"
                >
                  <TonePill
                    :tone="p.severity === 'critical' ? 'critical' : 'warning'"
                    :label="`${p.name} ${$t(`servers.problem.${p.kind}`)}`"
                  />
                </RouterLink>
                <span v-if="s.problemCount > s.problems.length" class="text-12 text-text-muted">
                  {{ $t('servers.more', { n: s.problemCount - s.problems.length }) }}
                </span>
              </div>
              <span v-else class="text-12 text-text-subtle">{{ $t('servers.fine') }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- Phones: one card a server. -->
      <ul class="divide-y divide-border lg:hidden" data-testid="server-cards">
        <li v-for="s in servers" :key="s.name" class="flex flex-col gap-2 px-4 py-3">
          <div class="flex items-baseline justify-between gap-2">
            <RouterLink :to="link(s)" class="min-h-11 font-semibold text-text hover:underline">
              {{ s.name }}
            </RouterLink>
            <span class="text-12 text-text-subtle">{{ shortOs(s.os) ?? '' }}</span>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div
              v-for="(v, i) in [s.cpuUtilization, s.memoryUtilization, s.diskUtilization]"
              :key="i"
            >
              <span class="text-11 tracking-[0.08em] text-text-muted uppercase">{{
                $t(['servers.columns.cpu', 'servers.columns.memory', 'servers.columns.disk'][i]!)
              }}</span>
              <span class="block font-mono text-12 text-text tabular">{{ pct(v) }}</span>
              <div class="mt-1 h-1 rounded-full bg-surface-3">
                <div class="h-1 rounded-full" :class="barTone(v)" :style="{ width: width(v) }" />
              </div>
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <SourceChip
              source="service"
              :label="$t('servers.chips.service', { n: s.workloads.services })"
            />
            <SourceChip
              source="process"
              :label="$t('servers.chips.process', { n: s.workloads.processes })"
            />
            <SourceChip
              v-if="s.workloads.containers"
              source="container"
              :label="$t('servers.chips.container', { n: s.workloads.containers })"
            />
          </div>
          <RouterLink v-for="p in s.problems" :key="p.id" :to="problemLink(s, p)" class="min-h-11">
            <TonePill
              :tone="p.severity === 'critical' ? 'critical' : 'warning'"
              :label="`${p.name} ${$t(`servers.problem.${p.kind}`)}`"
            />
          </RouterLink>
        </li>
      </ul>
    </section>
    <p class="px-1 text-12 text-text-muted">{{ $t('servers.footnote') }}</p>
  </div>
</template>
