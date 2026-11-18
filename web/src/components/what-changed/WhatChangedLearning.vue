<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowRight, Check } from '@lucide/vue';
import type { Alert, AlertList, Cluster, WhatChangedLearning } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import {
  breakdownText,
  dayOf,
  LEARNING_DAYS,
  readyParts,
  remaining,
  remainingText,
} from '@/lib/what-changed-learning';
import { lastAlerts } from '@/lib/what-changed-upgrade';
import { useAuthStore } from '@/stores/auth';
import LearningBrain from './LearningBrain.vue';
import LearningWeekGrid from './LearningWeekGrid.vue';

// The learning week (ADR-216, the screen Learning): what a Pro org sees in place of the list
// for its cluster's or fleet's first 7 days. What is happening, why it takes a week and when
// it is ready, all from the API's answer: when learning started, which hours of the week have
// a baseline, how many series it reads. The day, the ring, the bar, the time to go and
// "Ready on" are all the anomaly-worker's own (ADR-217): the hours it has really learned and
// the moment it will start scoring, never days counted on the calendar. After a gap it says
// when learning resumed.
const props = defineProps<{
  cluster: Cluster;
  learning: WhatChangedLearning;
  /** The clock (tests); the browser's otherwise, read again every half minute. */
  now?: number;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();

const server = computed(() => props.cluster.kind === 'server');
const platform = computed(() => (server.value ? 'server' : 'kubernetes'));

// The countdown's clock: nothing ticks while the tab is hidden.
const clock = ref(props.now ?? Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
  if (props.now === undefined && document.visibilityState !== 'hidden') clock.value = Date.now();
};
watch(
  () => props.now,
  (n) => {
    if (n !== undefined) clock.value = n;
  },
);
onMounted(() => {
  timer = setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', tick);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', tick);
});

const since = computed(() => (props.learning.since ? Date.parse(props.learning.since) : null));
const until = computed(() => (props.learning.until ? Date.parse(props.learning.until) : null));
const day = computed(() => dayOf(props.learning));
const resumed = computed(() =>
  props.learning.resumedAt ? readyParts(Date.parse(props.learning.resumedAt)) : null,
);
const ready = computed(() => (until.value === null ? null : readyParts(until.value)));
const toGo = computed(() =>
  until.value === null ? '' : remainingText(remaining(until.value, clock.value), t),
);
const hours = computed(() => props.learning.hoursLearned);
const total = computed(() => props.learning.hoursTotal);
const share = computed(() => Math.min(100, (hours.value / Math.max(1, total.value)) * 100));

const series = computed(() => props.learning.series);
const breakdown = computed(() => breakdownText(series.value.breakdown, t));
/** The worker reads the first hour when it ends: until then the series aren't counted. */
const firstRead = computed(() => {
  const from = since.value ?? clock.value;
  return readyParts(Math.ceil((from + 1) / 3_600_000) * 3_600_000).time;
});

// "Email me when it's ready": the member's own choice, kept by the server.
const asked = ref(props.learning.emailWhenReady);
const saving = ref(false);
const emailError = ref<string | null>(null);
watch(
  () => props.learning.emailWhenReady,
  (v) => {
    if (!saving.value) asked.value = v;
  },
);
async function toggleEmail() {
  if (saving.value) return;
  saving.value = true;
  emailError.value = null;
  const next = !asked.value;
  try {
    const r = await api<{ emailWhenReady: boolean }>('/what-changed/ready-email', {
      method: 'PUT',
      body: { cluster: props.cluster.id, enabled: next },
    });
    asked.value = r.emailWhenReady;
    emit('changed');
  } catch (err) {
    emailError.value =
      err instanceof ApiError && err.status === 409 && err.problem?.title
        ? err.problem.title
        : t('whatChanged.learn.email.error');
  }
  saving.value = false;
}

const demoUrl = computed(
  () => `${(auth.cloud?.sampleUrl ?? 'https://demo.watchlog.io').replace(/\/$/, '')}/what-changed`,
);

// "Probable cause on every alert" opens the cluster's latest alert, where it is.
const latest = ref<Alert | null>(null);
onMounted(async () => {
  const q = (view: string) =>
    `/alerts?view=${view}&clusterId=${encodeURIComponent(props.cluster.id)}&limit=1`;
  try {
    const [firing, history] = await Promise.all([
      api<AlertList>(q('firing')),
      api<AlertList>(q('history')),
    ]);
    latest.value = lastAlerts(firing.alerts, history.alerts, 1)[0] ?? null;
  } catch {
    latest.value = null; // the link opens the alert list instead
  }
});
const working = computed(() => [
  {
    key: 'alerts',
    to: { name: 'alerts', query: { cluster: props.cluster.id } },
    text: t(`whatChanged.learn.working.alerts.${platform.value}`),
  },
  {
    key: 'cause',
    to: latest.value
      ? { name: 'alert', params: { id: latest.value.id } }
      : { name: 'alerts', query: { cluster: props.cluster.id } },
    text: t('whatChanged.learn.working.cause'),
  },
  {
    key: 'egress',
    to: { name: 'egress', query: { cluster: props.cluster.id } },
    text: t('whatChanged.learn.working.egress'),
  },
  {
    key: 'map',
    to: { name: 'service-map', query: { cluster: props.cluster.id } },
    text: t('whatChanged.learn.working.map'),
  },
]);
const STEPS = ['learning', 'list', 'alerts'] as const;
</script>

<template>
  <div class="flex flex-col gap-5 max-md:gap-4" data-testid="wc-learning" :data-day="day">
    <!-- The centrepiece: the ring above the text on phones, beside it from 768 px. -->
    <section
      class="flex flex-wrap items-center gap-10 rounded-2xl border border-border bg-surface-1/45 p-9 max-md:gap-6 max-md:p-5"
      aria-labelledby="wc-learn-title"
    >
      <div class="mx-auto w-full max-w-[340px] min-w-[220px] flex-[0_1_340px] max-md:max-w-[260px]">
        <LearningBrain
          state="learning"
          :day="day"
          :start="since ?? clock"
          :week="learning.week"
          :now="clock"
        />
      </div>
      <div class="flex min-w-0 flex-[1_1_26rem] flex-col gap-4.5 max-md:gap-3.5">
        <span
          class="font-mono text-12 tracking-widest text-primary uppercase md:text-13"
          data-testid="wc-learn-day"
          >{{ $t('whatChanged.learn.day', { day, days: LEARNING_DAYS }) }}</span
        >
        <h2
          id="wc-learn-title"
          class="text-24 leading-tight font-semibold tracking-tight text-text md:text-32"
        >
          {{ $t('whatChanged.learn.title', { cluster: cluster.name }) }}
        </h2>
        <p class="text-16 leading-relaxed text-text-muted">
          {{ $t(`whatChanged.learn.lead.${platform}`) }}
        </p>
        <p v-if="resumed" class="text-14 text-text-muted" data-testid="wc-learn-resumed">
          {{ $t('whatChanged.learn.resumed', resumed) }}
        </p>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="wc-learn-ready">
          <template v-if="ready">
            <span class="text-20 font-semibold text-text">{{
              $t('whatChanged.learn.ready', ready)
            }}</span>
            <span class="text-14 text-text-muted" data-testid="wc-learn-togo">{{
              $t('whatChanged.learn.toGo', { time: toGo })
            }}</span>
          </template>
          <span v-else class="text-20 font-semibold text-text">{{
            $t('whatChanged.learn.starting')
          }}</span>
        </div>
        <div
          class="h-2 overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-valuemin="0"
          :aria-valuemax="total"
          :aria-valuenow="hours"
          :aria-label="$t('whatChanged.learn.hours.label')"
          data-testid="wc-learn-bar"
        >
          <span class="block h-full rounded-full bg-primary" :style="{ width: `${share}%` }" />
        </div>
        <div class="flex flex-wrap gap-2.5 pt-1">
          <button
            v-if="!auth.demoMode"
            type="button"
            :class="['wl-email', asked ? 'wl-email-on' : '']"
            :aria-pressed="asked"
            :aria-busy="saving"
            :disabled="saving"
            data-testid="wc-learn-email"
            @click="toggleEmail"
          >
            <Check v-if="asked" class="size-4 shrink-0" aria-hidden="true" />
            {{ $t(asked ? 'whatChanged.learn.email.on' : 'whatChanged.learn.email.off') }}
          </button>
          <a
            v-if="!auth.demoMode"
            :href="demoUrl"
            target="_blank"
            rel="noopener"
            class="wl-ghost"
            data-testid="wc-learn-demo"
            >{{ $t('whatChanged.learn.demo')
            }}<span class="sr-only"> {{ $t('whatChanged.upgrade.cta.newTab') }}</span></a
          >
        </div>
        <p v-if="asked && !emailError" class="text-13 text-text-muted" data-testid="wc-learn-undo">
          {{ $t('whatChanged.learn.email.note', { email: auth.user?.email ?? '' }) }}
        </p>
        <p v-if="emailError" class="text-13 text-critical" role="alert" data-testid="wc-learn-err">
          {{ emailError }}
        </p>
      </div>
    </section>

    <!-- Three facts. -->
    <div class="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="wc-learn-tiles">
      <div class="wl-tile" data-testid="wc-tile-series">
        <span class="font-mono text-12 tracking-widest text-text-muted uppercase">{{
          $t('whatChanged.learn.series.label')
        }}</span>
        <span class="text-24 font-semibold text-text tabular">{{
          series.total === null
            ? $t('whatChanged.learn.series.counting')
            : series.total.toLocaleString('en')
        }}</span>
        <span class="text-13 leading-normal text-text-muted">{{
          series.total === null
            ? $t('whatChanged.learn.series.firstRead', { time: firstRead })
            : breakdown || $t(`whatChanged.learn.series.none.${platform}`)
        }}</span>
      </div>
      <div class="wl-tile" data-testid="wc-tile-hours">
        <span class="font-mono text-12 tracking-widest text-text-muted uppercase">{{
          $t('whatChanged.learn.hours.label')
        }}</span>
        <span class="text-24 font-semibold text-text tabular">{{
          $t('whatChanged.learn.hours.value', { n: hours, total })
        }}</span>
        <span class="text-13 leading-normal text-text-muted">{{
          $t('whatChanged.learn.hours.sub')
        }}</span>
      </div>
      <div class="wl-tile" data-testid="wc-tile-togo">
        <span class="font-mono text-12 tracking-widest text-text-muted uppercase">{{
          $t('whatChanged.learn.toGoTile.label')
        }}</span>
        <span class="text-24 font-semibold text-text tabular">{{
          until === null ? $t('whatChanged.learn.toGoTile.week') : toGo
        }}</span>
        <span class="text-13 leading-normal text-text-muted">{{
          $t('whatChanged.learn.toGoTile.sub')
        }}</span>
      </div>
    </div>

    <LearningWeekGrid :week="learning.week" :now="clock" />

    <div class="flex flex-wrap gap-4">
      <section
        class="flex min-w-0 flex-[1_1_26rem] flex-col gap-4 rounded-2xl border border-border bg-surface-1/45 p-6 max-md:p-4"
        aria-labelledby="wc-next-title"
        data-testid="wc-learn-next"
      >
        <h3 id="wc-next-title" class="text-16 font-semibold text-text md:text-20">
          {{ $t('whatChanged.learn.next.title') }}
        </h3>
        <ol class="flex flex-col gap-4">
          <li v-for="(s, i) in STEPS" :key="s" class="flex items-start gap-3.5">
            <span
              :class="[
                'flex size-7 shrink-0 items-center justify-center rounded-full text-13 font-bold',
                i === 0 ? 'bg-primary/15 text-primary' : 'border border-border text-text-muted',
              ]"
              aria-hidden="true"
              >{{ i + 1 }}</span
            >
            <div class="flex min-w-0 flex-col gap-1">
              <span class="text-14 font-semibold text-text md:text-16">{{
                $t(`whatChanged.learn.next.${s}.title`)
              }}</span>
              <span class="text-14 leading-relaxed text-text-muted">{{
                $t(`whatChanged.learn.next.${s}.body`)
              }}</span>
            </div>
          </li>
        </ol>
      </section>
      <section
        class="flex min-w-0 flex-[1_1_26rem] flex-col gap-3 rounded-2xl border border-border bg-surface-1/45 p-6 max-md:p-4"
        aria-labelledby="wc-working-title"
        data-testid="wc-learn-working"
      >
        <h3 id="wc-working-title" class="text-16 font-semibold text-text md:text-20">
          {{ $t('whatChanged.learn.working.title') }}
        </h3>
        <p class="text-14 leading-relaxed text-text-muted">
          {{ $t('whatChanged.learn.working.lead') }}
        </p>
        <RouterLink
          v-for="w in working"
          :key="w.key"
          :to="w.to"
          class="wl-row"
          :data-testid="`wc-working-${w.key}`"
        >
          <span class="min-w-0">{{ w.text }}</span>
          <ArrowRight class="size-4 shrink-0 text-text-subtle" aria-hidden="true" />
        </RouterLink>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wl-email,
.wl-ghost {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 20px;
  border-radius: 10px;
  font-size: 14px;
}
.wl-email {
  background: var(--primary);
  color: var(--on-primary);
  border: 1px solid var(--primary);
  font-weight: 600;
}
.wl-email:hover {
  background: var(--primary-hover);
}
.wl-email:disabled {
  opacity: 0.7;
}
.wl-email-on,
.wl-email-on:hover {
  background: var(--primary-soft);
  color: color-mix(in srgb, var(--primary) 55%, var(--text));
  border-color: var(--primary-glow);
}
.wl-ghost {
  border: 1px solid var(--border);
  color: var(--text-muted);
}
.wl-ghost:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.wl-tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 45%, transparent);
}
.wl-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
}
.wl-row:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
</style>
