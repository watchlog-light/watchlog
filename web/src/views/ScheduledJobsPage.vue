<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SummaryTile from '@/components/applications/SummaryTile.vue';
import JobRunsCard from '@/components/jobs/JobRunsCard.vue';
import CertsJobsEmpty from '@/components/certs/CertsJobsEmpty.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SearchField from '@/components/ui/SearchField.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { useStoredChoice } from '@/composables/useStoredChoice';
import { filterJobs, jobName, jobTiles, type JobFilter } from '@/lib/certs-jobs';
import { RUN_RANGES } from '@/lib/run-timeline';
import { useCertsJobsStore } from '@/stores/certsJobs';
import { useClustersStore } from '@/stores/clusters';

// Scheduled jobs (0.10, ADR-223; its own page since 0.13.0; one list since 0.13.1, ADR-230):
// systemd timers and cron jobs on a fleet's servers, a cluster's CronJobs. Four tiles, then
// "Jobs and their runs": one row per job with its run strip, the filters in its header, the
// range remembered in this browser; then the default alerts.
const route = useRoute();
const router = useRouter();
const store = useCertsJobsStore();
const clusters = useClustersStore();

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  return { cluster: c, data: await store.loadJobs(c.id, true) };
});
onMounted(() => void page.load());
watch(
  () => clusters.selected?.id,
  () => void page.load(),
);

const kube = computed(() => page.data.value?.cluster.kind === 'kubernetes');
const list = computed(() => page.data.value?.data.jobs ?? []);
const FILTERS = computed<JobFilter[]>(() =>
  kube.value ? ['all', 'attention'] : ['all', 'attention', 'timer', 'cron'],
);
const filter = computed<JobFilter>(() => {
  const v = route.query.show;
  return v === 'attention' || v === 'timer' || v === 'cron' || v === 'cronjob' ? v : 'all';
});
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const setQuery = (patch: Record<string, string | undefined>) =>
  void router.replace({ query: { ...route.query, ...patch } });
watch(q, (v) => setQuery({ q: v || undefined }));
const rows = computed(() => filterJobs(list.value, filter.value, q.value));
const tiles = computed(() => jobTiles(list.value));
const count = (f: JobFilter) => filterJobs(list.value, f, '').length;
const lastDay = computed(() => page.data.value?.data.lastDay ?? { runs: 0, failures: 0 });

const agents = computed(() => page.data.value?.data.agentsWithout ?? []);
// No agent has reported what it covers yet: the first read is still to come.
const waiting = computed(
  () =>
    page.loaded.value &&
    (page.data.value?.data.coverage ?? []).length === 0 &&
    agents.value.length === 0,
);
// A new key in 0.13.1: everyone starts at 24 h once, then the choice is remembered again.
const runRange = useStoredChoice('watchlog.jobRuns.range', RUN_RANGES, '24h');
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="scheduled-jobs">
    <p
      v-if="agents.length > 0 && list.length > 0"
      class="rounded-card border border-info/40 bg-info/10 px-4 py-3 text-14 text-text"
      data-testid="needs-agent"
    >
      {{
        kube
          ? $t('jobs.needsAgent.cluster', { version: agents[0]!.version })
          : $t(
              'jobs.needsAgent.servers',
              {
                n: agents.length,
                names: agents
                  .slice(0, 5)
                  .map((a) => a.node)
                  .join(', '),
              },
              agents.length,
            )
      }}
    </p>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('jobs.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonTable
      v-if="page.skeleton.value"
      :columns="6"
      :rows="4"
      :label="$t('common.loading')"
    />

    <template v-else-if="page.loaded.value">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile
          :label="$t('jobs.tiles.total')"
          :value="String(tiles.total)"
          :sub="
            kube
              ? $t('jobs.tiles.cronjobs', { n: tiles.cronjobs }, tiles.cronjobs)
              : $t('jobs.tiles.kinds', { timers: tiles.timers, cron: tiles.cron })
          "
        />
        <SummaryTile
          :label="$t('jobs.tiles.failing')"
          :value="String(tiles.failing.length)"
          :tone="tiles.failing.length ? 'crit' : 'ok'"
          :sub="tiles.failing.map((j) => jobName(j).name).join(', ') || $t('jobs.tiles.none')"
        />
        <SummaryTile
          :label="$t('jobs.tiles.missedOrSlow')"
          :value="String(tiles.missedOrSlow.length)"
          :tone="tiles.missedOrSlow.length ? 'warn' : 'ok'"
          :sub="tiles.missedOrSlow.map((j) => jobName(j).name).join(', ') || $t('jobs.tiles.none')"
        />
        <SummaryTile
          :label="$t('jobs.tiles.ranOnTime')"
          :value="
            $t('jobs.tiles.ranOnTimeValue', {
              ok: (lastDay.runs - lastDay.failures).toLocaleString('en'),
              total: lastDay.runs.toLocaleString('en'),
            })
          "
          :sub="$t('jobs.tiles.ranOnTimeSub')"
        />
      </div>

      <CertsJobsEmpty
        v-if="list.length === 0"
        what="jobs"
        :cluster-id="page.data.value!.cluster.id"
        :cluster-name="page.data.value!.cluster.name"
        :kind="kube ? 'kubernetes' : 'server'"
        :agents="agents"
        :waiting="waiting"
      />

      <JobRunsCard
        v-else
        v-model:range="runRange"
        :cluster-id="page.data.value!.cluster.id"
        :kind="kube ? 'kubernetes' : 'server'"
        :jobs="rows"
      >
        <template #filters>
          <div role="group" :aria-label="$t('jobs.filters.label')" class="flex flex-wrap gap-1.5">
            <button
              v-for="f in FILTERS"
              :key="f"
              type="button"
              :aria-pressed="filter === f"
              :class="[
                'inline-flex h-8.5 items-center gap-1.5 rounded-full border px-3 text-13 font-medium max-lg:min-h-11',
                filter === f
                  ? 'border-border-strong bg-surface-3 text-text'
                  : 'border-border text-text-muted hover:bg-surface-2',
              ]"
              data-testid="job-filter"
              @click="setQuery({ show: f === 'all' ? undefined : f })"
            >
              {{ $t(`jobs.filters.${f}`) }}
              <span class="text-text-muted">{{ count(f) }}</span>
            </button>
          </div>
          <SearchField
            v-model="q"
            class="min-w-48"
            :label="$t('jobs.filters.search')"
            :placeholder="$t('jobs.filters.search')"
            @clear="q = ''"
          />
        </template>
      </JobRunsCard>

      <section class="flex flex-col gap-2 rounded-card border border-border bg-surface-1 px-5 py-4">
        <h2 class="text-16 font-semibold text-text">{{ $t('jobs.alertsNote.title') }}</h2>
        <p class="text-14 leading-relaxed text-text-muted">{{ $t('jobs.alertsNote.text') }}</p>
        <p class="text-13 leading-relaxed text-text-muted">
          {{ kube ? $t('jobs.alertsNote.howKube') : $t('jobs.alertsNote.how') }}
        </p>
      </section>
    </template>
  </div>
</template>
