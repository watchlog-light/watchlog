<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ServerWorkloadDetail } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import SourceChip from '@/components/servers/SourceChip.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { formatCores } from '@/lib/resources';
import { portsText, timelineBars, workloadLink } from '@/lib/servers';
import { formatBytes } from '@/lib/units';
import { useFleetStore } from '@/stores/fleet';

// A service or process group on a server (ADR-207/208; the canvas "Workload"): resources
// against limits, the last hour of exits and restarts from the kernel with the releases
// marked, what it runs in or holds, and its connections. Aggregates only, never PIDs.
const REFRESH_MS = 30_000;
const { t } = useI18n();
const route = useRoute();
const server = computed(() => String(route.params.server));
const id = computed(() => String(route.params.workload));
const fleetStore = useFleetStore();

const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  return api<ServerWorkloadDetail>(
    `/clusters/${f.id}/servers/${encodeURIComponent(server.value)}/workloads/${encodeURIComponent(id.value)}`,
  );
});
const d = computed(() => page.data.value);
const w = computed(() => d.value?.workload);

const clock = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const describe = computed(() => {
  const x = w.value;
  if (!x) return '';
  const where =
    x.source === 'service'
      ? t('servers.workload.service', { server: server.value })
      : x.unit
        ? t('servers.workload.processInUnit', { unit: x.unit, server: server.value })
        : t('servers.workload.processAlone', { server: server.value });
  const by =
    x.source === 'process' && x.note
      ? ` ${t('servers.workload.byRule', { rule: t(`servers.by.${x.note}`) })}`
      : '';
  return where + by;
});

const tiles = computed(() => {
  const x = w.value;
  const u = d.value?.usage;
  if (!x || !u) return [];
  const out: { label: string; value: string; sub?: string }[] = [
    {
      label: t('servers.workload.tiles.cpu'),
      value: x.cpuCores == null ? '–' : formatCores(x.cpuCores),
      sub: u.cpuLimitCores
        ? t('servers.workload.tiles.cpuLimit', { v: formatCores(u.cpuLimitCores) })
        : undefined,
    },
    {
      label: t('servers.workload.tiles.memory'),
      value: x.memoryBytes == null ? '–' : formatBytes(x.memoryBytes),
      sub: x.memoryLimitBytes
        ? t('servers.workload.tiles.limit', { v: formatBytes(x.memoryLimitBytes) })
        : t('servers.workload.tiles.noLimit'),
    },
  ];
  if (x.source === 'process') {
    out.push({ label: t('servers.workload.tiles.instances'), value: String(x.instances ?? '–') });
    if (u.threads != null)
      out.push({ label: t('servers.workload.tiles.threads'), value: String(u.threads) });
    if (u.openFiles != null)
      out.push({ label: t('servers.workload.tiles.openFiles'), value: String(u.openFiles) });
  } else if (u.tasks != null) {
    out.push({ label: t('servers.workload.tiles.tasks'), value: String(u.tasks) });
  }
  out.push({
    label: t('servers.workload.tiles.restarts'),
    value: x.restarts24h == null ? '–' : String(Math.round(x.restarts24h)),
  });
  if (x.lastExitCode != null)
    out.push({ label: t('servers.workload.tiles.lastExit'), value: String(x.lastExitCode) });
  if (u.startedAt)
    out.push({ label: t('servers.workload.tiles.started'), value: clock(u.startedAt) });
  return out;
});

const bars = computed(() => (d.value ? timelineBars(d.value.timeline.points) : []));
const quiet = computed(() => bars.value.every((b) => b.crashes === 0 && b.restarts === 0));
const at = (unix: number) => {
  const tl = d.value?.timeline;
  if (!tl) return '0%';
  return `${((unix - tl.start) / (tl.end - tl.start)) * 100}%`;
};
const rate = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(v >= 1 ? 1 : 2));
const rulesLink = computed(() =>
  fleetStore.fleet
    ? { name: 'cluster-settings', params: { id: fleetStore.fleet.id }, hash: '#process-rules' }
    : undefined,
);

const poll = usePolling(() => page.load(), REFRESH_MS);
onMounted(() => {
  void page.load();
  poll.start();
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <nav
      class="flex flex-wrap items-center gap-1.5 text-13 text-text-muted"
      aria-label="breadcrumb"
    >
      <RouterLink
        :to="{ name: 'servers' }"
        class="inline-flex items-center hover:text-text max-lg:min-h-11"
        >{{ $t('nav.servers') }}</RouterLink
      >
      <span aria-hidden="true">/</span>
      <RouterLink
        :to="{ name: 'server', params: { server } }"
        class="inline-flex items-center hover:text-text max-lg:min-h-11"
        >{{ server }}</RouterLink
      >
      <template v-if="w?.unit">
        <span aria-hidden="true">/</span>
        <RouterLink
          :to="{ name: 'server-workload', params: { server, workload: `service:${w.unit}` } }"
          class="inline-flex items-center font-mono hover:text-text max-lg:min-h-11"
          >{{ w.unit }}</RouterLink
        >
      </template>
    </nav>
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('servers.errors.workloadNotFound')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader v-else-if="page.skeleton.value" :label="$t('common.loading')" />

    <header
      v-if="w"
      class="flex flex-wrap items-start justify-between gap-3"
      data-testid="workload-header"
    >
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2.5">
          <h2 class="font-mono text-24 font-semibold text-text">{{ w.name }}</h2>
          <SourceChip :source="w.source" :label="$t(`servers.source.${w.source}`)" />
          <TonePill
            v-if="w.problem"
            :tone="w.problem.severity"
            :label="
              d?.crashLoopSince
                ? $t('servers.workload.crashSince', { t: clock(d.crashLoopSince) })
                : $t(`servers.problem.${w.problem.kind}`)
            "
          />
          <LoadingIndicator :active="page.refreshing.value" />
        </div>
        <p class="text-14 text-text-muted">{{ describe }}</p>
        <p v-if="w.ports.length" class="font-mono text-12 text-text-subtle">
          {{ $t('servers.workload.ports', { ports: portsText(w.ports) }) }}
        </p>
      </div>
      <div class="flex gap-2">
        <RouterLink
          :to="{ name: 'alerts', query: { tab: 'rules' } }"
          class="inline-flex min-h-9 items-center rounded-control border border-border px-3 text-13 text-text hover:bg-surface-2 max-lg:min-h-11"
          >{{ $t('servers.workload.alertRules') }}</RouterLink
        >
        <RouterLink
          v-if="w.source === 'process' && rulesLink"
          :to="rulesLink"
          class="inline-flex min-h-9 items-center rounded-control border border-border px-3 text-13 text-text hover:bg-surface-2 max-lg:min-h-11"
          >{{ $t('servers.workload.groupingRule') }}</RouterLink
        >
      </div>
    </header>

    <dl v-if="tiles.length" class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <div
        v-for="x in tiles"
        :key="x.label"
        class="rounded-card border border-border bg-surface-1 px-4 py-3"
      >
        <dt class="text-11 tracking-[0.08em] text-text-muted uppercase">{{ x.label }}</dt>
        <dd class="mt-1 text-16 font-semibold text-text tabular">{{ x.value }}</dd>
        <dd v-if="x.sub" class="text-12 text-text-subtle">{{ x.sub }}</dd>
      </div>
    </dl>

    <section
      v-if="d"
      class="flex flex-col gap-5 rounded-card border border-border bg-surface-1 px-5 py-4"
    >
      <div data-testid="exit-timeline">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="text-14 font-semibold text-text">
            {{ $t('servers.workload.timeline.title') }}
          </h3>
          <span class="text-12 text-text-muted">{{ $t('servers.workload.timeline.hint') }}</span>
        </div>
        <div class="relative mt-3 h-24 border-b border-border">
          <div class="absolute inset-0 flex items-end gap-px">
            <div
              v-for="b in bars"
              :key="b.t"
              class="flex-1 rounded-t-sm"
              :class="b.crashes > 0 ? 'bg-critical' : b.restarts > 0 ? 'bg-warning' : ''"
              :style="{ height: `${Math.max(b.h * 100, b.crashes || b.restarts ? 6 : 0)}%` }"
              :title="
                $t('servers.workload.timeline.bar', {
                  t: clock(b.t),
                  crashes: b.crashes,
                  restarts: b.restarts,
                })
              "
            />
          </div>
          <div
            v-for="r in d.timeline.releases"
            :key="r"
            class="absolute inset-y-0 border-l border-dashed border-info"
            :style="{ left: at(r) }"
            data-testid="release-marker"
          />
        </div>
        <div
          class="mt-1.5 flex flex-wrap justify-between gap-x-3 font-mono text-12 text-text-subtle"
        >
          <span>{{ clock(d.timeline.start) }}</span>
          <span
            v-for="r in d.timeline.releases.slice(-1)"
            :key="r"
            class="text-info max-md:order-last max-md:w-full"
          >
            {{ clock(r) }} {{ $t('servers.workload.timeline.release') }}
          </span>
          <span>{{ clock(d.timeline.end) }}</span>
        </div>
        <p v-if="quiet" class="mt-2 text-13 text-text-muted">
          {{ $t('servers.workload.timeline.empty') }}
        </p>
      </div>

      <div v-if="d.related.length">
        <h3 class="mb-2 text-14 font-semibold text-text">
          {{
            w?.source === 'service'
              ? $t('servers.workload.related.children')
              : $t('servers.workload.related.parent')
          }}
        </h3>
        <ul class="flex flex-col gap-1.5">
          <li
            v-for="r in d.related"
            :key="r.id"
            class="flex items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2 text-13"
          >
            <RouterLink :to="workloadLink(server, r)" class="font-mono text-text hover:underline">{{
              r.name
            }}</RouterLink>
            <span class="flex items-center gap-3 font-mono text-12 text-text-muted tabular">
              <span>{{ r.cpuCores == null ? '–' : formatCores(r.cpuCores) }}</span>
              <span>{{ r.memoryBytes == null ? '–' : formatBytes(r.memoryBytes) }}</span>
              <TonePill
                v-if="r.problem"
                :tone="r.problem.severity"
                :label="$t(`servers.problem.${r.problem.kind}`)"
              />
            </span>
          </li>
        </ul>
        <p v-if="w?.source === 'process'" class="mt-2 text-12 text-text-subtle">
          {{ $t('servers.workload.privacy') }}
        </p>
      </div>
      <p v-else-if="w?.source === 'process'" class="text-12 text-text-subtle">
        {{ $t('servers.workload.privacy') }}
      </p>

      <div>
        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 class="text-14 font-semibold text-text">
            {{ $t('servers.workload.connections.title') }}
          </h3>
          <span class="text-12 text-text-muted">{{ $t('servers.workload.connections.hint') }}</span>
        </div>
        <ul v-if="d.connections.length" class="flex flex-col gap-1.5">
          <li
            v-for="(e, i) in d.connections"
            :key="i"
            class="flex items-center justify-between gap-3 rounded-control bg-surface-2 px-3 py-2 font-mono text-12"
          >
            <span class="truncate text-text">→ {{ e.to }}{{ e.port ? `:${e.port}` : '' }}</span>
            <span class="flex shrink-0 gap-2 tabular">
              <span class="text-text-muted">{{
                $t('servers.talksTo.rate', { v: rate(e.rate) })
              }}</span>
              <span :class="e.failed > 0 ? 'text-critical' : 'text-ok'">{{
                e.failed > 0
                  ? $t('servers.talksTo.failed', { v: rate(e.failed) })
                  : $t('servers.talksTo.ok')
              }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-13 text-text-muted">{{ $t('servers.talksTo.empty') }}</p>
      </div>
    </section>
  </div>
</template>
