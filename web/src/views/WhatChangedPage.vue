<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Hourglass, Radar } from '@lucide/vue';
import type { Cluster, WhatChanged } from '@watchlog/api-types';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { usePolling } from '@/composables/usePolling';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import WhatChangedCauseCard from '@/components/what-changed/WhatChangedCauseCard.vue';
import WhatChangedChart from '@/components/what-changed/WhatChangedChart.vue';
import WhatChangedLearning from '@/components/what-changed/WhatChangedLearning.vue';
import WhatChangedRows from '@/components/what-changed/WhatChangedRows.vue';
import WhatChangedUpgrade from '@/components/what-changed/WhatChangedUpgrade.vue';
import { useLoader } from '@/composables/useLoader';
import {
  clampCustom,
  customBounds,
  hhmm,
  initialAccess,
  isProFeature,
  MAX_WINDOW_S,
  whatChangedPath,
  whatChangedWindows,
  WHAT_CHANGED_SORTS,
  type WhatChangedAccess,
  type WhatChangedSort,
  type WhatChangedWindow,
} from '@/lib/what-changed';
import { partlyLearning, readyParts } from '@/lib/what-changed-learning';
import { useAuthStore } from '@/stores/auth';
import { useClustersStore } from '@/stores/clusters';
import { usePlanStore } from '@/stores/plan';
import { useWhatChangedLearningStore } from '@/stores/whatChangedLearning';

// What changed (ADR-199, the screen Main): what left its usual range in a cluster or a fleet,
// in the order it happened, with the probable cause underneath. Windows: around an alert (when
// opened from one), the last hour, the last 6 hours, a custom range of at most 24 hours (in
// the demo, within its last 24 hours). Pro only: Cloud Free and Community see the upgrade
// page (ADR-201) in its place. Everything is in the URL, so the alert card links here.
// For the first 7 days the learning page (ADR-216) stands in the list's place; afterwards a
// strip says how many series that joined later still learn. Back from Stripe Checkout
// (`?checkout=done`), the upgrade page asks again every few seconds and turns into the
// learning page the moment Pro is on, without a reload.
const REFRESH_MS = 60_000;
/** After Checkout: how often the page asks whether Pro is on, and for how long. */
const CHECKOUT_POLL_MS = 3_000;
const CHECKOUT_POLL_FOR_MS = 3 * 60_000;
/** While the worker hasn't seen the org yet (the first minute of Pro). */
const STARTING_POLL_MS = 10_000;
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const auth = useAuthStore();
const clusters = useClustersStore();
const plan = usePlanStore();
const sidebar = useWhatChangedLearningStore();

const num = (v: unknown) => {
  const n = Number(v);
  return typeof v === 'string' && v !== '' && Number.isFinite(n) ? Math.floor(n) : undefined;
};
const alertId = computed(() =>
  typeof route.query.alert === 'string' && route.query.alert ? route.query.alert : undefined,
);
const windows = computed(() => whatChangedWindows(!!alertId.value));
const win = computed<WhatChangedWindow>(() => {
  const w = String(route.query.window ?? '');
  if ((windows.value as string[]).includes(w)) return w as WhatChangedWindow;
  return alertId.value ? 'alert' : '1h';
});
const sort = computed<WhatChangedSort>(() =>
  route.query.sort === 'furthest' ? 'furthest' : 'first',
);
/** The custom range, made valid (at most 24 hours; in the demo, within its last 24 hours). */
const custom = computed(() => {
  const now = Date.now();
  const to = num(route.query.to) ?? Math.floor(now / 1000);
  const from = num(route.query.from) ?? to - MAX_WINDOW_S;
  return (
    clampCustom(from, to, auth.demoMode, now) ?? {
      from: Math.floor(now / 1000) - 3600,
      to: Math.floor(now / 1000),
    }
  );
});

const access = ref<WhatChangedAccess | null>(initialAccess(auth.isCloud, auth.demoMode));
const page = useLoader(async () => {
  const cluster: Cluster | null = await clusters.ensure();
  if (!cluster) return { cluster: null, answer: null };
  if (access.value === 'community') return { cluster, answer: null };
  try {
    const answer = await api<WhatChanged>(
      whatChangedPath(cluster.id, {
        window: win.value,
        ...(alertId.value ? { alert: alertId.value } : {}),
        ...(win.value === 'custom' ? custom.value : {}),
        sort: sort.value,
      }),
    );
    access.value = 'pro';
    // The sidebar's "day 3/7" follows the page.
    sidebar.set(cluster.id, answer.learning);
    return { cluster, answer };
  } catch (err) {
    if (isProFeature(err)) {
      access.value = 'free';
      return { cluster, answer: null };
    }
    throw err;
  }
});
const cluster = computed(() => page.data.value?.cluster ?? null);
const answer = computed(() => page.data.value?.answer ?? null);
const docker = computed(() => cluster.value?.kind === 'server');
const platform = computed(() => (docker.value ? 'docker' : 'kubernetes'));

function setQuery(patch: Record<string, string | undefined>) {
  void router.replace({ query: { ...route.query, ...patch } });
}
function pickWindow(w: WhatChangedWindow) {
  if (w === 'custom') {
    const c = custom.value;
    setQuery({ window: w, from: String(c.from), to: String(c.to) });
  } else {
    setQuery({
      window: w === (alertId.value ? 'alert' : '1h') ? undefined : w,
      from: undefined,
      to: undefined,
    });
  }
}
function windowLabel(w: WhatChangedWindow) {
  if (w !== 'alert') return t(`whatChanged.windows.${w}`);
  const at = answer.value?.window.alert?.startedAt;
  return at ? t('whatChanged.windows.alertAt', { time: hhmm(at) }) : t('whatChanged.windows.alert');
}

// The custom range's inputs: local date and time, as <input type="datetime-local"> reads it.
const pad = (n: number) => String(n).padStart(2, '0');
function localInput(s: number) {
  const d = new Date(s * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const bounds = computed(() => customBounds(auth.demoMode));
function onCustom(which: 'from' | 'to', e: Event) {
  const v = (e.target as HTMLInputElement).value;
  const s = Math.floor(new Date(v).getTime() / 1000);
  if (!Number.isFinite(s)) return;
  const next = { ...custom.value, [which]: s };
  // Moving one end past 24 hours from the other moves the other with it.
  if (which === 'from' && next.to - next.from > MAX_WINDOW_S) next.to = next.from + MAX_WINDOW_S;
  if (which === 'to' && next.to - next.from > MAX_WINDOW_S) next.from = next.to - MAX_WINDOW_S;
  const c = clampCustom(next.from, next.to, auth.demoMode);
  if (c) setQuery({ window: 'custom', from: String(c.from), to: String(c.to) });
}

const countLine = computed(() => {
  const a = answer.value;
  if (!a || !a.rows.length) return '';
  const starts = a.rows.map((r) => r.since).sort();
  const first = hhmm(starts[0]!);
  const last = hhmm(starts[starts.length - 1]!);
  if (a.total === 1) return t('whatChanged.count.one', { at: first });
  return first === last
    ? t('whatChanged.count.at', { n: a.total, at: first })
    : t('whatChanged.count.between', { n: a.total, from: first, to: last });
});
const learning = computed(() => !!answer.value?.learning.learning);
/** The list is on, and some series that joined later still learn: the strip's line. */
const partly = computed(() => {
  const l = answer.value?.learning;
  if (!l || !partlyLearning(l)) return '';
  const at = readyParts(Date.parse(l.series.readyAt!));
  return t(
    'whatChanged.learn.strip',
    {
      n: l.series.learning.toLocaleString('en'),
      total: (l.series.total ?? l.series.learning).toLocaleString('en'),
      ...at,
    },
    l.series.learning,
  );
});

// Back from Stripe Checkout (the router brings the browser here, ADR-216).
const checkoutReturn = computed(() => {
  const c = route.query.checkout;
  return c === 'done' || c === 'cancelled' ? c : null;
});
let fast: ReturnType<typeof setTimeout> | undefined;
let fastUntil = 0;
/** Asks again soon while something is about to change: Pro after Checkout, or the first minute. */
function planFast() {
  clearTimeout(fast);
  const waitingForPro = checkoutReturn.value === 'done' && access.value === 'free';
  const starting = access.value === 'pro' && !!answer.value && !answer.value.learning.since;
  if (!waitingForPro && !starting) return;
  if (!fastUntil) fastUntil = Date.now() + CHECKOUT_POLL_FOR_MS;
  if (Date.now() > fastUntil) return;
  fast = setTimeout(
    async () => {
      if (document.visibilityState !== 'hidden') await page.load();
      planFast();
    },
    waitingForPro ? CHECKOUT_POLL_MS : STARTING_POLL_MS,
  );
}
watch([access, () => answer.value?.learning.since, checkoutReturn], planFast);
// Pro is on: the query has done its work, and the shell's plan strip should say Pro too.
watch(access, (a, was) => {
  if (a === 'pro' && was === 'free' && checkoutReturn.value) {
    void plan.load();
    setQuery({ checkout: undefined });
  }
});
onBeforeUnmount(() => clearTimeout(fast));

watch([win, sort, custom, alertId], () => void page.load());
// Paused while the tab is hidden, spread by ±20 % (ADR-206).
const poll = usePolling(() => page.load(), REFRESH_MS);
onMounted(async () => {
  poll.start();
  await page.load();
  planFast();
});
</script>

<template>
  <div class="mx-auto flex w-full max-w-6xl flex-col">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('whatChanged.errors.load')"
      :retrying="page.loading.value"
      class="mb-4"
      @retry="page.load"
    />
    <div v-if="page.skeleton.value" class="flex flex-col gap-4" data-testid="wc-skeleton">
      <Skeleton shape="rect" class="h-10 w-full sm:max-w-xl" />
      <Skeleton shape="rect" class="h-96 w-full" />
    </div>

    <template v-else-if="page.loaded.value">
      <EmptyState
        v-if="!cluster"
        :icon="Radar"
        :title="$t('whatChanged.empty.noCluster.title')"
        :description="$t('whatChanged.empty.noCluster.description')"
        :action-label="$t('empty.connectCluster')"
        action-to="/settings"
      />

      <!-- Cloud Free and Community: the upgrade page (ADR-201). -->
      <WhatChangedUpgrade
        v-else-if="access === 'free' || access === 'community'"
        :access="access"
        :cluster="cluster"
        :checkout-return="checkoutReturn"
      />

      <template v-else-if="answer">
        <header class="mb-6 flex flex-wrap items-center justify-between gap-4 max-md:mb-4">
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 class="text-20 font-semibold text-text" data-testid="wc-title">
              {{ $t('whatChanged.title') }}
            </h2>
            <span class="text-14 text-text-muted" data-testid="wc-cluster"
              >{{ cluster.name }}
              <span class="text-text-subtle"
                >· {{ $t(`whatChanged.platform.${platform}`) }}</span
              ></span
            >
            <span
              class="inline-flex h-5.5 items-center rounded-full border border-info/50 px-2.5 text-12 font-semibold text-info"
              >{{ $t('whatChanged.pro') }}</span
            >
          </div>
          <div
            v-if="!learning"
            class="flex flex-wrap gap-1 rounded-card border border-border bg-surface-1/60 p-1"
            role="group"
            :aria-label="$t('whatChanged.windows.label')"
            data-testid="wc-windows"
          >
            <button
              v-for="w in windows"
              :key="w"
              type="button"
              :class="[
                'rounded-control px-3.5 py-2 text-13 max-lg:min-h-11',
                win === w
                  ? 'bg-surface-3 font-semibold text-text'
                  : 'text-text-muted hover:text-text',
              ]"
              :aria-pressed="win === w"
              :data-testid="`wc-window-${w}`"
              @click="pickWindow(w)"
            >
              {{ windowLabel(w) }}
            </button>
          </div>
        </header>

        <div
          v-if="win === 'custom' && !learning"
          class="mb-5 flex flex-wrap items-end gap-3 text-13 text-text-muted"
          data-testid="wc-custom"
        >
          <label class="flex flex-col gap-1">
            {{ $t('whatChanged.custom.from') }}
            <input
              type="datetime-local"
              class="wc-input"
              :value="localInput(custom.from)"
              :min="bounds.min !== null ? localInput(bounds.min) : undefined"
              :max="localInput(bounds.max)"
              data-testid="wc-custom-from"
              @change="onCustom('from', $event)"
            />
          </label>
          <label class="flex flex-col gap-1">
            {{ $t('whatChanged.custom.to') }}
            <input
              type="datetime-local"
              class="wc-input"
              :value="localInput(custom.to)"
              :min="bounds.min !== null ? localInput(bounds.min) : undefined"
              :max="localInput(bounds.max)"
              data-testid="wc-custom-to"
              @change="onCustom('to', $event)"
            />
          </label>
          <span class="pb-2.5">{{
            $t(auth.demoMode ? 'whatChanged.custom.demo' : 'whatChanged.custom.max')
          }}</span>
        </div>

        <!-- The first 7 days (ADR-204, ADR-216): the learning page in the list's place. -->
        <WhatChangedLearning
          v-if="learning"
          :cluster="cluster"
          :learning="answer.learning"
          @changed="page.load"
        />

        <section
          v-else
          class="flex flex-col gap-5.5 rounded-2xl border border-border bg-surface-1/45 p-7 max-md:gap-4.5 max-md:p-4"
          aria-labelledby="wc-hero"
          data-testid="wc-hero"
        >
          <div
            class="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-12 tracking-widest uppercase md:text-13"
          >
            <span id="wc-hero" class="text-text">{{ $t('whatChanged.hero.title') }}</span>
            <span class="text-text-subtle">{{ $t('whatChanged.hero.scope') }}</span>
          </div>

          <WhatChangedChart :answer="answer" />

          <!-- The list is on; some series that joined later still learn (ADR-216). -->
          <p
            v-if="partly"
            class="flex items-start gap-3 rounded-card border border-border bg-surface-1 px-4.5 py-3 text-14 text-text-muted max-md:px-4"
            data-testid="wc-partly"
          >
            <Hourglass class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <span>{{ partly }}</span>
          </p>

          <template v-if="answer.rows.length">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <span class="text-14 text-text-muted" data-testid="wc-count">{{ countLine }}</span>
              <div
                class="flex gap-1"
                role="group"
                :aria-label="$t('whatChanged.sort.label')"
                data-testid="wc-sort"
              >
                <button
                  v-for="s in WHAT_CHANGED_SORTS"
                  :key="s"
                  type="button"
                  :class="[
                    'rounded-card border px-3.5 py-2 text-13 max-lg:min-h-11',
                    sort === s
                      ? 'border-border-strong bg-surface-3 font-semibold text-text'
                      : 'border-border text-text-muted hover:border-border-strong hover:text-text',
                  ]"
                  :aria-pressed="sort === s"
                  :data-testid="`wc-sort-${s}`"
                  @click="setQuery({ sort: s === 'first' ? undefined : s })"
                >
                  {{ $t(`whatChanged.sort.${s}`) }}
                </button>
              </div>
            </div>
            <WhatChangedRows :rows="answer.rows" :cluster-id="cluster.id" />
            <p v-if="answer.truncated" class="text-13 text-text-muted" data-testid="wc-more">
              {{ $t('whatChanged.more', { n: answer.total - answer.rows.length }) }}
            </p>
          </template>

          <div
            v-else
            class="flex flex-col items-start gap-1 rounded-card border border-dashed border-border px-5 py-4.5 max-md:px-4"
            data-testid="wc-empty"
          >
            <p class="text-16 font-medium text-text">{{ $t('whatChanged.empty.none.title') }}</p>
            <p class="text-14 text-text-muted">
              {{ $t(`whatChanged.empty.none.${platform}`) }}
            </p>
          </div>
        </section>

        <template v-if="!answer.learning.learning && answer.rows.length">
          <div class="flex justify-center" aria-hidden="true">
            <span class="h-14 w-px bg-warning/70 max-md:h-8" />
          </div>
          <WhatChangedCauseCard
            :key="answer.cause.subject ?? 'none'"
            :cluster-id="cluster.id"
            :cluster-name="cluster.name"
            :subject="answer.cause.subject"
            :platform="platform"
          />
        </template>

        <p
          class="mt-5 flex flex-wrap items-center gap-x-1.5 px-1 text-13 leading-relaxed text-text-subtle"
          data-testid="wc-footnote"
        >
          {{ learning ? $t('whatChanged.learn.footnote') : $t('whatChanged.footnote') }}
          <LoadingIndicator :active="page.refreshing.value" class="ml-1" />
        </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.wc-input {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-1);
  color: var(--text);
  font-size: 13px;
  padding: 7px 10px;
  color-scheme: dark;
}
.wc-input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
@media (max-width: 1023px) {
  .wc-input {
    min-height: 44px;
  }
}
</style>
