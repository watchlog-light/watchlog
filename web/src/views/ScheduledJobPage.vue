<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowLeft, CalendarX } from '@lucide/vue';
import type { ScheduledJobDetail } from '@watchlog/api-types';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api, ApiError } from '@/api/client';
import ToneChip from '@/components/applications/ToneChip.vue';
import LogsPanel from '@/components/logs/LogsPanel.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { useLoader } from '@/composables/useLoader';
import {
  JOB_TONE,
  duration,
  jobKind,
  jobName,
  jobProblem,
  scheduleWords,
  type Tone,
  type Words,
} from '@/lib/certs-jobs';
import { formatDateTime, formatWhen } from '@/lib/format';
import { useClustersStore } from '@/stores/clusters';

// A scheduled job's page (0.10, ADR-223, ADR-224): why it is in its state, its schedule, its
// runs (durations as bars, the list, the hourly counts for a frequent job) and, for a systemd
// timer, its unit's log on demand (ADR-167). A cron job's output isn't kept anywhere WatchLog
// can read; a CronJob's runs are pods, on the CronJob's own page.
const { t } = useI18n();
const route = useRoute();
const clusters = useClustersStore();
const jobId = computed(() => String(route.params.jobId));
const node = computed(() => (typeof route.query.node === 'string' ? route.query.node : ''));

const page = useLoader(async () => {
  await clusters.ensure();
  const c = clusters.selected;
  if (!c) return null;
  try {
    const q = node.value ? `?node=${encodeURIComponent(node.value)}` : '';
    const d = await api<ScheduledJobDetail>(`/clusters/${c.id}/scheduled-jobs/${jobId.value}${q}`);
    return { cluster: c, ...d };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});
onMounted(() => void page.load());
watch([jobId, node, () => clusters.selected?.id], () => void page.load());

const j = computed(() => page.data.value?.job ?? null);
const runs = computed(() => page.data.value?.runs ?? []);
const hours = computed(() => page.data.value?.hours ?? []);
const say = (w: Words) => t(w.key, w.values ?? {}, Number(w.values?.n ?? 1));
const TEXT_TONE: Record<Tone, string> = {
  crit: 'text-critical-text',
  warn: 'text-warning-text',
  ok: 'text-text-muted',
  info: 'text-info-text',
  muted: 'text-text-muted',
};
// Opened from a mark on the run timeline (0.13.0): that run is highlighted and scrolled to.
const runAt = computed(() => (typeof route.query.run === 'string' ? Number(route.query.run) : NaN));
const picked = (start: number) =>
  Number.isFinite(runAt.value) && Math.abs(start - runAt.value) < 60;
let scrolled = false;
function scrollOnce(el: unknown) {
  if (scrolled || !(el instanceof HTMLElement)) return;
  scrolled = true;
  el.scrollIntoView?.({ block: 'nearest' });
}
const when = (unix: number) => formatDateTime(new Date(unix * 1000).toISOString());

// The last runs' durations, oldest on the left: failed red, running blue, others green.
const chart = computed(() => {
  const list = [...runs.value].slice(0, 60).reverse();
  const longest = Math.max(1, ...list.map((r) => r.seconds ?? 0));
  return list.map((r, i) => ({
    x: i * 10,
    h: Math.max(3, Math.round(((r.seconds ?? longest * 0.05) / longest) * 56)),
    tone:
      r.result === 'failed'
        ? 'fill-critical'
        : r.result === 'running'
          ? 'fill-info'
          : r.result === 'unknown'
            ? 'fill-text-subtle'
            : 'fill-ok',
    title: `${when(r.startedAt)} · ${r.seconds !== null ? duration(r.seconds) : '–'} · ${t(`jobs.detail.results.${r.result}`)}`,
  }));
});
const hourTotals = computed(() => ({
  runs: hours.value.reduce((n, h) => n + h.runs, 0),
  failures: hours.value.reduce((n, h) => n + h.failures, 0),
  longest: Math.max(0, ...hours.value.map((h) => h.longestSeconds)),
}));
const cronJobWorkload = computed(() => {
  if (!j.value || j.value.kind !== 'cronjob') return null;
  const n = jobName(j.value);
  return { namespace: n.namespace ?? '', name: n.name };
});
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="scheduled-job">
    <RouterLink
      :to="{ name: 'scheduled-jobs' }"
      class="inline-flex min-h-11 w-fit items-center gap-1.5 text-14 text-text-muted hover:text-text"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('jobs.detail.back') }}
    </RouterLink>

    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('jobs.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <SkeletonDetailHeader v-if="page.skeleton.value" :label="$t('common.loading')" />
    <EmptyState
      v-else-if="page.loaded.value && !j"
      :icon="CalendarX"
      :title="$t('jobs.detail.notFound')"
      description=""
    />

    <template v-else-if="j">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-mono text-24 font-semibold break-all text-text">{{ jobName(j).name }}</h1>
          <p class="text-14 text-text-muted">
            {{ say(jobKind(j)) }}<template v-if="j.node"> · {{ j.node }}</template>
          </p>
        </div>
        <ToneChip :tone="JOB_TONE[j.state] ?? 'muted'" :label="$t(`jobs.status.${j.state}`)" />
      </header>

      <p
        v-if="j.state !== 'working'"
        :class="['text-15 font-medium', TEXT_TONE[jobProblem(j).tone]]"
        data-testid="job-problem"
      >
        {{ say(jobProblem(j).words)
        }}<template v-if="j.lastRun?.code !== null && j.lastRun?.result === 'failed'">
          · {{ $t('jobs.detail.exitCodeIs', { code: j.lastRun!.code }) }}</template
        >
      </p>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section class="rounded-card border border-border bg-surface-1 p-4">
          <h2 class="mb-3 text-15 font-semibold text-text">{{ $t('jobs.detail.facts') }}</h2>
          <dl class="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-14">
            <dt class="text-text-muted">{{ $t('jobs.detail.schedule') }}</dt>
            <dd class="text-text">
              {{ say(scheduleWords(j.schedule)) }}
              <span v-if="j.randomDelaySec" class="block text-13 text-text-muted">{{
                $t('jobs.detail.randomDelay', { d: duration(j.randomDelaySec) })
              }}</span>
              <span v-if="j.persistent" class="block text-13 text-text-muted">{{
                $t('jobs.detail.persistent')
              }}</span>
            </dd>
            <dt class="text-text-muted">{{ $t('jobs.detail.written') }}</dt>
            <dd class="font-mono text-13 break-all text-text-muted">{{ j.schedule }}</dd>
            <dt class="text-text-muted">{{ $t('jobs.detail.next') }}</dt>
            <dd class="text-text">
              {{
                j.nextAt
                  ? formatWhen(new Date(j.nextAt * 1000).toISOString())
                  : $t('jobs.schedule.noNext')
              }}
            </dd>
            <dt class="text-text-muted">{{ $t('jobs.detail.lastGood') }}</dt>
            <dd class="text-text">{{ j.lastGoodAt ? when(j.lastGoodAt) : '–' }}</dd>
            <dt class="text-text-muted">{{ $t('jobs.detail.usual') }}</dt>
            <dd class="text-text">
              {{ j.usualSeconds !== null ? duration(j.usualSeconds) : '–' }}
            </dd>
            <template v-if="j.unit">
              <dt class="text-text-muted">{{ $t('jobs.detail.unit') }}</dt>
              <dd class="font-mono text-text">{{ j.unit }}</dd>
            </template>
            <template v-if="j.source && j.kind === 'cron'">
              <dt class="text-text-muted">{{ $t('jobs.detail.source') }}</dt>
              <dd class="font-mono text-text">{{ j.source }}</dd>
            </template>
            <template v-if="cronJobWorkload">
              <dt class="text-text-muted">{{ $t('jobs.detail.namespace') }}</dt>
              <dd class="font-mono text-text">{{ cronJobWorkload.namespace }}</dd>
            </template>
          </dl>
        </section>

        <section
          class="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
        >
          <h2 class="text-15 font-semibold text-text">{{ $t('jobs.detail.runs') }}</h2>
          <p v-if="runs.length === 0" class="text-14 text-text-muted">
            {{ $t('jobs.detail.noRuns') }}
          </p>
          <template v-else>
            <svg
              class="w-full"
              :viewBox="`0 0 ${Math.max(600, chart.length * 10)} 60`"
              preserveAspectRatio="none"
              height="60"
              role="img"
              :aria-label="$t('jobs.detail.runsChart')"
              data-testid="runs-chart"
            >
              <rect
                v-for="(b, i) in chart"
                :key="i"
                :x="b.x"
                :y="60 - b.h"
                width="7"
                :height="b.h"
                rx="1.5"
                :class="b.tone"
              >
                <title>{{ b.title }}</title>
              </rect>
            </svg>
            <p class="text-12 text-text-muted">{{ $t('jobs.detail.runsChart') }}</p>
            <div class="max-h-80 overflow-y-auto">
              <table class="w-full text-left text-13" data-testid="runs">
                <thead class="text-11 tracking-wider text-text-muted uppercase">
                  <tr>
                    <th class="py-1.5 pr-3 font-medium">{{ $t('jobs.detail.started') }}</th>
                    <th class="py-1.5 pr-3 font-medium">{{ $t('jobs.detail.duration') }}</th>
                    <th class="py-1.5 pr-3 font-medium">{{ $t('jobs.detail.result') }}</th>
                    <th class="py-1.5 font-medium">{{ $t('jobs.detail.exitCode') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in runs"
                    :key="r.startedAt"
                    :ref="(el) => picked(r.startedAt) && scrollOnce(el)"
                    :class="['border-t border-border', picked(r.startedAt) ? 'bg-info/10' : '']"
                    :aria-current="picked(r.startedAt) ? 'true' : undefined"
                    data-testid="run-row"
                  >
                    <td class="py-1.5 pr-3 text-text tabular-nums">{{ when(r.startedAt) }}</td>
                    <td class="py-1.5 pr-3 font-mono whitespace-nowrap text-text-muted">
                      {{ r.seconds !== null ? duration(r.seconds) : '–' }}
                    </td>
                    <td
                      :class="[
                        'py-1.5 pr-3',
                        r.result === 'failed'
                          ? 'text-critical-text'
                          : r.result === 'running'
                            ? 'text-info-text'
                            : 'text-text',
                      ]"
                    >
                      {{ $t(`jobs.detail.results.${r.result}`) }}
                    </td>
                    <td class="py-1.5 font-mono text-text-muted">{{ r.code ?? '–' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <p v-if="j.frequent && hours.length" class="text-13 text-text-muted" data-testid="hours">
            {{ $t('jobs.detail.hours') }}:
            {{
              $t('jobs.detail.hoursSummary', {
                runs: hourTotals.runs.toLocaleString('en'),
                failures: hourTotals.failures.toLocaleString('en'),
                d: duration(hourTotals.longest),
              })
            }}
          </p>
        </section>
      </div>

      <section v-if="j.kind === 'timer' && j.unit && j.node" class="flex flex-col gap-2">
        <LogsPanel
          :key="`${j.node}/${j.unit}`"
          kind="workload"
          :cluster-id="page.data.value!.cluster.id"
          :host="j.node"
          :workload="`service:${j.unit}`"
        />
      </section>
      <p v-else-if="j.kind === 'cron'" class="text-14 text-text-muted">
        {{ $t('jobs.detail.logsCron') }}
      </p>
      <p v-else-if="cronJobWorkload" class="text-14 text-text-muted">
        {{ $t('jobs.detail.logsKube') }}
        <RouterLink
          :to="{
            name: 'workloads',
            query: {
              wkind: 'CronJob',
              wname: cronJobWorkload.name,
              wns: cronJobWorkload.namespace,
            },
          }"
          class="ml-1 text-link hover:underline"
          >{{ $t('jobs.detail.openWorkload') }}</RouterLink
        >
      </p>
    </template>
  </div>
</template>
