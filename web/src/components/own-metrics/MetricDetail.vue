<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// One of a cluster's own metrics (1.0.0, ADR-236): its value now, its line over the selected
// range (split by one label: the top 5 and the rest), its labels, how many series it has, where
// it is used, and what can be done with it: pin it to the page it belongs to; correct its type
// or unit; check it again after a refusal.
import type { OwnMetricDetail, OwnMetricSeries, OwnOwner } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import OwnMetricChart from '@/components/own-metrics/OwnMetricChart.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import { useLoader } from '@/composables/useLoader';
import { useChangeMarkers } from '@/composables/useChangeMarkers';
import { usePolling } from '@/composables/usePolling';
import {
  OWN_TYPES,
  OWN_UNITS,
  outside,
  ownerLink,
  ownerText,
  usualText,
  written,
  type OwnType,
  type OwnUnit,
} from '@/lib/own-metrics';
import type { OwnLine } from '@/lib/own-chart';
import { rangeWindow } from '@/lib/time';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{ cluster: string; metricId: string }>();
const emit = defineEmits<{ changed: []; alert: [metricId: string] }>();
const { t } = useI18n();
const ui = useUiStore();
const auth = useAuthStore();
const toast = useToastStore();

/** The "Nothing" choice of Split by (an empty value reads as no choice at all). */
const NO_SPLIT = '__none__';
const by = ref<string | null>(null);
const span = ref<[number, number]>(rangeWindow(ui.timeRange));

const detail = useLoader<OwnMetricDetail>(() =>
  ownMetricsApi.metric(props.cluster, props.metricId),
);
const series = useLoader<OwnMetricSeries>(() => {
  span.value = rangeWindow(ui.timeRange);
  return ownMetricsApi.series(props.cluster, props.metricId, {
    from: span.value[0],
    to: span.value[1],
    ...(by.value ? { by: by.value } : {}),
  });
});
const load = () => {
  void detail.load();
  void series.load();
};
watch(
  () => [props.cluster, props.metricId],
  () => {
    by.value = null;
    load();
  },
  { immediate: true },
);
watch([by, () => ui.timeRange], () => void series.load());
// Read again every 30 s while the tab is visible.
const poll = usePolling(load, 30_000);
poll.start();

const m = computed(() => detail.data.value?.metric ?? null);
const now = computed(() => (m.value ? written(m.value.value, m.value) : null));
const showing = computed(() => {
  const s = series.data.value;
  return s ? { unit: s.unit, shown: s.shown } : { unit: m.value!.unit, shown: m.value!.shown };
});
const lines = computed<OwnLine[]>(() =>
  (series.data.value?.lines ?? []).map((l) => ({
    name: l.other
      ? t('ownMetrics.detail.other')
      : l.value === null
        ? ''
        : l.value || t('ownMetrics.detail.noValue'),
    points: l.points,
    ...(l.other ? { colorToken: '--text-subtle' } : {}),
  })),
);
const splitOptions = computed(() => [
  { value: NO_SPLIT, label: t('ownMetrics.detail.splitNothing') },
  ...(detail.data.value?.labels ?? []).map((l) => ({
    value: l.name,
    label: l.name,
    description: t('ownMetrics.detail.values', { n: l.values }, l.values),
  })),
]);
const splitModel = computed<string | null>({
  get: () => by.value ?? NO_SPLIT,
  set: (v) => (by.value = !v || v === NO_SPLIT ? null : v),
});

// The usual range of a watched metric (Pro): under the value, and a band under the line.
const usual = computed(() => m.value?.usual ?? null);
const usualWords = computed(() => (m.value ? usualText(usual.value, m.value) : null));
const unusual = computed(() => outside(m.value?.value, usual.value));
const band = computed(() => (by.value ? undefined : (series.data.value?.band ?? undefined)));
// What changed for what the metric belongs to (rollouts, a deploy told by CI): lines on the chart.
const markerTarget = computed(() => {
  const o = m.value && m.value.ownerCount === 1 ? m.value.owners[0] : undefined;
  if (o?.kind === 'workload') return { target: `${o.workloadKind}/${o.namespace}/${o.name}` };
  if (o?.kind === 'server') return { target: `Node/${o.name}` };
  return null;
});
const markers = useChangeMarkers(() => props.cluster, markerTarget);
const toggleWatch = () =>
  act(
    () => ownMetricsApi.watch(props.cluster, props.metricId, !m.value!.watched),
    t(m.value!.watched ? 'ownMetrics.watch.stopped' : 'ownMetrics.watch.started'),
  ).then(() => series.load());

const from = computed(() => {
  const metric = m.value;
  if (!metric) return '';
  return metric.sources.map((s) => s.label).join(', ');
});

// ----------------------------------------------------------------------------- pins
const pinnedTo = (o: OwnOwner) =>
  detail.data.value?.usedIn.pins.find(
    (p) =>
      p.owner.kind === o.kind &&
      p.owner.name === o.name &&
      p.owner.namespace === o.namespace &&
      p.owner.workloadKind === o.workloadKind,
  );
const busy = ref(false);
const failed = (err: unknown) =>
  toast.show(
    (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.detail.failed'),
    'warning',
  );
async function act(fn: () => Promise<unknown>, done?: string) {
  busy.value = true;
  try {
    await fn();
    if (done) toast.show(done);
    await detail.load();
    emit('changed');
  } catch (err) {
    failed(err);
  } finally {
    busy.value = false;
  }
}
const togglePin = (o: OwnOwner) => {
  const pin = pinnedTo(o);
  const name = ownerText(o) ?? '';
  return act(
    () =>
      pin
        ? ownMetricsApi.unpin(props.cluster, pin.id)
        : ownMetricsApi.pin(props.cluster, props.metricId, o),
    t(pin ? 'ownMetrics.detail.unpinned' : 'ownMetrics.detail.pinned', { owner: name }),
  );
};

// ----------------------------------------------------------------------------- corrections
const correcting = ref(false);
const typeOptions = computed(() =>
  OWN_TYPES.map((v) => ({ value: v, label: t(`ownMetrics.type.${v}`) })),
);
const unitOptions = computed(() =>
  OWN_UNITS.map((v) => ({ value: v, label: t(`ownMetrics.unit.${v}`) })),
);
const typeModel = computed<string | null>({
  get: () => m.value?.type ?? null,
  set: (v) => {
    if (!v || !m.value || v === m.value.type) return;
    const type = v === m.value.detectedType ? null : (v as OwnType);
    void act(async () => {
      await ownMetricsApi.correct(props.cluster, props.metricId, { type });
      await series.load();
    });
  },
});
const unitModel = computed<string | null>({
  get: () => m.value?.unit ?? null,
  set: (v) => {
    if (!v || !m.value || v === m.value.unit) return;
    const unit = v === m.value.detectedUnit ? null : (v as OwnUnit);
    void act(async () => {
      await ownMetricsApi.correct(props.cluster, props.metricId, { unit });
      await series.load();
    });
  },
});
const checkAgain = () =>
  act(
    () => ownMetricsApi.correct(props.cluster, props.metricId, { checkAgain: true }),
    t('ownMetrics.refused.checking'),
  );
</script>

<template>
  <section
    class="rounded-card border border-border bg-surface-1 px-5 py-5"
    :aria-label="$t('ownMetrics.detail.label')"
    data-testid="own-detail"
  >
    <ErrorState
      v-if="detail.error.value && !m"
      inline
      :message="$t('ownMetrics.detail.error')"
      :retrying="detail.loading.value"
      @retry="load"
    />
    <template v-else-if="m">
      <div class="flex flex-wrap justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-mono text-20 font-semibold break-all text-text" data-testid="own-name">
            {{ m.name }}
          </h2>
          <p class="mt-2 text-13 text-text-muted">
            <span class="rounded-control bg-surface-3 px-2 py-0.5 text-12 text-text">{{
              $t(`ownMetrics.type.${m.type}`)
            }}</span>
            {{ $t(`ownMetrics.shown.${m.shown}`) }}
            <template v-if="from"> · {{ $t('ownMetrics.detail.from', { from }) }}</template>
          </p>
          <p v-if="m.help" class="mt-1 text-13 text-text-subtle">{{ m.help }}</p>
        </div>
        <div class="text-right">
          <p class="text-32 leading-tight font-bold tabular-nums text-text" data-testid="own-now">
            {{ now!.value }}
            <span class="text-14 font-normal text-text-muted">{{
              now!.ago ? $t('ownMetrics.ago') : now!.unit
            }}</span>
          </p>
          <p
            v-if="usualWords || usual?.learning"
            :class="['text-13', unusual ? 'font-semibold text-warning-text' : 'text-text-muted']"
            data-testid="own-usual"
          >
            {{
              usualWords
                ? $t(unusual ? 'ownMetrics.watch.outside' : 'ownMetrics.watch.usual', {
                    range: usualWords,
                  })
                : $t('ownMetrics.watch.learning')
            }}
          </p>
          <p
            v-if="m.type === 'histogram' && detail.data.value"
            class="text-13 text-text-muted"
            data-testid="own-quantiles"
          >
            {{
              $t('ownMetrics.detail.quantiles', {
                p50:
                  written(detail.data.value.p50, m).value +
                  ' ' +
                  written(detail.data.value.p50, m).unit,
                p99:
                  written(detail.data.value.p99, m).value +
                  ' ' +
                  written(detail.data.value.p99, m).unit,
              })
            }}
          </p>
        </div>
      </div>

      <div
        v-if="m.refused"
        class="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-14 text-text"
        role="status"
        data-testid="own-refused"
      >
        <span class="min-w-0 flex-1">
          {{ $t('ownMetrics.refused.why', { label: m.refused.label }) }}
        </span>
        <BaseButton v-if="auth.canManage" variant="secondary" :loading="busy" @click="checkAgain">
          {{ $t('ownMetrics.refused.checkAgain') }}
        </BaseButton>
      </div>

      <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
        <span class="text-13 text-text-muted">{{ $t('ownMetrics.detail.splitBy') }}</span>
        <ComboBox
          v-model="splitModel"
          class="w-52 max-sm:w-full"
          :options="splitOptions"
          :label="$t('ownMetrics.detail.splitBy')"
          testid="own-split"
        />
      </div>
      <div class="mt-2 h-60">
        <OwnMetricChart
          :lines="lines"
          :showing="showing"
          :window="span"
          :band="band"
          :band-name="$t('ownMetrics.watch.band')"
          :markers="markers"
          :loading="series.loading.value"
          :error="!!series.error.value"
          :label="m.words"
          :empty-text="$t('ownMetrics.chart.empty')"
          :error-text="$t('ownMetrics.chart.error')"
        />
      </div>
      <p
        v-if="by && series.data.value && series.data.value.values > 5"
        class="mt-2 text-12 text-text-subtle"
        data-testid="own-split-note"
      >
        {{ $t('ownMetrics.detail.top', { n: series.data.value.values, label: by }) }}
      </p>

      <div v-if="auth.canManage" class="mt-4 flex flex-wrap gap-2.5" data-testid="own-actions">
        <slot name="actions" :metric="m" />
        <BaseButton
          v-for="o in m.owners"
          :key="`${o.kind}/${o.namespace}/${o.name}`"
          variant="secondary"
          :disabled="busy"
          data-testid="own-pin"
          @click="togglePin(o)"
        >
          {{
            $t(pinnedTo(o) ? 'ownMetrics.detail.unpinFrom' : 'ownMetrics.detail.pinTo', {
              owner: ownerText(o),
            })
          }}
        </BaseButton>
        <BaseButton
          v-if="m.type !== 'timestamp' || m.watched"
          variant="secondary"
          :disabled="busy || (!m.watched && !auth.proOnServer)"
          :title="!m.watched && !auth.proOnServer ? $t('ownMetrics.watch.pro') : undefined"
          data-testid="own-watch"
          @click="toggleWatch"
        >
          {{ $t(m.watched ? 'ownMetrics.watch.stop' : 'ownMetrics.watch.start') }}
          <span
            v-if="!auth.proOnServer"
            class="ml-1 inline-flex h-4.5 items-center rounded-full border border-info/50 px-1.5 text-12 font-semibold text-info-text"
            >{{ $t('nav.pro') }}</span
          >
        </BaseButton>
        <BaseButton variant="secondary" data-testid="own-alert-on" @click="emit('alert', m.id)">
          {{ $t('ownMetrics.detail.alertOnIt') }}
        </BaseButton>
        <BaseButton variant="ghost" data-testid="own-correct" @click="correcting = !correcting">
          {{ $t('ownMetrics.detail.correct') }}
        </BaseButton>
      </div>
      <div
        v-if="correcting && auth.canManage"
        class="mt-3 grid gap-3 rounded-card border border-border bg-surface-2 px-4 py-3 sm:grid-cols-2"
        data-testid="own-corrections"
      >
        <label class="flex flex-col gap-1 text-13 text-text-muted">
          {{ $t('ownMetrics.detail.typeLabel') }}
          <ComboBox
            v-model="typeModel"
            :options="typeOptions"
            :label="$t('ownMetrics.detail.typeLabel')"
            testid="own-type"
          />
          <span v-if="m.type !== m.detectedType" class="text-12 text-text-subtle">
            {{
              $t('ownMetrics.detail.detected', { what: $t(`ownMetrics.type.${m.detectedType}`) })
            }}
          </span>
        </label>
        <label class="flex flex-col gap-1 text-13 text-text-muted">
          {{ $t('ownMetrics.detail.unitLabel') }}
          <ComboBox
            v-model="unitModel"
            :options="unitOptions"
            :label="$t('ownMetrics.detail.unitLabel')"
            testid="own-unit"
          />
          <span v-if="m.unit !== m.detectedUnit" class="text-12 text-text-subtle">
            {{
              $t('ownMetrics.detail.detected', { what: $t(`ownMetrics.unit.${m.detectedUnit}`) })
            }}
          </span>
        </label>
      </div>

      <dl class="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <dt class="text-11 font-medium tracking-wider text-text-subtle uppercase">
            {{ $t('ownMetrics.detail.labels') }}
          </dt>
          <dd class="mt-1.5 font-mono text-13 break-words text-text" data-testid="own-labels">
            <template v-if="detail.data.value?.labels.length">
              <span v-for="(l, i) in detail.data.value.labels" :key="l.name"
                >{{ i ? ', ' : '' }}{{ l.name }}</span
              >
            </template>
            <span v-else class="font-sans text-text-muted">{{ $t('ownMetrics.detail.none') }}</span>
          </dd>
        </div>
        <div>
          <dt class="text-11 font-medium tracking-wider text-text-subtle uppercase">
            {{ $t('ownMetrics.detail.series') }}
          </dt>
          <dd class="mt-1.5 text-14 text-text" data-testid="own-series">
            {{ $t('ownMetrics.detail.seriesCount', { n: m.series }, m.series) }}
          </dd>
        </div>
        <div>
          <dt class="text-11 font-medium tracking-wider text-text-subtle uppercase">
            {{ $t('ownMetrics.detail.usedIn') }}
          </dt>
          <dd class="mt-1.5 text-14 leading-relaxed text-text" data-testid="own-used">
            <RouterLink
              v-for="d in detail.data.value?.usedIn.dashboards ?? []"
              :key="d.id"
              :to="{ name: 'your-metrics', query: { cluster, dashboard: d.id } }"
              class="block text-link hover:underline"
            >
              {{ $t('ownMetrics.dashboards.onDashboard', { name: d.name }) }}
            </RouterLink>
            <template v-for="p in detail.data.value?.usedIn.pins ?? []" :key="p.id">
              <RouterLink
                v-if="ownerLink(p.owner, cluster)"
                :to="ownerLink(p.owner, cluster)!"
                class="block text-link hover:underline"
              >
                {{ $t('ownMetrics.detail.pinnedOn', { owner: ownerText(p.owner) }) }}
              </RouterLink>
            </template>
            <span
              v-if="
                !(detail.data.value?.usedIn.pins.length ?? 0) &&
                !(detail.data.value?.usedIn.dashboards.length ?? 0)
              "
              class="text-text-muted"
              >{{ $t('ownMetrics.detail.nowhere') }}</span
            >
          </dd>
        </div>
      </dl>
      <p v-if="m.untied && m.owners.length === 0" class="mt-4 text-13 text-text-subtle">
        {{ $t('ownMetrics.detail.untied') }}
      </p>
    </template>
  </section>
</template>
