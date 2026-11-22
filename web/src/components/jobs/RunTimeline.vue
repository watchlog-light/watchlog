<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { JobTimeline, ScheduledJob } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useNarrow } from '@/composables/useNarrow';
import { duration, jobName, scheduleWords, type Words } from '@/lib/certs-jobs';
import { formatDateTime } from '@/lib/format';
import {
  LANES_SHOWN,
  laneWords,
  markWords,
  nowPct,
  runLanes,
  runTicks,
  type MarkKind,
  type RunLane,
  type RunMark,
  type RunRange,
} from '@/lib/run-timeline';

// "Runs" (0.13.0, ADR-230): every job's runs over the range in one request, one lane per job
// (name and schedule on the left, the strip, a summary on the right), a "now" line with the
// future shaded, the next runs dashed. The page's filter decides which jobs get a lane.
const props = defineProps<{ clusterId: string; jobs: ScheduledJob[]; range: RunRange }>();
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
      `/clusters/${props.clusterId}/scheduled-jobs/timeline?range=${props.range}`,
    );
    if (mine === asked) data.value = res;
  } catch {
    if (mine === asked) error.value = true;
  } finally {
    if (mine === asked) loading.value = false;
  }
}
watch(() => [props.clusterId, props.range], load, { immediate: true });

const showAll = ref(false);
const lanes = computed(() => (data.value ? runLanes(props.jobs, data.value) : []));
const shown = computed(() => (showAll.value ? lanes.value : lanes.value.slice(0, LANES_SHOWN)));
const now = computed(() => (data.value ? nowPct(data.value) : 100));
const ticks = computed(() =>
  data.value ? runTicks(data.value, props.range, -new Date().getTimezoneOffset()) : [],
);

const tFn = (key: string, values?: Record<string, unknown>, n?: number) =>
  t(key, values ?? {}, n ?? 1);
const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const when = (unix: number) => formatDateTime(new Date(unix * 1000).toISOString());
const tickLabel = (unix: number) => {
  const d = new Date(unix * 1000);
  return props.range === '7d'
    ? d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' })
    : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
};
const laneName = (j: ScheduledJob) => {
  const n = jobName(j);
  if (j.node) return `${n.name} · ${j.node}`;
  return n.namespace ? `${n.namespace}/${n.name}` : n.name;
};
const rangeWords = computed(() => t(`runTimeline.ranges.${props.range}`));
const markText = (m: RunMark) => markWords(m, when, duration, tFn);
const laneText = (l: RunLane) => laneWords(l, laneName(l.job), rangeWords.value, when, tFn);
const summary = (l: RunLane) =>
  l.failures > 0
    ? t('runTimeline.summaryFailed', { n: l.runs, failed: l.failures }, l.runs)
    : t('runTimeline.summary', { n: l.runs }, l.runs);
const nextText = (l: RunLane) =>
  l.next !== null
    ? t('runTimeline.next', { when: tickLabelFull(l.next) })
    : t('runTimeline.noNext');
const tickLabelFull = (unix: number) =>
  new Date(unix * 1000).toLocaleString('en', {
    weekday: props.range === '7d' ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const MARK: Record<MarkKind, string> = {
  success: 'bg-ok',
  failed: 'bg-critical',
  slow: 'bg-warning',
  missed: 'border-2 border-critical bg-transparent',
  unknown: 'bg-text-subtle',
  running: 'bg-info',
  next: 'border border-dashed border-text-muted bg-transparent',
};
const link = (l: RunLane, m?: RunMark) => ({
  name: 'scheduled-job',
  params: { jobId: l.job.id },
  query: {
    ...(l.job.node ? { node: l.job.node } : {}),
    ...(m && m.kind !== 'next' ? { run: String(m.at) } : {}),
  },
});
const columns = 'grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,9rem)]';
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="run-timeline">
    <ErrorState
      v-if="error"
      inline
      :message="$t('runTimeline.error')"
      :retrying="loading"
      @retry="load"
    />
    <div v-else-if="!data" class="flex flex-col gap-2" :aria-label="$t('common.loading')">
      <Skeleton v-for="i in 4" :key="i" shape="rect" class="h-7 w-full" />
    </div>
    <template v-else>
      <p v-if="jobs.length === 0" class="text-14 text-text-muted">
        {{ $t('jobs.empty.filtered') }}
      </p>
      <template v-else>
        <!-- The time axis, over the strips' column. -->
        <div :class="narrow ? '' : ['grid gap-4', columns]" aria-hidden="true">
          <span v-if="!narrow" />
          <div class="relative h-4.5">
            <span
              v-for="(tk, i) in ticks"
              :key="tk.at"
              :class="[
                'absolute top-0 font-mono text-12 whitespace-nowrap text-text-subtle',
                (narrow && i % 2 === 1) || Math.abs(tk.pct - now) < (narrow ? 12 : 5)
                  ? 'hidden'
                  : '',
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
          </div>
          <span v-if="!narrow" />
        </div>

        <ul class="flex flex-col" data-testid="run-lanes">
          <li
            v-for="l in shown"
            :key="`${l.job.node}/${l.job.id}`"
            :class="[
              'border-t border-border py-2 first:border-t-0',
              narrow ? 'flex flex-col gap-1.5' : ['grid items-center gap-4', columns],
            ]"
            data-testid="run-lane"
            :data-state="l.job.state"
          >
            <RouterLink
              :to="link(l)"
              class="group/name flex min-w-0 flex-col justify-center max-lg:min-h-11"
              data-testid="run-lane-name"
            >
              <span
                class="truncate font-mono text-13 font-semibold text-text group-hover/name:underline"
                >{{ laneName(l.job) }}</span
              >
              <span class="truncate text-12 text-text-muted">{{
                say(scheduleWords(l.job.schedule))
              }}</span>
            </RouterLink>
            <!-- Marks are data, a slot wide: on a phone the lane's name is the touch target, and the
                 table below has a full-size row per job. -->
            <div class="relative h-5.5" data-testid="run-strip" data-layout-exempt="touch-target">
              <span class="sr-only">{{ laneText(l) }}</span>
              <span class="absolute inset-x-0 top-2.5 h-px bg-border" aria-hidden="true" />
              <span
                class="absolute inset-y-0 right-0 rounded-r-[4px] bg-surface-2"
                :style="{ left: `${now}%` }"
                aria-hidden="true"
              />
              <span
                class="absolute -inset-y-1 w-0.5 bg-info"
                :style="{ left: `${now}%` }"
                aria-hidden="true"
              />
              <RouterLink
                v-for="m in l.marks"
                :key="`${m.kind}${m.at}`"
                :to="link(l, m)"
                tabindex="-1"
                class="group absolute inset-y-0 flex justify-center"
                :style="{ left: `${m.left}%`, width: `${m.width}%`, minWidth: '3px' }"
                :title="markText(m)"
                :aria-label="markText(m)"
                data-testid="run-mark"
                :data-kind="m.kind"
              >
                <span
                  :class="[
                    'block h-full w-[calc(100%-1px)] min-w-0.75 rounded-[2px] group-hover:opacity-80',
                    MARK[m.kind],
                  ]"
                />
              </RouterLink>
            </div>
            <span
              :class="[
                'flex min-w-0 text-12',
                narrow ? 'flex-row justify-between gap-2' : 'flex-col',
              ]"
            >
              <span :class="l.failures ? 'text-critical-text' : 'text-text'">{{ summary(l) }}</span>
              <span class="truncate text-text-muted">{{ nextText(l) }}</span>
            </span>
          </li>
        </ul>

        <button
          v-if="lanes.length > LANES_SHOWN"
          type="button"
          class="self-start rounded-control px-2 py-1 text-13 font-medium text-link hover:bg-surface-2 max-lg:min-h-11"
          data-testid="run-lanes-all"
          @click="showAll = !showAll"
        >
          {{
            showAll ? $t('runTimeline.showFewer') : $t('runTimeline.showAll', { n: lanes.length })
          }}
        </button>
      </template>
      <p class="text-13 text-text-muted" data-testid="run-legend">
        <span
          v-for="k in ['success', 'failed', 'slow', 'missed', 'unknown', 'next'] as const"
          :key="k"
          class="mr-3 inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <span :class="['inline-block h-3 w-1.5 rounded-[2px]', MARK[k]]" aria-hidden="true" />
          {{ $t(`runTimeline.legend.${k}`) }}
        </span>
      </p>
    </template>
  </div>
</template>
