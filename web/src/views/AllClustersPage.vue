<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Boxes, CircleAlert, CircleCheck, Server } from '@lucide/vue';
import type { AllClusters, OverviewProblem } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import AllClustersUpgrade from '@/components/all-clusters/AllClustersUpgrade.vue';
import AgentUpdateDialog from '@/components/agents/AgentUpdateDialog.vue';
import CauseChip from '@/components/causes/CauseChip.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import SkeletonStatTile from '@/components/ui/SkeletonStatTile.vue';
import { usePolling } from '@/composables/usePolling';
import { useLoader } from '@/composables/useLoader';
import {
  changeView,
  chores,
  clusterLink,
  DEFAULT_RANGE,
  headerLine,
  hero,
  kindLine,
  pct,
  placeLink,
  RANGES,
  sparkPath,
  tiles,
  toneOf,
  type Kind,
  type Tone,
} from '@/lib/all-clusters';
import { EXAMPLE } from '@/lib/all-clusters-example';
import { problemCause, say } from '@/lib/causes';
import { since } from '@/lib/time';
import { formatWhen } from '@/lib/format';
import { useAllClustersStore } from '@/stores/allClusters';

// All clusters and fleets (ADR-226, the design's Main and Healthy boards): every Kubernetes
// cluster and Server fleet of the org on one page, so a Pro user sees at a glance what needs
// attention anywhere. The status sentence, the four tiles, every open problem (the same one in
// two places shown once), the table, What changed across all of them and housekeeping. The
// filter (All · Kubernetes · Server fleets) and the range are in the URL and apply to every
// section. Cloud Free and Community see the same layout with example data, blurred, under the
// upgrade card (ADR-201's pattern).
const REFRESH_MS = 60_000;
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const tr = (key: string, values?: Record<string, unknown>) => t(key, values ?? {});
const store = useAllClustersStore();
/** The cluster whose agents' update dialog is open (Housekeeping, ADR-227). */
const agentsOf = ref<string | null>(null);

const kind = computed<Kind>(() =>
  route.query.kind === 'kubernetes' || route.query.kind === 'server' ? route.query.kind : 'all',
);
const range = computed(() => {
  const n = Number(route.query.range);
  return RANGES.some((r) => r.seconds === n) ? n : DEFAULT_RANGE;
});
const rangeLabel = computed(() => RANGES.find((r) => r.seconds === range.value)!.label);

const page = useLoader(async () => store.fetch(range.value, kind.value));
// Paused while the tab is hidden, spread by ±20 % (ADR-206); only with the page's own data.
const poll = usePolling(() => (store.access === 'pro' ? page.load() : undefined), REFRESH_MS);
watch([range, kind], () => void page.load());
onMounted(() => {
  poll.start();
  void page.load();
});

const locked = computed(() => store.access === 'free' || store.access === 'community');
const lockedAccess = computed(() => (store.access === 'free' ? 'free' : 'community'));
/** What the page draws: the org's own, or the example under the upgrade card. */
const s = computed<AllClusters | null>(() => (locked.value ? EXAMPLE : (page.data.value ?? null)));
const loading = computed(() => !locked.value && !page.loaded.value && !page.error.value);

const offered = computed(() =>
  RANGES.filter((r) => (s.value?.ranges ?? [DEFAULT_RANGE]).includes(r.seconds)),
);
function setQuery(q: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...q } });
}

const top = computed(() => (s.value ? hero(s.value, kind.value, tr) : null));
const tileList = computed(() => (s.value ? tiles(s.value, kind.value, rangeLabel.value, tr) : []));
const choreList = computed(() => (s.value ? chores(s.value.housekeeping, tr) : []));
const filters = computed(() =>
  (['all', 'kubernetes', 'server'] as const).map((k) => ({
    value: k,
    label: t(`allClusters.filter.${k}`),
    count: s.value ? s.value.counts[k] : 0,
  })),
);

const TONE_CHIP: Record<Tone, string> = {
  critical: 'bg-critical/15 text-critical-text',
  warning: 'bg-warning/15 text-warning-text',
  healthy: 'bg-ok/15 text-ok-text',
  muted: 'bg-surface-2 text-text-muted',
};
const TONE_DOT: Record<Tone, string> = {
  critical: 'bg-critical',
  warning: 'bg-warning',
  healthy: 'bg-ok',
  muted: 'bg-text-subtle',
};
const TONE_TEXT: Record<Tone, string> = {
  critical: 'text-critical-text',
  warning: 'text-text-muted',
  healthy: 'text-ok-text',
  muted: 'text-text-muted',
};

function causeOf(p: AllClusters['problems'][number]) {
  const c = problemCause(p as unknown as OverviewProblem);
  return c ? { state: c.state, text: c.line.map((l) => say(tr, l)).join(' · ') } : null;
}
function duration(seconds: number) {
  return since(new Date(Date.now() - seconds * 1000).toISOString());
}
const learningNames = computed(() =>
  (s.value?.whatChanged.learning ?? []).map((l) => l.name).join(', '),
);
</script>

<template>
  <div class="relative flex flex-col" data-testid="all-clusters">
    <!-- Header: the title, the org's counts and the time range. -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4"
      data-testid="ac-header"
    >
      <!-- The title is the top bar's (the shell's h1); here the org's counts. -->
      <span v-if="s" class="text-14 text-text-muted" data-testid="ac-header-line">{{
        headerLine(s, tr)
      }}</span>
      <div
        role="group"
        :aria-label="$t('allClusters.timeRange')"
        class="flex gap-0.5 rounded-[7px] border border-border bg-surface-2 p-0.5 font-mono text-13"
        data-testid="ac-range"
      >
        <button
          v-for="r in offered"
          :key="r.seconds"
          type="button"
          :aria-pressed="range === r.seconds"
          :disabled="locked"
          :class="[
            'rounded-[5px] px-2.5 py-1 max-lg:min-h-11 max-lg:min-w-11',
            range === r.seconds ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text',
          ]"
          @click="setQuery({ range: String(r.seconds) })"
        >
          {{ r.label }}
        </button>
      </div>
    </div>

    <ErrorState
      v-if="page.error.value && !locked"
      class="mt-5"
      :inline="page.loaded.value"
      :message="$t('kube.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />

    <!-- First load: skeletons in the page's layout. -->
    <div
      v-if="loading"
      class="flex flex-col gap-5 pt-6"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="ac-skeleton"
    >
      <Skeleton class="h-12 w-96 max-w-full" />
      <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <div v-for="i in 4" :key="i" class="rounded-[10px] border border-border bg-surface-1 p-4">
          <SkeletonStatTile />
        </div>
      </div>
      <Skeleton class="h-48 w-full rounded-[10px]" />
      <Skeleton class="h-64 w-full rounded-[10px]" />
    </div>

    <div
      v-else-if="s && top"
      :aria-hidden="locked ? 'true' : undefined"
      :inert="locked || undefined"
      :class="[
        'flex flex-col gap-5 pt-6',
        locked ? 'pointer-events-none blur-[5px] select-none opacity-55' : '',
      ]"
      data-testid="ac-content"
    >
      <!-- The status sentence and the filter. -->
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3.5">
        <div class="flex items-center gap-3.5">
          <span
            :class="[
              'flex size-12 shrink-0 items-center justify-center rounded-full',
              top.healthy ? 'bg-ok/15 text-ok-text' : 'bg-critical/15 text-critical-text',
            ]"
            aria-hidden="true"
          >
            <CircleCheck v-if="top.healthy" class="size-6" />
            <CircleAlert v-else class="size-6" />
          </span>
          <div class="flex flex-col gap-0.5">
            <span class="text-24 leading-tight font-semibold text-text" data-testid="ac-hero">{{
              top.title
            }}</span>
            <span v-if="top.sub" class="text-14 text-text-muted" data-testid="ac-hero-sub">{{
              top.sub
            }}</span>
          </div>
        </div>
        <div
          role="group"
          :aria-label="$t('allClusters.show')"
          class="flex gap-1 rounded-[8px] border border-border bg-surface-2 p-1"
          data-testid="ac-filter"
        >
          <button
            v-for="f in filters"
            :key="f.value"
            type="button"
            :aria-pressed="kind === f.value"
            :class="[
              'min-h-9 rounded-[6px] px-3 text-14 max-lg:min-h-11',
              kind === f.value ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text',
            ]"
            @click="setQuery({ kind: f.value === 'all' ? undefined : f.value })"
          >
            {{ f.label }}
            <span class="font-mono text-12 text-text-muted">{{ f.count }}</span>
          </button>
        </div>
      </div>

      <!-- Four tiles. -->
      <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4" data-testid="ac-tiles">
        <div
          v-for="tile in tileList"
          :key="tile.key"
          class="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface-1 p-4"
          :data-testid="`ac-tile-${tile.key}`"
        >
          <span class="text-14 text-text-muted">{{ tile.label }}</span>
          <span class="font-mono text-24 text-text">{{ tile.value }}</span>
          <span :class="['text-13', TONE_TEXT[tile.tone]]">{{ tile.sub }}</span>
        </div>
      </div>

      <!-- Needs attention, everywhere. -->
      <section
        aria-labelledby="ac-na"
        class="flex flex-col rounded-[10px] border border-border bg-surface-1"
        data-testid="ac-attention"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-2.5">
          <h2 id="ac-na" class="text-16 font-semibold text-text">
            {{ $t('allClusters.attention.title') }}
          </h2>
          <span class="text-13 text-text-muted">{{ $t('allClusters.attention.note') }}</span>
        </div>
        <ul v-if="s.problems.length">
          <li
            v-for="p in s.problems"
            :key="p.id"
            class="flex flex-wrap items-start gap-x-4 gap-y-2.5 border-t border-border px-5 py-3.5"
            data-testid="ac-problem"
          >
            <span
              :class="[
                'mt-0.5 shrink-0 rounded-[6px] px-2 py-0.5 text-12 font-semibold whitespace-nowrap',
                TONE_CHIP[p.severity === 'critical' ? 'critical' : 'warning'],
              ]"
              >{{ $t(`allClusters.status.${p.severity}`) }}</span
            >
            <span class="flex min-w-0 flex-[1_1_380px] flex-col gap-1">
              <RouterLink
                :to="placeLink(p.places[0]!)"
                class="text-16 font-semibold break-words text-text hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center"
                data-testid="ac-problem-title"
                >{{ p.title }}</RouterLink
              >
              <span
                v-if="causeOf(p)"
                class="flex flex-wrap items-center gap-1.5 text-14 text-text-muted"
                data-testid="ac-problem-cause"
              >
                <CauseChip :state="causeOf(p)!.state" />
                <span v-if="causeOf(p)!.text" class="break-words">{{ causeOf(p)!.text }}</span>
              </span>
              <span v-else-if="p.why" class="text-14 break-words text-text-muted">{{ p.why }}</span>
            </span>
            <span class="flex flex-wrap items-center gap-1.5">
              <RouterLink
                v-for="pl in p.places"
                :key="pl.cluster.id"
                :to="placeLink(pl)"
                :aria-label="$t('allClusters.attention.open', { name: pl.cluster.name })"
                class="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] border border-border bg-surface-2 px-2 text-13 text-text hover:bg-surface-3 max-lg:min-h-11"
                data-testid="ac-problem-place"
              >
                <component
                  :is="pl.cluster.kind === 'server' ? Server : Boxes"
                  class="size-3.5 text-text-muted"
                  aria-hidden="true"
                />{{ pl.cluster.name }}
              </RouterLink>
            </span>
            <span class="w-16 shrink-0 text-right font-mono text-13 text-text-muted">{{
              p.since ? since(p.since) : ''
            }}</span>
          </li>
        </ul>
        <div
          v-else
          class="flex items-center gap-3.5 border-t border-border px-5 py-7"
          data-testid="ac-attention-none"
        >
          <span
            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok-text"
            aria-hidden="true"
            ><CircleCheck class="size-5"
          /></span>
          <span class="flex flex-col gap-0.5">
            <b class="text-16 text-text">{{ $t('allClusters.attention.none') }}</b>
            <span class="text-14 text-text-muted">{{
              s.lastResolved
                ? $t('allClusters.attention.lastResolved', {
                    title: s.lastResolved.title,
                    name: s.lastResolved.cluster.name,
                    when: formatWhen(s.lastResolved.resolvedAt),
                    duration: duration(s.lastResolved.durationSeconds),
                  })
                : $t('allClusters.attention.noneEver')
            }}</span>
          </span>
        </div>
      </section>

      <!-- Clusters and fleets. -->
      <section
        aria-labelledby="ac-envs"
        class="flex min-w-0 flex-col rounded-[10px] border border-border bg-surface-1"
        data-testid="ac-table"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-2.5">
          <h2 id="ac-envs" class="text-16 font-semibold text-text">
            {{ $t('allClusters.table.title') }}
          </h2>
          <span class="text-13 text-text-muted">{{
            $t('allClusters.table.note', { range: rangeLabel })
          }}</span>
        </div>
        <div class="overflow-x-auto" data-testid="ac-table-scroll">
          <table class="w-full min-w-[880px] border-collapse text-14">
            <thead>
              <tr class="text-left text-12 text-text-muted">
                <th scope="col" class="border-t border-border px-5 py-2 font-medium">
                  {{ $t('allClusters.table.name') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.status') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.reporting') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.cpu') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.memory') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.problems') }}
                </th>
                <th scope="col" class="border-t border-border px-3 py-2 font-medium">
                  {{ $t('allClusters.table.whatChanged') }}
                </th>
                <th scope="col" class="border-t border-border py-2 pr-5 pl-3 font-medium">
                  {{ $t('allClusters.table.alerts', { range: rangeLabel }) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in s.clusters"
                :key="c.id"
                class="hover:bg-surface-2"
                data-testid="ac-row"
              >
                <td class="border-t border-border px-5 py-3">
                  <RouterLink :to="clusterLink(c.id)" class="flex items-center gap-2.5 text-text">
                    <span
                      class="flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-surface-2"
                    >
                      <component
                        :is="c.kind === 'server' ? Server : Boxes"
                        class="size-4 text-text-muted"
                        aria-hidden="true"
                      />
                    </span>
                    <span class="flex flex-col gap-px">
                      <span class="font-semibold">{{ c.name }}</span>
                      <span class="text-12 text-text-muted" data-testid="ac-row-kind">{{
                        kindLine(c, tr)
                      }}</span>
                    </span>
                  </RouterLink>
                </td>
                <td class="border-t border-border px-3 py-3">
                  <span
                    :class="[
                      'inline-block rounded-[6px] px-2 py-0.5 text-12 font-semibold whitespace-nowrap',
                      TONE_CHIP[toneOf(c.status)],
                    ]"
                    data-testid="ac-row-status"
                    >{{ $t(`allClusters.status.${c.status}`) }}</span
                  >
                </td>
                <td class="border-t border-border px-3 py-3 font-mono text-13">
                  <span
                    :class="
                      c.reporting.live < c.reporting.total ? 'text-critical-text' : 'text-text'
                    "
                    data-testid="ac-row-reporting"
                    >{{ c.reporting.live }} / {{ c.reporting.total }}</span
                  >
                </td>
                <td class="border-t border-border px-3 py-3">
                  <span class="flex items-center gap-2.5">
                    <svg
                      width="96"
                      height="28"
                      viewBox="0 0 96 28"
                      role="img"
                      :aria-label="
                        $t('allClusters.table.cpuAria', {
                          range: rangeLabel,
                          value: pct(c.cpu.now),
                        })
                      "
                    >
                      <path
                        :d="sparkPath(c.cpu.points)"
                        fill="none"
                        stroke="currentColor"
                        class="text-info-text"
                        stroke-width="1.6"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <span class="w-10 font-mono text-13">{{ pct(c.cpu.now) }}</span>
                  </span>
                </td>
                <td class="border-t border-border px-3 py-3">
                  <span class="flex items-center gap-2.5">
                    <span class="block h-1.5 w-[72px] rounded-full bg-surface-3">
                      <span
                        :class="[
                          'block h-1.5 rounded-full',
                          (c.memory ?? 0) >= 0.8 ? 'bg-warning' : 'bg-info',
                        ]"
                        :style="{ width: `${Math.round(Math.min(1, c.memory ?? 0) * 100)}%` }"
                      />
                    </span>
                    <span class="font-mono text-13">{{ pct(c.memory) }}</span>
                  </span>
                </td>
                <td class="border-t border-border px-3 py-3 font-mono text-13">
                  <span
                    :class="
                      c.problems.critical + c.problems.warning
                        ? 'font-semibold text-text'
                        : 'text-text-muted'
                    "
                    >{{ c.problems.critical + c.problems.warning }}</span
                  >
                </td>
                <td class="border-t border-border px-3 py-3 text-13">
                  <span v-if="c.whatChanged === null" class="text-text-muted">{{
                    $t('allClusters.table.learning')
                  }}</span>
                  <span v-else-if="c.whatChanged === 0" class="text-text-muted">{{
                    $t('allClusters.table.none')
                  }}</span>
                  <span v-else class="text-info-text">{{
                    $t('allClusters.table.changes', { n: c.whatChanged })
                  }}</span>
                </td>
                <td class="border-t border-border py-3 pr-5 pl-3 font-mono text-13 text-text-muted">
                  {{ c.alerts }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="flex flex-wrap items-stretch gap-5">
        <!-- What changed, across all of them. -->
        <section
          aria-labelledby="ac-wc"
          class="flex min-w-0 flex-[3_1_480px] flex-col rounded-[10px] border border-border bg-surface-1"
          data-testid="ac-changes"
        >
          <div class="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-2.5">
            <h2 id="ac-wc" class="text-16 font-semibold text-text">
              {{ $t('allClusters.changes.title') }}
            </h2>
            <RouterLink
              :to="{ name: 'what-changed' }"
              class="text-13 font-semibold text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
              >{{ $t('allClusters.changes.open') }} →</RouterLink
            >
          </div>
          <ul v-if="s.whatChanged.rows.length">
            <li
              v-for="r in s.whatChanged.rows"
              :key="r.id"
              class="flex items-start gap-3.5 border-t border-border px-5 py-3"
              data-testid="ac-change"
            >
              <span class="w-14 shrink-0 font-mono text-16 font-medium text-info-text">{{
                changeView(r, tr).factor
              }}</span>
              <span class="flex min-w-0 flex-1 flex-col gap-1">
                <RouterLink
                  :to="{ name: 'what-changed', query: { cluster: r.cluster.id } }"
                  class="text-14 font-semibold break-words text-text hover:underline max-lg:flex max-lg:min-h-11 max-lg:items-center"
                  >{{ changeView(r, tr).title }}</RouterLink
                >
                <span class="text-13 text-text-muted">{{ changeView(r, tr).why }}</span>
                <span v-if="r.more" class="text-12 text-text-subtle" data-testid="ac-change-more">{{
                  $t('allClusters.changes.more', { n: r.more }, r.more)
                }}</span>
              </span>
              <span
                class="shrink-0 rounded-[6px] border border-border bg-surface-2 px-2 py-0.5 text-12 text-text-muted"
                >{{ r.cluster.name }}</span
              >
            </li>
          </ul>
          <p
            v-else
            class="border-t border-border p-5 text-14 text-text-muted"
            data-testid="ac-changes-empty"
          >
            {{
              s.whatChanged.learning.length === s.clusters.length && s.clusters.length
                ? $t('allClusters.changes.allLearning')
                : $t('allClusters.changes.empty')
            }}
          </p>
          <p
            v-if="
              s.whatChanged.learning.length && s.whatChanged.learning.length < s.clusters.length
            "
            class="border-t border-border px-5 py-3 text-13 text-text-muted"
            data-testid="ac-changes-learning"
          >
            {{ $t('allClusters.changes.learning', { names: learningNames }) }}
          </p>
        </section>

        <!-- Housekeeping. -->
        <section
          aria-labelledby="ac-hk"
          class="flex min-w-0 flex-[2_1_340px] flex-col rounded-[10px] border border-border bg-surface-1"
          data-testid="ac-chores"
        >
          <div class="px-5 pt-4 pb-2.5">
            <h2 id="ac-hk" class="text-16 font-semibold text-text">
              {{ $t('allClusters.chores.title') }}
            </h2>
          </div>
          <template v-if="choreList.length">
            <template v-for="h in choreList" :key="h.key">
              <!-- Older agents open their update command in place (ADR-227). -->
              <button
                v-if="h.agentsOf"
                type="button"
                class="flex w-full items-start gap-3 border-t border-border px-5 py-3 text-left text-text hover:bg-surface-2"
                data-testid="ac-chore"
                @click="agentsOf = h.agentsOf"
              >
                <span
                  :class="['mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[h.tone]]"
                  aria-hidden="true"
                />
                <span class="flex flex-1 flex-col gap-1">
                  <span class="text-14 font-semibold">{{ h.title }}</span>
                  <span class="text-13 text-text-muted">{{ h.body }}</span>
                </span>
                <span class="shrink-0 text-13 font-semibold text-link">{{ h.action }}</span>
              </button>
              <RouterLink
                v-else
                :to="h.to"
                class="flex items-start gap-3 border-t border-border px-5 py-3 text-text hover:bg-surface-2"
                data-testid="ac-chore"
              >
                <span
                  :class="['mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[h.tone]]"
                  aria-hidden="true"
                />
                <span class="flex flex-1 flex-col gap-1">
                  <span class="text-14 font-semibold">{{ h.title }}</span>
                  <span class="text-13 text-text-muted">{{ h.body }}</span>
                </span>
                <span class="shrink-0 text-13 font-semibold text-link">{{ h.action }}</span>
              </RouterLink>
            </template>
          </template>
          <p v-else class="border-t border-border p-5 text-14 text-text-muted">
            {{ $t('allClusters.chores.none') }}
          </p>
        </section>
      </div>
    </div>

    <AgentUpdateDialog
      v-if="agentsOf"
      :open="!!agentsOf"
      :cluster-id="agentsOf"
      @update:open="(v: boolean) => !v && (agentsOf = null)"
    />

    <!-- Cloud Free and Community: the card over the example. -->
    <div
      v-if="locked"
      class="absolute inset-x-0 top-[140px] flex justify-center px-5 max-sm:top-24 max-sm:px-0"
    >
      <AllClustersUpgrade :access="lockedAccess" />
    </div>
  </div>
</template>
