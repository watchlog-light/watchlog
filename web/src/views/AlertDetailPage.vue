<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import {
  ArrowLeft,
  ArrowUpRight,
  BellRing,
  CircleCheck,
  CircleDot,
  CirclePause,
  Send,
} from '@lucide/vue';
import type { AlertChart as AlertChartData, AlertDetail } from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { api, ApiError } from '@/api/client';
import AlertChart from '@/components/alerts/AlertChart.vue';
import AlertTable from '@/components/alerts/AlertTable.vue';
import SilenceForm from '@/components/alerts/SilenceForm.vue';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import {
  alertTarget,
  alertTargetName,
  alertWhere,
  duration,
  severityTone,
  stateTone,
} from '@/lib/alerts';
import { formatDateTime, formatWhen } from '@/lib/format';
import { RANGE_SECONDS, since } from '@/lib/time';
import type { Tone } from '@/lib/kube';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';

// One alert (SPEC §4.7): what is wrong in plain words and a link to the object, a chart
// of the object around the alert (the rule's chart, rule-charts.ts), a timeline of its
// transitions, the messages sent and the times alerting was not running, and earlier
// episodes of the same rule and scope.
const route = useRoute();
const ui = useUiStore();
const canManage = useAuthStore().canManage;
const { t } = useI18n();
const id = computed(() => String(route.params.id));
const page = useLoader(() => api<AlertDetail>(`/alerts/${id.value}`));
// The time-range picker only ever widens the alert's own window.
const chart = useLoader(() =>
  api<AlertChartData>(`/alerts/${id.value}/chart?range=${RANGE_SECONDS[ui.timeRange]}`),
);
const notFound = computed(
  () => page.error.value instanceof ApiError && page.error.value.status === 404,
);
const silencing = ref(false);

const NOTE_TONE: Record<string, Tone> = {
  sent: 'ok',
  failed: 'critical',
  dropped: 'neutral',
  pending: 'neutral',
  sending: 'neutral',
};

interface Step {
  at: string;
  icon: typeof CircleDot;
  text: string;
  note?: AlertDetail['notifications'][number];
  gap?: AlertDetail['gaps'][number];
}
const steps = computed<Step[]>(() => {
  const d = page.data.value;
  if (!d) return [];
  const a = d.alert;
  const out: Step[] = [{ at: a.startedAt, icon: CircleDot, text: 'started' }];
  if (a.firedAt) out.push({ at: a.firedAt, icon: BellRing, text: 'fired' });
  for (const n of d.notifications)
    out.push({ at: n.sentAt ?? n.createdAt, icon: Send, text: 'note', note: n });
  if (a.resolvedAt) out.push({ at: a.resolvedAt, icon: CircleCheck, text: 'resolved' });
  // Why it fired late: the worker was not running (e.g. 21:45–02:19 on a 0-minute rule).
  for (const g of d.gaps) out.push({ at: g.from, icon: CirclePause, text: 'gap', gap: g });
  return out.sort((x, y) => x.at.localeCompare(y.at));
});
/** "Oct 31, 2026, 21:42 · 18m ago": the app's date format plus relative time. */
const when = (iso: string) =>
  `${formatDateTime(iso)} · ${t('alerts.detail.ago', { d: since(iso) })}`;

function silenced() {
  silencing.value = false;
  void page.load();
}

watch(id, () => {
  void page.load();
  void chart.load();
});
watch(() => ui.timeRange, chart.load);
onMounted(() => {
  void page.load();
  void chart.load();
});
</script>

<template>
  <div class="mx-auto flex max-w-4xl flex-col gap-6">
    <RouterLink
      :to="{ name: 'alerts' }"
      class="inline-flex items-center gap-1.5 text-13 text-text-muted hover:text-text max-lg:min-h-11"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />{{ $t('alerts.detail.back') }}
    </RouterLink>

    <EmptyState
      v-if="notFound"
      :icon="BellRing"
      :title="$t('alerts.detail.notFound.title')"
      :description="$t('alerts.detail.notFound.description')"
      :action-label="$t('alerts.detail.back')"
      :action-to="{ name: 'alerts' }"
    />
    <ErrorState
      v-else-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('alerts.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <template v-if="page.skeleton.value">
      <SkeletonDetailHeader :label="$t('common.loading')" />
      <SkeletonTable :columns="3" :label="$t('common.loading')" />
    </template>

    <template v-else-if="page.data.value">
      <!-- Phones: the pills and Silence first, then the title at full width. -->
      <header
        class="flex flex-wrap items-start gap-4 max-md:flex-col max-md:gap-3"
        data-testid="alert-header"
      >
        <div class="min-w-0 flex-1 max-md:w-full">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 class="text-20 font-semibold break-words text-text" data-testid="alert-title">
              {{ page.data.value.alert.title }}
            </h2>
            <RouterLink
              v-if="alertTarget(page.data.value.alert)"
              :to="alertTarget(page.data.value.alert)!"
              class="inline-flex items-center gap-1 text-13 text-text-muted hover:text-text hover:underline max-lg:min-h-11"
              data-testid="open-target"
            >
              {{ $t('alerts.detail.openObject', { name: alertTargetName(page.data.value.alert) }) }}
              <ArrowUpRight class="size-3.5" aria-hidden="true" />
            </RouterLink>
          </div>
          <p
            v-if="page.data.value.alert.why"
            class="mt-1 text-14 text-text"
            data-testid="alert-why"
          >
            {{ page.data.value.alert.why }}
          </p>
          <p class="mt-1 text-13 break-words text-text-muted">
            {{ page.data.value.alert.rule.name }} · {{ alertWhere(page.data.value.alert) }} ·
            {{ page.data.value.alert.cluster.name }}
          </p>
          <p v-if="page.data.value.alert.podCount > 1" class="mt-1 text-13 text-text-muted">
            {{
              $t(
                'alerts.detail.pods',
                { pods: page.data.value.alert.pods.join(', '), n: page.data.value.alert.podCount },
                page.data.value.alert.podCount,
              )
            }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 max-md:order-first max-md:w-full">
          <TonePill
            :tone="severityTone(page.data.value.alert.severity)"
            :label="$t(`alerts.severity.${page.data.value.alert.severity}`)"
          />
          <TonePill
            :tone="stateTone(page.data.value.alert)"
            :label="$t(`alerts.state.${page.data.value.alert.state}`)"
          />
          <TonePill
            v-if="page.data.value.alert.silenced"
            tone="neutral"
            :label="$t('alerts.silenced')"
          />
          <BaseButton
            v-if="canManage && page.data.value.alert.state !== 'resolved' && !silencing"
            variant="secondary"
            class="max-md:ml-auto"
            data-testid="silence-alert"
            @click="silencing = true"
          >
            {{ $t('alerts.silence.action') }}
          </BaseButton>
        </div>
      </header>

      <SilenceForm
        v-if="silencing"
        :alert="page.data.value.alert"
        @done="silenced"
        @cancel="silencing = false"
      />

      <AlertChart
        :chart="chart.data.value ?? null"
        :severity="page.data.value.alert.severity"
        :loading="chart.loading.value"
        :error="!!chart.error.value"
        @retry="chart.load"
      />

      <section class="rounded-card border border-border bg-surface-1 p-5 max-md:p-4">
        <h3 class="mb-3 text-14 font-semibold text-text">{{ $t('alerts.detail.timeline') }}</h3>
        <ol class="flex flex-col gap-3" data-testid="alert-timeline">
          <!-- Phones: the time next to the icon, what happened below it. -->
          <li
            v-for="(s, i) in steps"
            :key="i"
            class="flex items-start gap-3 text-13 max-md:flex-wrap max-md:gap-y-0.5"
          >
            <component
              :is="s.icon"
              class="mt-0.5 size-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <span class="w-56 shrink-0 text-12 text-text-muted tabular max-md:w-auto max-md:flex-1">
              {{ when(s.at) }}
            </span>
            <span
              v-if="s.gap"
              class="text-text max-md:basis-full max-md:pl-7"
              data-testid="timeline-gap"
            >
              {{
                s.gap.to
                  ? $t('alerts.detail.gap', {
                      from: formatWhen(s.gap.from),
                      to: formatWhen(s.gap.to),
                    })
                  : $t('alerts.detail.gapOpen', { from: formatWhen(s.gap.from) })
              }}
            </span>
            <span v-else-if="!s.note" class="text-text max-md:basis-full max-md:pl-7">
              {{ $t(`alerts.detail.steps.${s.text}`) }}
              <template v-if="s.text === 'resolved' && page.data.value.alert.resolvedAt">
                ·
                {{
                  $t('alerts.detail.after', {
                    d: duration(
                      page.data.value.alert.firedAt ?? page.data.value.alert.startedAt,
                      page.data.value.alert.resolvedAt,
                    ),
                  })
                }}
              </template>
            </span>
            <span
              v-else
              class="flex min-w-0 flex-wrap items-center gap-2 text-text max-md:basis-full max-md:pl-7"
            >
              {{
                $t('alerts.detail.message', {
                  kind: $t(`alerts.kinds.${s.note.kind}`),
                  channel: s.note.channel?.name ?? $t('alerts.detail.deletedChannel'),
                })
              }}
              <TonePill
                :tone="NOTE_TONE[s.note.status] ?? 'neutral'"
                :label="$t(`alerts.delivery.${s.note.status}`)"
              />
              <span v-if="s.note.error" class="text-12 text-text-muted">{{ s.note.error }}</span>
            </span>
          </li>
        </ol>
        <p
          v-if="page.data.value.notifications.length === 0"
          class="mt-3 text-13 text-text-muted"
          data-testid="no-messages"
        >
          {{ $t('alerts.detail.noMessages') }}
        </p>
      </section>

      <section v-if="page.data.value.history.length" class="flex flex-col gap-3">
        <h3 class="text-14 font-semibold text-text">{{ $t('alerts.detail.history') }}</h3>
        <AlertTable :alerts="page.data.value.history" history />
      </section>
    </template>
  </div>
</template>
