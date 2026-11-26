<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The Alerts tab of Your metrics (1.0.0, ADR-236): the rules on this cluster's own metrics,
// what each says and whether it fires, and "New alert": a metric, what is asked of it, a
// value, how long, how bad and where it goes, with the sentence it will say before it is made.
// The rules are ordinary ones: they are also under Alerts with every other rule.
import type {
  AlertChannelList,
  OwnAlertInput,
  OwnAlertList,
  OwnAlertRule,
  OwnMetric,
} from '@watchlog/api-types';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import { ownMetricsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { agoShort } from '@/lib/format';
import { ownerText, type Per } from '@/lib/own-metrics';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

const props = defineProps<{
  cluster: { id: string; name: string };
  metrics: OwnMetric[];
  /** The metric "Alert on it" came from. */
  preset?: string | null;
}>();
const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

type Is = OwnAlertRule['is'];

const page = useLoader<OwnAlertList>(() => ownMetricsApi.alerts(props.cluster.id));
const channels = useLoader(async () =>
  auth.canManage ? (await api<AlertChannelList>('/alert-channels')).channels : [],
);
onMounted(() => {
  void page.load();
  void channels.load();
});
watch(
  () => props.cluster.id,
  () => void page.load(),
);
const poll = usePolling(() => page.load(), 30_000);
poll.start();

const rules = computed(() => page.data.value?.rules ?? []);
const allowed = computed(() => page.data.value?.allowed ?? 'threshold');
const firing = computed(() => rules.value.filter((r) => r.firing > 0).length);
const countText = computed(() =>
  [
    t('ownMetrics.alerts.count', { n: rules.value.length }, rules.value.length),
    ...(firing.value ? [t('ownMetrics.alerts.firing', { n: firing.value })] : []),
  ].join(' · '),
);
const channelName = (id: string) => channels.data.value?.find((c) => c.id === id)?.name ?? null;
const where = (r: OwnAlertRule) =>
  r.channelIds.map(channelName).filter(Boolean).join(', ') || t('ownMetrics.alerts.noChannel');

function stateOf(r: OwnAlertRule): string {
  if (!r.enabled) return t('ownMetrics.alerts.state.off');
  if (r.evalError) return t('ownMetrics.alerts.state.error');
  if (r.metricId === null) return t('ownMetrics.alerts.state.gone');
  if (r.firing > 0) return t('ownMetrics.alerts.state.firing', { n: r.firing }, r.firing);
  return r.lastFiredAt
    ? t('ownMetrics.alerts.state.okFired', { ago: agoShort(r.lastFiredAt / 1000) })
    : t('ownMetrics.alerts.state.ok');
}

// ------------------------------------------------------------------------- new alert
const metricId = ref<string | null>(null);
const is = ref<Is>('above');
const amount = ref('');
const per = ref<Per>('min');
/** The unit a duration ("not reported for", "older than") is typed in. */
const span = ref<'min' | 'h' | 'd'>('min');
const forMinutes = ref('5');
const severity = ref<'warning' | 'critical'>('warning');
const channelIds = ref<string[]>([]);
const name = ref('');
const error = ref('');
const saving = ref(false);

const metric = computed(() => props.metrics.find((m) => m.id === metricId.value) ?? null);
watch(
  () => [props.preset, props.metrics.length] as const,
  ([preset]) => {
    if (preset && props.metrics.some((m) => m.id === preset)) metricId.value = preset;
    else if (!metricId.value) metricId.value = props.metrics[0]?.id ?? null;
  },
  { immediate: true },
);
// A timestamp is asked how old it is; everything else starts as "above".
watch(metric, (m, was) => {
  if (!m || m.id === was?.id) return;
  is.value = m.type === 'timestamp' ? 'older' : 'above';
  amount.value = '';
  span.value = m.type === 'timestamp' ? 'h' : 'min';
});

const metricOptions = computed(() =>
  props.metrics.map((m) => ({
    value: m.id,
    label: m.name,
    description: [m.words, ...m.owners.slice(0, 1).map((o) => ownerText(o) ?? '')]
      .filter(Boolean)
      .join(' · '),
  })),
);
const isOptions = computed(() => {
  const m = metric.value;
  const stamp = m?.type === 'timestamp';
  const usual = allowed.value === 'all';
  return (
    [
      { v: 'above', off: stamp },
      { v: 'below', off: stamp },
      { v: 'unusual', off: stamp, pro: true },
      { v: 'absent', off: false },
      { v: 'older', off: !stamp },
    ] as { v: Is; off: boolean; pro?: boolean }[]
  )
    .filter((o) => !o.off)
    .map((o) => ({
      value: o.v,
      label: t(`ownMetrics.alerts.is.${o.v}`),
      ...(o.pro
        ? {
            badge: t('nav.pro'),
            ...(usual
              ? m && !m.watched
                ? { description: t('ownMetrics.alerts.watchFirst'), disabled: true }
                : {}
              : { description: t('ownMetrics.alerts.proOnly'), disabled: true }),
          }
        : {}),
    }));
});
const isModel = computed<string | null>({
  get: () => is.value,
  set: (v) => {
    if (v) is.value = v as Is;
  },
});
const duration = computed(() => is.value === 'absent' || is.value === 'older');
const rate = computed(() => metric.value?.shown === 'rate' && !duration.value);
const perOptions = computed(() =>
  (['s', 'min', 'h'] as Per[]).map((p) => ({ value: p, label: t(`ownMetrics.widget.per.${p}`) })),
);
const spanOptions = computed(() =>
  (['min', 'h', 'd'] as const).map((p) => ({ value: p, label: t(`ownMetrics.alerts.span.${p}`) })),
);
const forOptions = computed(() =>
  ['0', '1', '5', '10', '15', '30', '60'].map((m) => ({
    value: m,
    label:
      m === '0'
        ? t('ownMetrics.alerts.atOnce')
        : t('ownMetrics.alerts.minutes', { n: m }, Number(m)),
  })),
);
const severityOptions = computed(() =>
  (['warning', 'critical'] as const).map((s) => ({
    value: s,
    label: t(`ownMetrics.alerts.severity.${s}`),
  })),
);
const channelOptions = computed(() =>
  (channels.data.value ?? []).map((c) => ({ value: c.id, label: c.name, description: c.type })),
);
const model = <T extends string>(r: { value: T }) =>
  computed<string | null>({
    get: () => r.value,
    set: (v) => {
      if (v) r.value = v as T;
    },
  });
const perModel = model(per);
const spanModel = model(span);
const forModel = model(forMinutes);
const severityModel = model(severity);

const PER_S: Record<Per, number> = { s: 1, min: 60, h: 3600 };
const SPAN_S = { min: 60, h: 3600, d: 86400 };
/** The rule as the API takes it; null while the form isn't complete. */
const body = computed<OwnAlertInput | null>(() => {
  const m = metric.value;
  if (!m) return null;
  const base = {
    metricId: m.id,
    is: is.value,
    severity: severity.value,
    channelIds: channelIds.value,
    ...(name.value.trim() ? { name: name.value.trim() } : {}),
  };
  if (is.value === 'unusual') return { ...base, forSeconds: Number(forMinutes.value) * 60 };
  const n = Number(amount.value.replace(',', '.'));
  if (amount.value.trim() === '' || !Number.isFinite(n)) return null;
  if (duration.value) return { ...base, value: n * SPAN_S[span.value] };
  return {
    ...base,
    // A rate is stored per second, a share of 0 to 1; the value is typed as the page shows it.
    value: rate.value ? n / PER_S[per.value] : m.unit === 'ratio' ? n / 100 : n,
    ...(rate.value ? { per: per.value } : {}),
    forSeconds: Number(forMinutes.value) * 60,
  };
});
const valueLabel = computed(() => {
  const m = metric.value;
  if (!m || duration.value) return t('ownMetrics.alerts.value');
  const unit =
    m.unit === 'ratio' || m.unit === 'percent'
      ? '%'
      : m.unit === 'celsius'
        ? '°C'
        : m.unit === 'seconds'
          ? 's'
          : m.unit === 'bytes'
            ? 'bytes'
            : '';
  return unit ? t('ownMetrics.alerts.valueIn', { unit }) : t('ownMetrics.alerts.value');
});

// "It will say": asked from the server, a moment after the last change.
const sentence = ref('');
const holds = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
watch(
  body,
  (b) => {
    clearTimeout(timer);
    if (!b || !auth.canManage) {
      sentence.value = '';
      return;
    }
    const mine = ++seq;
    timer = setTimeout(() => {
      ownMetricsApi.alertPreview(props.cluster.id, b).then(
        (res) => {
          if (mine !== seq) return;
          sentence.value = res.sentence;
          holds.value = res.holds;
        },
        () => {
          if (mine === seq) sentence.value = '';
        },
      );
    }, 300);
  },
  { deep: true, immediate: true },
);

async function create() {
  error.value = '';
  if (!body.value) {
    error.value = t('ownMetrics.alerts.incomplete');
    return;
  }
  saving.value = true;
  try {
    const made = await ownMetricsApi.createAlert(props.cluster.id, body.value);
    toast.show(t('ownMetrics.alerts.created', { name: made.name }));
    amount.value = '';
    name.value = '';
    await page.load();
  } catch (err) {
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.alerts.failed');
  } finally {
    saving.value = false;
  }
}

async function toggle(r: OwnAlertRule) {
  try {
    await api(`/alert-rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } });
    await page.load();
  } catch (err) {
    toast.show(
      (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.alerts.failed'),
      'warning',
    );
  }
}
const deleting = ref<OwnAlertRule | null>(null);
const deleteOpen = computed({
  get: () => deleting.value !== null,
  set: (v) => {
    if (!v) deleting.value = null;
  },
});
async function remove() {
  await ownMetricsApi.deleteAlert(props.cluster.id, deleting.value!.id);
  await page.load();
}
</script>

<template>
  <div class="flex flex-wrap items-start gap-4" data-testid="own-alerts">
    <ErrorState
      v-if="page.error.value && !page.loaded.value"
      class="flex-1"
      :message="$t('ownMetrics.alerts.error')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <!-- Cloud Free: alerts on own metrics are Pro's. -->
    <section
      v-else-if="page.loaded.value && allowed === 'none'"
      class="flex-1 rounded-card border border-border bg-surface-1 px-6 py-8"
      data-testid="own-alerts-upgrade"
    >
      <h2 class="text-16 font-semibold text-text">{{ $t('ownMetrics.alerts.upgradeTitle') }}</h2>
      <p class="mt-2 max-w-2xl text-14 leading-relaxed text-text-muted">
        {{ $t('ownMetrics.alerts.upgradeBody') }}
      </p>
      <RouterLink
        v-if="auth.isCloud && auth.user?.role === 'owner'"
        :to="{ name: 'settings', query: { tab: 'billing' } }"
        class="mt-5 inline-flex h-9 items-center rounded-control bg-primary px-4 text-14 font-semibold text-on-primary transition-colors hover:bg-primary-hover max-lg:h-11"
      >
        {{ $t('ownMetrics.alerts.upgrade') }}
      </RouterLink>
    </section>
    <template v-else-if="page.loaded.value">
      <section
        class="min-w-0 flex-[2_1_34rem] overflow-hidden rounded-card border border-border bg-surface-1"
      >
        <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <h2 class="text-14 font-semibold text-text">{{ $t('ownMetrics.alerts.title') }}</h2>
          <span class="text-13 text-text-muted" data-testid="own-alerts-count">{{
            countText
          }}</span>
        </div>
        <p
          v-if="rules.length === 0"
          class="border-t border-border px-5 py-6 text-14 text-text-muted"
        >
          {{ $t('ownMetrics.alerts.none') }}
        </p>
        <ul v-else>
          <li
            v-for="r in rules"
            :key="r.id"
            class="flex flex-wrap items-start gap-x-4 gap-y-2 border-t border-border px-5 py-3.5"
            data-testid="own-alert-rule"
          >
            <span
              :class="[
                'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-12 font-semibold',
                r.severity === 'critical'
                  ? 'bg-critical/15 text-critical-text'
                  : 'bg-warning/15 text-warning-text',
              ]"
            >
              {{ $t(`ownMetrics.alerts.severity.${r.severity}`) }}
            </span>
            <span class="min-w-0 flex-[1_1_16rem]">
              <span class="block text-14 font-semibold text-text">{{ r.name }}</span>
              <span class="mt-0.5 block text-13 text-text-muted">
                <span class="font-mono">{{ r.metric }}</span> · {{ r.condition }}
                <span
                  v-if="r.is === 'unusual'"
                  class="ml-1 inline-flex h-4.5 items-center rounded-full border border-info/50 px-1.5 text-12 font-semibold text-info-text"
                  >{{ $t('nav.pro') }}</span
                >
              </span>
              <span v-if="r.evalError" class="mt-0.5 block text-12 text-critical-text">{{
                r.evalError
              }}</span>
            </span>
            <span
              :class="[
                'w-40 text-13',
                r.firing > 0 && r.enabled ? 'font-semibold text-critical-text' : 'text-text-muted',
              ]"
              data-testid="own-alert-state"
            >
              {{ stateOf(r) }}
            </span>
            <span class="w-36 truncate text-13 text-text-muted">{{ where(r) }}</span>
            <span v-if="auth.canManage" class="flex shrink-0 gap-3 text-13">
              <button
                type="button"
                class="text-link hover:underline max-lg:min-h-11"
                data-testid="own-alert-toggle"
                @click="toggle(r)"
              >
                {{ $t(r.enabled ? 'ownMetrics.alerts.turnOff' : 'ownMetrics.alerts.turnOn') }}
              </button>
              <button
                type="button"
                class="text-link hover:underline max-lg:min-h-11 max-lg:min-w-11"
                data-testid="own-alert-delete"
                @click="deleting = r"
              >
                {{ $t('common.delete') }}
              </button>
            </span>
          </li>
        </ul>
        <p class="border-t border-border px-5 py-3 text-13 text-text-muted">
          {{ $t('ownMetrics.alerts.alsoUnder') }}
          <RouterLink
            :to="{ name: 'alerts', query: { cluster: cluster.id } }"
            class="text-link hover:underline"
            >{{ $t('nav.alerts') }}</RouterLink
          >.
        </p>
      </section>

      <aside
        v-if="auth.canManage"
        class="min-w-0 flex-[1_1_20rem] rounded-card border border-border bg-surface-1 px-5 py-4"
      >
        <form class="flex flex-col gap-3.5" data-testid="own-alert-form" @submit.prevent="create">
          <h2 class="text-14 font-semibold text-text">{{ $t('ownMetrics.alerts.new') }}</h2>
          <p v-if="metrics.length === 0" class="text-13 text-text-muted">
            {{ $t('ownMetrics.editor.noMetrics') }}
          </p>
          <template v-else>
            <label class="flex flex-col gap-1.5 text-12 font-medium text-text-muted">
              {{ $t('ownMetrics.alerts.when') }}
              <ComboBox
                v-model="metricId"
                :options="metricOptions"
                :label="$t('ownMetrics.alerts.when')"
                testid="own-alert-metric"
              />
            </label>
            <label class="flex flex-col gap-1.5 text-12 font-medium text-text-muted">
              {{ $t('ownMetrics.alerts.isLabel') }}
              <ComboBox
                v-model="isModel"
                :options="isOptions"
                :label="$t('ownMetrics.alerts.isLabel')"
                testid="own-alert-is"
              />
            </label>
            <div v-if="is !== 'unusual'" class="grid grid-cols-2 gap-2.5">
              <TextField
                v-model="amount"
                :label="valueLabel"
                inputmode="numeric"
                data-testid="own-alert-value"
              />
              <label
                v-if="duration || rate"
                class="flex flex-col gap-1.5 text-12 font-medium text-text-muted"
              >
                {{ $t('ownMetrics.alerts.unit') }}
                <ComboBox
                  v-if="duration"
                  v-model="spanModel"
                  :options="spanOptions"
                  :label="$t('ownMetrics.alerts.unit')"
                  testid="own-alert-span"
                />
                <ComboBox
                  v-else
                  v-model="perModel"
                  :options="perOptions"
                  :label="$t('ownMetrics.alerts.unit')"
                  testid="own-alert-per"
                />
              </label>
            </div>
            <label
              v-if="!duration"
              class="flex flex-col gap-1.5 text-12 font-medium text-text-muted"
            >
              {{ $t('ownMetrics.alerts.for') }}
              <ComboBox
                v-model="forModel"
                :options="forOptions"
                :label="$t('ownMetrics.alerts.for')"
                testid="own-alert-for"
              />
            </label>
            <div class="grid grid-cols-2 gap-2.5">
              <label class="flex flex-col gap-1.5 text-12 font-medium text-text-muted">
                {{ $t('ownMetrics.alerts.severityLabel') }}
                <ComboBox
                  v-model="severityModel"
                  :options="severityOptions"
                  :label="$t('ownMetrics.alerts.severityLabel')"
                  testid="own-alert-severity"
                />
              </label>
              <label class="flex flex-col gap-1.5 text-12 font-medium text-text-muted">
                {{ $t('ownMetrics.alerts.channel') }}
                <ComboBox
                  v-model="channelIds"
                  multiple
                  :options="channelOptions"
                  :label="$t('ownMetrics.alerts.channel')"
                  :placeholder="$t('ownMetrics.alerts.noChannel')"
                  :empty-text="$t('ownMetrics.alerts.noChannels')"
                  testid="own-alert-channels"
                />
              </label>
            </div>
            <TextField
              v-model="name"
              :label="$t('ownMetrics.alerts.name')"
              :placeholder="$t('ownMetrics.alerts.namePlaceholder')"
              :maxlength="200"
            />
            <div
              v-if="sentence"
              class="rounded-card border border-border bg-surface-2 px-3.5 py-3"
              role="status"
              data-testid="own-alert-sentence"
            >
              <span class="text-11 font-medium tracking-wider text-text-subtle uppercase">{{
                $t('ownMetrics.alerts.willSay')
              }}</span>
              <p class="mt-1 text-14 leading-relaxed text-text">{{ sentence }}</p>
              <p v-if="holds" class="mt-1 text-12 text-warning-text">
                {{ $t('ownMetrics.alerts.holdsNow') }}
              </p>
            </div>
            <p
              v-if="error"
              class="text-13 text-critical-text"
              role="alert"
              data-testid="own-alert-error"
            >
              {{ error }}
            </p>
            <BaseButton type="submit" block :loading="saving" data-testid="own-alert-create">
              {{ $t('ownMetrics.alerts.create') }}
            </BaseButton>
          </template>
        </form>
      </aside>
    </template>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('ownMetrics.alerts.deleteTitle')"
      :subject="deleting?.name"
      :lines="[$t('ownMetrics.alerts.deleteBody')]"
      :confirm-label="$t('ownMetrics.alerts.deleteConfirm')"
      :action="remove"
      testid="own-alert-confirm"
    />
  </div>
</template>
