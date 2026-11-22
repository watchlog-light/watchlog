<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { JobTimeline, ScheduledJob } from '@watchlog/api-types';
import { ChevronRight } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import ToneChip from '@/components/applications/ToneChip.vue';
import SegmentedControl from '@/components/overview/SegmentedControl.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useNarrow } from '@/composables/useNarrow';
import { JOB_TONE, duration, jobKind, jobName, type Words } from '@/lib/certs-jobs';
import { formatDateTime } from '@/lib/format';
import {
  RUN_RANGES,
  lastRunLine,
  laneWords,
  markWords,
  nextLine,
  notRunningSummary,
  notRunningWhy,
  nowPct,
  runLanes,
  runTicks,
  watchedFor,
  type MarkKind,
  type RunLane,
  type RunMark,
  type RunRange,
} from '@/lib/run-timeline';
import { RAW, scheduleWords } from '@/lib/schedule-words';

// "Jobs and their runs" (0.13.1, ADR-230 amended): the Scheduled jobs page's one list. One
// row per job, one link to its page: the job and where it runs, its schedule in words and next
// run, its run strip over the range (each slot's worst run, the next runs dashed, a random
// delay as a faint bar, the time before WatchLog first saw it hatched), its last run and
// status. Jobs that don't run sit in one collapsed row at the bottom with their reason. The
// page passes its filters (the chips and the search) in the header's slot.
const props = defineProps<{
  clusterId: string;
  kind: 'kubernetes' | 'server';
  jobs: ScheduledJob[];
}>();
const range = defineModel<RunRange>('range', { required: true });
const { t } = useI18n();
const narrow = useNarrow();

const data = ref<JobTimeline | null>(null);
const error = ref(false);
const loading = ref(false);
let asked = 0;
async function load() {
  const mine = ++asked;
  loading.value = true;
  error.value = false;
  try {
    const res = await api<JobTimeline>(
      `/clusters/${props.clusterId}/scheduled-jobs/timeline?range=${range.value}`,
    );
    if (mine === asked) data.value = res;
  } catch {
    if (mine === asked) error.value = true;
  } finally {
    if (mine === asked) loading.value = false;
  }
}
watch(() => [props.clusterId, range.value], load, { immediate: true });

const lanes = computed(() => runLanes(props.jobs, data.value));
const openOff = ref(false);
const now = computed(() => (data.value ? nowPct(data.value) : 100));
const nowSec = computed(() => data.value?.now ?? Math.floor(Date.now() / 1000));
const ticks = computed(() =>
  data.value ? runTicks(data.value, range.value, -new Date().getTimezoneOffset()) : [],
);
const watched = computed(() => watchedFor(data.value, props.kind));
const rangeOptions = computed(() =>
  RUN_RANGES.map((r) => ({ value: r, label: t(`runTimeline.ranges.${r}`) })),
);

const tFn = (key: string, values?: Record<string, unknown>, n?: number) =>
  t(key, values ?? {}, n ?? 1);
const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const sayAll = (ws: Words[]) => ws.map(say).join(' · ');
const when = (unix: number) => formatDateTime(new Date(unix * 1000).toISOString());
const clock = (unix: number) => {
  const d = new Date(unix * 1000);
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  // Beyond the next 24 hours, the day too.
  return unix - nowSec.value > 86_400
    ? `${d.toLocaleDateString('en', { weekday: 'short' })} ${time}`
    : time;
};
const tickLabel = (unix: number) => {
  const d = new Date(unix * 1000);
  return range.value === '7d'
    ? d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' })
    : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
};
/** "systemd timer · demo-server", "cron · /etc/cron.d/php · demo-server", "CronJob in shop". */
const where = (j: ScheduledJob) => {
  const k = say(jobKind(j));
  return j.node ? `${k} · ${j.node}` : k;
};
const title = (j: ScheduledJob) => (j.node ? j.name : jobName(j).name);
const schedule = (j: ScheduledJob) => scheduleWords(j.schedule);
const rangeWords = computed(() => t(`runTimeline.ranges.${range.value}`));
const markText = (m: RunMark) => markWords(m, when, duration, tFn);
const laneText = (l: RunLane) => laneWords(l, title(l.job), rangeWords.value, when, tFn);
const lastTone = (j: ScheduledJob) =>
  j.lastRun?.result === 'failed'
    ? 'text-critical-text'
    : j.lastRun?.result === 'running'
      ? 'text-info-text'
      : 'text-text-muted';

const MARK: Record<MarkKind, string> = {
  success: 'bg-ok',
  failed: 'bg-critical',
  slow: 'bg-warning',
  missed: 'border-2 border-critical bg-transparent',
  unknown: 'bg-text-subtle',
  running: 'bg-info',
  next: 'border border-dashed border-text-muted bg-transparent',
};
const LEGEND = ['success', 'failed', 'slow', 'missed', 'unknown', 'next'] as const;
const link = (j: ScheduledJob) => ({
  name: 'scheduled-job',
  params: { jobId: j.id },
  query: j.node ? { node: j.node } : {},
});
const columns =
  'grid-cols-[minmax(11rem,1.3fr)_minmax(10rem,1.1fr)_minmax(12rem,2.2fr)_minmax(9rem,1fr)_6.5rem_1rem]';
</script>

<template>
  <section
    class="flex flex-col rounded-card border border-border bg-surface-1"
    aria-labelledby="job-runs-title"
    data-testid="job-runs"
  >
    <div class="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="job-runs-title" class="text-16 font-semibold text-text">
          {{ $t('jobRows.title') }}
        </h2>
        <slot name="filters" />
      </div>
      <SegmentedControl
        v-model="range"
        :options="rangeOptions"
        :label="$t('runTimeline.range')"
        data-testid="run-timeline-range"
      />
    </div>

    <ErrorState
      v-if="error"
      class="mx-5 mb-3"
      inline
      :message="$t('runTimeline.error')"
      :retrying="loading"
      @retry="load"
    />

    <!-- The columns, with the strip's ticks and "now" over its column. -->
    <div
      :class="[
        'border-t border-border px-5 py-2 text-11 font-medium tracking-wider text-text-muted uppercase',
        narrow ? '' : ['grid items-end gap-4', columns],
      ]"
    >
      <template v-if="!narrow">
        <span>{{ $t('jobRows.columns.job') }}</span>
        <span>{{ $t('jobRows.columns.schedule') }}</span>
      </template>
      <div class="relative h-4.5 normal-case" aria-hidden="true" data-testid="run-ticks">
        <template v-if="data">
          <span
            v-for="(tk, i) in ticks"
            :key="tk.at"
            :class="[
              'absolute top-0 font-mono text-12 font-normal tracking-normal whitespace-nowrap text-text-subtle',
              (narrow && i % 2 === 1) || Math.abs(tk.pct - now) < (narrow ? 12 : 7) ? 'hidden' : '',
            ]"
            :style="{
              left: `${tk.pct}%`,
              transform: `translateX(${tk.pct < 4 ? '0' : tk.pct > 96 ? '-100%' : '-50%'})`,
            }"
            >{{ tickLabel(tk.at) }}</span
          >
          <span
            class="absolute top-0 -translate-x-1/2 rounded-full bg-info px-1.5 font-mono text-11 leading-4 font-semibold text-on-primary uppercase"
            :style="{ left: `${now}%` }"
            >{{ $t('runTimeline.now') }}</span
          >
        </template>
      </div>
      <template v-if="!narrow">
        <span>{{ $t('jobRows.columns.lastRun') }}</span>
        <span>{{ $t('jobRows.columns.status') }}</span>
        <span />
      </template>
    </div>

    <p v-if="jobs.length === 0" class="border-t border-border px-5 py-6 text-14 text-text-muted">
      {{ $t('jobs.empty.filtered') }}
    </p>
    <ul data-testid="job-list">
      <li
        v-for="l in lanes.rows"
        :key="`${l.job.node}/${l.job.id}`"
        :class="['border-t border-border', JOB_TONE[l.job.state] === 'crit' ? 'bg-critical/5' : '']"
        data-testid="job-row"
        :data-state="l.job.state"
      >
        <RouterLink
          :to="link(l.job)"
          :aria-label="$t('jobs.open', { name: l.job.name })"
          :class="[
            'min-h-11 hover:bg-surface-2',
            narrow
              ? 'flex flex-col gap-1.5 px-4 py-3'
              : ['grid items-center gap-4 px-5 py-3', columns],
          ]"
        >
          <!-- Job (and on a phone, its status beside it). -->
          <span class="flex min-w-0 items-start justify-between gap-3">
            <span class="flex min-w-0 flex-col gap-0.5">
              <span
                class="font-mono text-14 font-semibold [overflow-wrap:anywhere] text-text"
                data-testid="job-name"
                >{{ title(l.job) }}</span
              >
              <span class="text-12 [overflow-wrap:anywhere] text-text-muted">{{
                where(l.job)
              }}</span>
            </span>
            <ToneChip
              v-if="narrow"
              :tone="JOB_TONE[l.job.state] ?? 'muted'"
              :label="$t(`jobs.status.${l.job.state}`)"
            />
          </span>
          <!-- Schedule and next run (on a phone, with the last run). -->
          <span
            :class="narrow ? 'flex flex-wrap gap-x-3 gap-y-0.5' : 'flex min-w-0 flex-col gap-0.5'"
          >
            <span
              :class="[
                'text-13 text-text',
                schedule(l.job).key === RAW ? 'font-mono text-12 [overflow-wrap:anywhere]' : '',
              ]"
              :title="l.job.schedule"
              data-testid="job-schedule"
              >{{ say(schedule(l.job)) }}</span
            >
            <span class="text-12 text-text-muted" data-testid="job-next">{{
              say(nextLine(l.next, clock))
            }}</span>
            <span v-if="narrow" :class="['text-12', lastTone(l.job)]">{{
              sayAll(lastRunLine(l.job, nowSec))
            }}</span>
          </span>
          <!-- The run strip. -->
          <span
            class="relative block h-5.5"
            role="img"
            :aria-label="laneText(l)"
            data-testid="run-strip"
          >
            <template v-if="data">
              <span
                v-if="l.hatch > 0"
                class="wl-hatch absolute inset-y-0 left-0 rounded-l-[3px]"
                :style="{ width: `${l.hatch}%` }"
                data-testid="run-hatch"
              />
              <span class="absolute inset-x-0 top-2.5 h-px bg-border" />
              <span
                class="absolute inset-y-0 right-0 rounded-r-[4px] bg-surface-2"
                :style="{ left: `${now}%` }"
              />
              <span
                v-if="l.window"
                class="absolute top-1.5 h-2.5 rounded-full bg-text-muted/15"
                :style="{ left: `${l.window.left}%`, width: `${l.window.width}%` }"
                data-testid="run-window"
              />
              <span class="absolute -inset-y-1 w-0.5 bg-info" :style="{ left: `${now}%` }" />
              <span
                v-for="m in l.marks"
                :key="`${m.kind}${m.at}`"
                class="absolute inset-y-0 flex justify-center"
                :style="{ left: `${m.left}%`, width: `${m.width}%`, minWidth: '3px' }"
                :title="markText(m)"
                data-testid="run-mark"
                :data-kind="m.kind"
              >
                <span
                  :class="[
                    'block h-full w-[calc(100%-1px)] min-w-0.75 rounded-[2px]',
                    MARK[m.kind],
                  ]"
                />
              </span>
            </template>
            <Skeleton v-else shape="rect" class="h-full w-full" />
          </span>
          <template v-if="!narrow">
            <span :class="['text-13 leading-snug', lastTone(l.job)]" data-testid="job-last">{{
              sayAll(lastRunLine(l.job, nowSec))
            }}</span>
            <span
              ><ToneChip
                :tone="JOB_TONE[l.job.state] ?? 'muted'"
                :label="$t(`jobs.status.${l.job.state}`)"
            /></span>
            <ChevronRight class="size-4 text-text-subtle" aria-hidden="true" />
          </template>
        </RouterLink>
      </li>
    </ul>

    <!-- Jobs that don't run: one collapsed row, their reason, no strip. -->
    <template v-if="lanes.notRunning.length">
      <button
        type="button"
        class="flex min-h-11 items-center gap-2 border-t border-border px-5 py-2.5 text-left text-13 font-medium text-text-muted hover:bg-surface-2"
        :aria-expanded="openOff"
        aria-controls="jobs-not-running"
        data-testid="not-running-toggle"
        @click="openOff = !openOff"
      >
        <ChevronRight
          :class="['size-4 transition-transform', openOff ? 'rotate-90' : '']"
          aria-hidden="true"
        />
        {{ say(notRunningSummary(lanes.notRunning)) }}
      </button>
      <ul v-show="openOff" id="jobs-not-running" data-testid="not-running">
        <li
          v-for="l in lanes.notRunning"
          :key="`${l.job.node}/${l.job.id}`"
          class="border-t border-border"
          data-testid="not-running-row"
        >
          <RouterLink
            :to="link(l.job)"
            :aria-label="$t('jobs.open', { name: l.job.name })"
            :class="[
              'min-h-11 hover:bg-surface-2',
              narrow
                ? 'flex flex-col gap-1 px-4 py-3'
                : ['grid items-center gap-4 px-5 py-3', columns],
            ]"
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="font-mono text-14 [overflow-wrap:anywhere] text-text-muted">{{
                title(l.job)
              }}</span>
              <span class="text-12 [overflow-wrap:anywhere] text-text-subtle">{{
                where(l.job)
              }}</span>
            </span>
            <span
              :class="[
                'text-13 text-text-muted',
                schedule(l.job).key === RAW ? 'font-mono text-12' : '',
              ]"
              :title="l.job.schedule"
              >{{ say(schedule(l.job)) }}</span
            >
            <span class="text-13 text-text-muted" data-testid="not-running-why">{{
              say(notRunningWhy(l.job))
            }}</span>
            <template v-if="!narrow">
              <span />
              <span><ToneChip tone="muted" :label="$t(`jobs.status.${l.job.state}`)" /></span>
              <ChevronRight class="size-4 text-text-subtle" aria-hidden="true" />
            </template>
          </RouterLink>
        </li>
      </ul>
    </template>

    <div class="flex flex-col gap-1.5 border-t border-border px-5 py-3">
      <p class="flex flex-wrap gap-x-3 gap-y-1 text-13 text-text-muted" data-testid="run-legend">
        <span
          v-for="k in LEGEND"
          :key="k"
          class="inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <span :class="['inline-block h-3 w-1.5 rounded-[2px]', MARK[k]]" aria-hidden="true" />
          {{ $t(`jobRows.legend.${k}`) }}
        </span>
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span class="wl-hatch inline-block h-3 w-4 rounded-[2px]" aria-hidden="true" />
          {{ $t('jobRows.legend.before') }}
        </span>
      </p>
      <p v-if="watched" class="text-13 text-text-muted" data-testid="watched-for">
        {{ say(watched) }}
      </p>
    </div>
  </section>
</template>
