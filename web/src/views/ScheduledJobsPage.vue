<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CalendarClock, ChevronRight } from '@lucide/vue';
import type { ScheduledJob } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import RunBars from '@/components/applications/RunBars.vue';
import SummaryTile from '@/components/applications/SummaryTile.vue';
import ToneChip from '@/components/applications/ToneChip.vue';
import RunTimeline from '@/components/jobs/RunTimeline.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SearchField from '@/components/ui/SearchField.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { useNarrow } from '@/composables/useNarrow';
import { useStoredChoice } from '@/composables/useStoredChoice';
import {
  JOB_TONE,
  duration,
  filterJobs,
  jobKind,
  jobName,
  jobProblem,
  jobTiles,
  lastRunWords,
  scheduleWords,
  type JobFilter,
  type Tone,
  type Words,
} from '@/lib/certs-jobs';
import { formatWhen } from '@/lib/format';
import { RUN_RANGES } from '@/lib/run-timeline';
import { useCertsJobsStore } from '@/stores/certsJobs';
import { useClustersStore } from '@/stores/clusters';

// Scheduled jobs (0.10, ADR-223; its own page since 0.13.0, ADR-230): systemd timers and cron jobs on a fleet's
// servers, a cluster's CronJobs; problems first, as in the reference: four tiles, the table
// (job, schedule and next run, last run and its duration, the last 14 runs as small bars,
// what needs attention, status), the default alerts. Phones get one card per job. Above the
// table, "Runs": the run timeline, its range remembered in this browser; the filter applies.
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const narrow = useNarrow();
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

const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const TEXT_TONE: Record<Tone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  ok: 'text-text-muted',
  info: 'text-info-text',
  muted: 'text-text-muted',
};
const nextRun = (j: ScheduledJob) =>
  j.nextAt
    ? t('jobs.schedule.next', { when: formatWhen(new Date(j.nextAt * 1000).toISOString()) })
    : t('jobs.schedule.noNext');
const took = (j: ScheduledJob) => {
  const r = j.lastRun;
  if (!r) return '';
  if (r.result === 'running')
    return j.usualSeconds ? t('jobs.last.usually', { d: duration(j.usualSeconds) }) : '';
  return r.seconds !== null ? t('jobs.last.took', { d: duration(r.seconds) }) : '';
};
const runsAria = (j: ScheduledJob) => {
  const ok = j.recent.filter((r) => r.result === 'success').length;
  const failed = j.recent.filter((r) => r.result === 'failed').length;
  return t(
    'jobs.runsAria',
    { n: j.recent.length, summary: t('jobs.runsSummary', { ok, failed }) },
    j.recent.length,
  );
};
const subOf = (j: ScheduledJob) => {
  const k = say(jobKind(j));
  return j.node ? `${k} · ${j.node}` : k;
};
const agents = computed(() => page.data.value?.data.agentsWithout ?? []);
const runRange = useStoredChoice('watchlog.runTimeline.range', RUN_RANGES, '24h');
const runRangeOptions = computed(() =>
  RUN_RANGES.map((r) => ({ value: r, label: t(`runTimeline.ranges.${r}`) })),
);
const columns =
  'grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_9.5rem_minmax(0,1.8fr)_6.5rem_1rem]';
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="scheduled-jobs">
    <p
      v-if="agents.length > 0"
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

      <EmptyState
        v-if="list.length === 0"
        :icon="CalendarClock"
        :title="$t('jobs.empty.title')"
        :description="$t('jobs.empty.description')"
      />

      <template v-else>
        <div class="flex flex-wrap items-center justify-between gap-2">
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
            class="min-w-56"
            :label="$t('jobs.filters.search')"
            :placeholder="$t('jobs.filters.search')"
            @clear="q = ''"
          />
        </div>

        <section
          class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 px-5 py-4"
          aria-labelledby="run-timeline-title"
          data-testid="run-timeline-card"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h2 id="run-timeline-title" class="text-16 font-semibold text-text">
              {{ $t('runTimeline.title') }}
            </h2>
            <SegmentedControl
              v-model="runRange"
              :options="runRangeOptions"
              :label="$t('runTimeline.range')"
              data-testid="run-timeline-range"
            />
          </div>
          <RunTimeline :cluster-id="page.data.value!.cluster.id" :jobs="rows" :range="runRange" />
        </section>

        <section class="overflow-hidden rounded-card border border-border bg-surface-1">
          <div
            v-if="!narrow"
            :class="[
              'grid gap-4 border-b border-border px-4 py-2.5 text-11 font-medium tracking-wider text-text-muted uppercase',
              columns,
            ]"
          >
            <span>{{ $t('jobs.columns.job') }}</span>
            <span>{{ $t('jobs.columns.schedule') }}</span>
            <span>{{ $t('jobs.columns.lastRun') }}</span>
            <span>{{ $t('jobs.columns.recent') }}</span>
            <span>{{ $t('jobs.columns.attention') }}</span>
            <span>{{ $t('jobs.columns.status') }}</span>
            <span />
          </div>
          <p v-if="rows.length === 0" class="px-4 py-6 text-14 text-text-muted">
            {{ $t('jobs.empty.filtered') }}
          </p>
          <ul data-testid="job-list">
            <li
              v-for="j in rows"
              :key="`${j.node}/${j.id}`"
              :class="[
                'border-t border-border first:border-t-0',
                JOB_TONE[j.state] === 'crit' ? 'bg-critical/5' : '',
              ]"
              data-testid="job-row"
            >
              <RouterLink
                :to="{
                  name: 'scheduled-job',
                  params: { jobId: j.id },
                  query: j.node ? { node: j.node } : {},
                }"
                :aria-label="$t('jobs.open', { name: j.name })"
                :class="[
                  'hover:bg-surface-2',
                  narrow
                    ? 'flex flex-col gap-2 px-4 py-3.5'
                    : ['grid items-center gap-4 px-4 py-3.5', columns],
                ]"
              >
                <span class="flex min-w-0 items-start justify-between gap-3">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate font-mono text-14 font-semibold text-text">{{
                      jobName(j).name
                    }}</span>
                    <span class="truncate text-12 text-text-muted">{{ subOf(j) }}</span>
                  </span>
                  <ToneChip
                    v-if="narrow"
                    :tone="JOB_TONE[j.state] ?? 'muted'"
                    :label="$t(`jobs.status.${j.state}`)"
                  />
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="truncate text-13 text-text">{{
                    say(scheduleWords(j.schedule))
                  }}</span>
                  <span class="truncate text-12 text-text-muted">{{ nextRun(j) }}</span>
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span
                    :class="[
                      'truncate text-13',
                      j.lastRun?.result === 'failed'
                        ? 'text-critical-text'
                        : j.lastRun?.result === 'running'
                          ? 'text-info-text'
                          : 'text-text',
                    ]"
                    data-testid="last-run"
                    >{{ say(lastRunWords(j)) }}</span
                  >
                  <span class="truncate font-mono text-12 text-text-muted">{{ took(j) }}</span>
                </span>
                <RunBars :runs="j.recent" :usual="j.usualSeconds" :label="runsAria(j)" />
                <span
                  :class="['text-13 leading-snug', TEXT_TONE[jobProblem(j).tone]]"
                  data-testid="attention"
                  >{{ say(jobProblem(j).words) }}</span
                >
                <span v-if="!narrow"
                  ><ToneChip
                    :tone="JOB_TONE[j.state] ?? 'muted'"
                    :label="$t(`jobs.status.${j.state}`)"
                /></span>
                <ChevronRight v-if="!narrow" class="size-4 text-text-subtle" aria-hidden="true" />
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>

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
