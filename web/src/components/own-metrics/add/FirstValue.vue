<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Waiting for a token's first value, then saying it arrived (1.0.3). While the tab is visible
// the page asks every few seconds what the token has sent; when something has, it says what
// (the name, the value when the server still has it, what it belongs to) and offers the next
// steps. Two minutes without anything: a short list of what to check.
import type { OwnMetricsSummary, OwnReceived } from '@watchlog/api-types';
import { Check } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import { usePolling } from '@/composables/usePolling';
import { num, ownerText, sinceWords } from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';

/** The metric "Send a test value for me" sends (the backend's TEST_METRIC). */
const TEST_METRIC = 'my_first_test_value';
const LATE_MS = 120_000;

const props = withDefaults(
  defineProps<{
    cluster: string;
    summary: OwnMetricsSummary;
    /** The token watched: the one made here, or an older one the user chose. */
    tokenId: string | null;
    /** A token made in this page has sent nothing before: everything it sent counts. */
    fresh: boolean;
    way: 'push' | 'prometheus';
    /** Why the page's own test value wasn't stored, when it wasn't. */
    refused?: 'sources' | 'series' | null;
    now?: () => number;
    everyMs?: number;
  }>(),
  { refused: null, now: Date.now, everyMs: 4000 },
);
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const auth = useAuthStore();

type Got = NonNullable<OwnReceived['received']>;
const got = ref<Got | null>(null);
const since = ref<number | undefined>(undefined);
const startedAt = ref(props.now());
const clock = ref(props.now());
const removed = ref(false);
const removing = ref(false);
const error = ref('');

async function look() {
  clock.value = props.now();
  if (!props.tokenId) return;
  const id = props.tokenId;
  const r = await ownMetricsApi.received(props.cluster, id, since.value);
  if (id !== props.tokenId) return;
  // An older token: only what arrives from now on is "the first value" of this visit.
  if (since.value === undefined) {
    since.value = props.fresh ? 0 : r.now;
    if (!props.fresh) return;
  }
  if (r.received && (!got.value || r.received.at >= got.value.at)) {
    if (!got.value || r.received.at !== got.value.at || r.received.name !== got.value.name)
      emit('changed');
    got.value = r.received;
    removed.value = false;
  } else if (!r.received && got.value) {
    got.value = null;
  }
}
const poll = usePolling(look, props.everyMs);
watch(
  () => props.tokenId,
  (id) => {
    got.value = null;
    since.value = undefined;
    startedAt.value = props.now();
    removed.value = false;
    poll.stop();
    if (id) {
      void look().catch(() => undefined);
      poll.start();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => poll.stop());
/** Asked at once after the page itself sent something. */
defineExpose({ look });

const late = computed(() => !got.value && clock.value - startedAt.value >= LATE_MS);
const isTest = computed(() => got.value?.name === TEST_METRIC);
const ago = computed(() => {
  const s = Math.max(0, (clock.value - (got.value?.at ?? 0)) / 1000);
  return s < 20
    ? t('ownMetrics.add.first.moment')
    : t('ownMetrics.add.first.ago', { t: sinceWords(s) });
});
const where = computed(() => {
  const o = got.value ? ownerText(got.value.owner) : null;
  return o
    ? t('ownMetrics.add.first.for', { owner: o, ago: ago.value })
    : t('ownMetrics.add.first.untied', { ago: ago.value });
});
const headline = computed(() => {
  const g = got.value;
  if (!g) return '';
  if (g.way === 'remote_write')
    return t(
      'ownMetrics.add.first.receivedSamples',
      { n: g.series, metrics: g.metrics, name: g.name },
      g.series,
    );
  return g.value === null
    ? t('ownMetrics.add.first.receivedNoValue', { name: g.name })
    : t('ownMetrics.add.first.received', { name: g.name, value: num(g.value) });
});
const alerts = computed(() => props.summary.limits.alerts !== 'none');
const metricQuery = computed(() => ({
  cluster: props.cluster,
  tab: 'metrics',
  metric: got.value?.metricId,
}));

async function removeTest() {
  removing.value = true;
  error.value = '';
  try {
    await ownMetricsApi.removeTestValue(props.cluster);
    got.value = null;
    removed.value = true;
    startedAt.value = props.now();
    emit('changed');
  } catch (err) {
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.add.failed');
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <div v-if="tokenId || refused" class="flex flex-col gap-3" data-testid="own-first">
    <p
      v-if="refused"
      class="rounded-card border border-warning/50 bg-warning/10 px-4 py-3 text-13 leading-relaxed text-text"
      role="alert"
      data-testid="own-first-refused"
    >
      {{
        $t(`ownMetrics.add.first.refused.${refused}`, {
          max:
            refused === 'sources'
              ? summary.limits.sources
              : summary.limits.series.toLocaleString('en-US'),
        })
      }}
    </p>

    <!-- Received -->
    <div
      v-if="got"
      class="rounded-card border border-ok/50 bg-ok/10 px-4 py-3.5"
      role="status"
      data-testid="own-first-received"
    >
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-14 text-text">
        <Check class="size-[18px] shrink-0 text-ok-text" aria-hidden="true" />
        <span class="font-semibold break-all" data-testid="own-first-headline">{{ headline }}</span>
        <span class="text-text-muted">{{ where }}</span>
      </p>
      <p v-if="isTest" class="mt-1.5 text-13 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.add.first.isTest') }}
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <RouterLink
          :to="{ name: 'your-metrics', query: metricQuery }"
          class="inline-flex min-h-9 items-center rounded-control bg-primary px-3.5 text-14 font-semibold text-on-primary hover:bg-primary-hover max-lg:min-h-11"
          data-testid="own-first-open"
          >{{ $t('ownMetrics.add.first.open') }}</RouterLink
        >
        <RouterLink
          v-if="auth.canManage"
          :to="{ name: 'your-metrics', query: { ...metricQuery, add: 'dashboard' } }"
          class="inline-flex min-h-9 items-center rounded-control border border-border-strong px-3.5 text-14 text-text hover:bg-surface-2 max-lg:min-h-11"
          data-testid="own-first-dashboard"
          >{{ $t('ownMetrics.add.first.dashboard') }}</RouterLink
        >
        <RouterLink
          v-if="auth.canManage && alerts"
          :to="{ name: 'your-metrics', query: { cluster, tab: 'alerts', alert: got.metricId } }"
          class="inline-flex min-h-9 items-center rounded-control border border-border-strong px-3.5 text-14 text-text hover:bg-surface-2 max-lg:min-h-11"
          data-testid="own-first-alert"
          >{{ $t('ownMetrics.add.first.alert') }}</RouterLink
        >
        <span
          v-else-if="!alerts"
          class="inline-flex min-h-9 items-center text-13 text-text-muted"
          data-testid="own-first-alert-locked"
          >{{ $t('ownMetrics.add.first.alertLocked') }}</span
        >
        <BaseButton
          v-if="isTest && auth.canManage"
          variant="ghost"
          :loading="removing"
          data-testid="own-first-remove"
          @click="removeTest"
        >
          {{ $t('ownMetrics.add.first.removeTest') }}
        </BaseButton>
      </div>
    </div>

    <!-- Waiting -->
    <div
      v-else-if="tokenId"
      class="flex items-start gap-3 rounded-card border border-warning/50 bg-warning/10 px-4 py-3.5 text-14"
      role="status"
      data-testid="own-first-waiting"
    >
      <span
        class="mt-1.5 size-2.5 shrink-0 animate-pulse rounded-full bg-warning motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span class="min-w-0">
        <span class="font-semibold text-text">{{
          $t(
            way === 'push' ? 'ownMetrics.add.first.waiting' : 'ownMetrics.add.first.waitingSamples',
          )
        }}</span>
        <span class="text-text-muted">
          {{
            removed
              ? $t('ownMetrics.add.first.removed')
              : $t(
                  way === 'push'
                    ? 'ownMetrics.add.first.waitingSub'
                    : 'ownMetrics.add.first.waitingSamplesSub',
                )
          }}</span
        >
      </span>
    </div>

    <!-- Two minutes, nothing: what to check -->
    <div
      v-if="late"
      class="rounded-card border border-border bg-surface-2 px-4 py-3.5 text-13 leading-relaxed text-text-muted"
      data-testid="own-first-late"
    >
      <p class="font-semibold text-text">{{ $t('ownMetrics.add.first.late.title') }}</p>
      <ol class="mt-2 flex list-decimal flex-col gap-1.5 pl-5">
        <li>{{ $t('ownMetrics.add.first.late.token') }}</li>
        <li>{{ $t('ownMetrics.add.first.late.reach', { endpoint: summary.endpoint }) }}</li>
        <li>
          {{ $t('ownMetrics.add.first.late.code') }}
          <ul class="mt-1 flex list-disc flex-col gap-0.5 pl-5">
            <li>{{ $t('ownMetrics.add.first.late.c401') }}</li>
            <li>{{ $t('ownMetrics.add.first.late.c400') }}</li>
            <li>{{ $t('ownMetrics.add.first.late.c429') }}</li>
            <li>{{ $t('ownMetrics.add.first.late.c200') }}</li>
          </ul>
        </li>
      </ol>
    </div>
    <p v-if="error" class="text-13 text-critical-text" role="alert">{{ error }}</p>
  </div>
</template>
