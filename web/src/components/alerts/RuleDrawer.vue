<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronRight, CircleX, TriangleAlert, X } from '@lucide/vue';
import type {
  AlertChannel,
  AlertRule,
  Cluster,
  CreateAlertRuleRequest,
  PatchAlertRuleRequest,
  RulePreview,
} from '@watchlog/api-types';
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import AlertChart from '@/components/alerts/AlertChart.vue';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import { conditionThresholds } from '@/lib/alert-chart';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { CUSTOM_METRICS, fromInput, SERVICE_METRICS, serviceMetrics, toInput } from '@/lib/alerts';
import { serviceName } from '@/lib/applications';
import type { Unit } from '@/lib/units';
import RuleSentence from './RuleSentence.vue';

// The rule editor (alerts redesign item 9, ADR-096): one right-side drawer for default
// and custom rules. A sentence with slots — "When [metric] on [scope] is above [N] for
// [N] min → raise Warning · above [N] make it Critical" — one threshold model (warning
// plus an optional critical threshold; state rules keep a Warning/Critical choice),
// channels and reminders, and a preview of what these settings would have done.
const props = defineProps<{
  /** The rule to edit, or null for a new custom rule. */
  rule: AlertRule | null;
  channels: AlertChannel[];
  clusters: Cluster[];
  /** A new rule for this monitored service ("+ Add rule" on its page). */
  service?: { id: string; name: string; clusterId: string; type?: string };
}>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ saved: [] }>();
const { t, te } = useI18n();

const isNew = computed(() => props.rule === null);
const isDefault = computed(() => props.rule?.type === 'default');
const isMetric = computed(() => isNew.value || props.rule?.source === 'metric');
const SCOPES = {
  kubernetes: ['cluster', 'namespaces', 'workload', 'node', 'labels'],
  docker: ['cluster', 'host', 'container'],
} as const;
type ScopeKind =
  'cluster' | 'namespaces' | 'workload' | 'node' | 'labels' | 'host' | 'container' | 'service';
const REMIND = [0, 3600, 14400, 86400] as const;

const form = reactive({
  name: '',
  clusterId: null as string | null,
  metric: '' as string,
  scopeKind: 'cluster' as ScopeKind,
  /** A service rule for every service of its type, in every cluster. */
  everyOfType: false,
  scopeText: '',
  workload: { namespace: '', kind: 'Deployment', name: '' },
  op: '>' as '>' | '<',
  value: '' as number | '',
  critical: '' as number | '',
  forMinutes: 0,
  severity: 'warning' as 'warning' | 'critical',
  channelIds: [] as string[],
  renotify: 14400,
});
const showAdvanced = ref(false);
const error = ref<string>();
const saving = ref(false);

const kind = computed<'kubernetes' | 'docker'>(() =>
  props.clusters.find((c) => c.id === form.clusterId)?.kind === 'docker' ? 'docker' : 'kubernetes',
);
const unit = computed<string | null>(() =>
  isNew.value || props.rule?.type === 'threshold'
    ? ([...CUSTOM_METRICS[kind.value], ...serviceMetrics(serviceType.value)].find(
        (m) => m.key === form.metric,
      )?.unit ?? null)
    : (props.rule?.unit ?? null),
);
// The service's type, for its own metrics (a Redis has redis.*).
const serviceType = computed(
  () =>
    props.service?.type ??
    props.rule?.service?.type ??
    (props.rule?.scope as { serviceType?: string } | undefined)?.serviceType,
);
// A rule about one monitored service: its metrics only, its cluster and scope fixed.
const serviceScope = computed(() =>
  form.scopeKind === 'service'
    ? (props.service ??
      (props.rule?.service
        ? { ...props.rule.service, clusterId: props.rule.clusterId ?? '' }
        : serviceType.value
          ? { id: '', name: '', clusterId: '', type: serviceType.value }
          : null))
    : null,
);
const metricOptions = computed(() =>
  (serviceScope.value ? serviceMetrics(serviceType.value) : CUSTOM_METRICS[kind.value]).map(
    (m) => ({
      value: m.key,
      label: metricName(m.key),
    }),
  ),
);
const unitLabel = computed(() => (unit.value ? t(`alerts.custom.units.${unit.value}`) : ''));
const metricName = (key: string) => {
  const k = `metricNames.${key.replaceAll('.', '_')}`;
  return te(k) ? t(k) : key;
};

function reset() {
  const r = props.rule;
  const s = (r?.scope ?? {}) as {
    namespaces?: string[];
    workload?: { namespace: string; kind: string; name: string };
    node?: string;
    host?: string;
    container?: string;
    labels?: Record<string, string>;
    service?: string;
    serviceType?: string;
  };
  const u = r?.unit ?? null;
  const preset = !r && props.service ? props.service : null;
  Object.assign(form, {
    name: r?.name ?? '',
    clusterId: r?.clusterId ?? preset?.clusterId ?? props.clusters[0]?.id ?? null,
    metric: r?.metric ?? (preset ? SERVICE_METRICS[0]!.key : CUSTOM_METRICS.kubernetes[0]!.key),
    op: r?.condition?.op ?? '>',
    value: r?.condition ? toInput(r.condition.value, u) : '',
    // A custom rule saved as all-critical becomes "critical from the same threshold".
    critical:
      r?.condition?.critical !== undefined
        ? toInput(r.condition.critical, u)
        : r?.condition && r.severity === 'critical' && r.type === 'threshold'
          ? toInput(r.condition.value, u)
          : '',
    forMinutes: Math.round((r?.forSeconds ?? 300) / 60),
    severity: r?.severity ?? 'warning',
    channelIds: [...(r?.channelIds ?? props.channels.map((c) => c.id))],
    renotify: r?.renotifySeconds ?? 14400,
    workload: s.workload ? { ...s.workload } : { namespace: '', kind: 'Deployment', name: '' },
  });
  form.everyOfType = !!s.serviceType;
  form.scopeKind =
    s.service || s.serviceType || preset
      ? 'service'
      : s.labels
        ? 'labels'
        : s.workload
          ? 'workload'
          : s.node
            ? 'node'
            : s.host
              ? 'host'
              : s.container
                ? 'container'
                : s.namespaces
                  ? 'namespaces'
                  : 'cluster';
  form.scopeText = s.labels
    ? Object.entries(s.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : (s.node ?? s.host ?? s.container ?? s.namespaces?.join(', ') ?? '');
  error.value = undefined;
  showAdvanced.value = false;
  if (preset) startFor(form.metric);
}
watch(
  () => [open.value, props.rule?.id],
  () => open.value && reset(),
  { immediate: true },
);
// A new rule on a service metric starts from that metric's usual condition.
function startFor(metric: string) {
  const m = serviceMetrics(serviceType.value).find((x) => x.key === metric);
  if (!m || !isNew.value) return;
  form.op = m.start.op;
  form.value = toInput(m.start.value, m.unit);
}
watch(
  () => form.metric,
  (m) => startFor(m),
);

function scope(): CreateAlertRuleRequest['scope'] {
  const text = form.scopeText.trim();
  switch (form.scopeKind) {
    case 'service':
      if (form.everyOfType && serviceType.value) return { serviceType: serviceType.value };
      return serviceScope.value ? { service: serviceScope.value.id } : {};
    case 'namespaces':
      return { namespaces: text.split(/[\s,]+/).filter(Boolean) };
    case 'workload':
      return { workload: { ...form.workload } };
    case 'node':
      return { node: text };
    case 'host':
      return { host: text };
    case 'container':
      return { container: text };
    case 'labels':
      return {
        labels: Object.fromEntries(
          text
            .split(/[\s,]+/)
            .filter((p) => p.includes('='))
            .map((p) => {
              const [k, v] = p.split('=', 2);
              return [k!.trim(), (v ?? '').trim()];
            }),
        ),
      };
    default:
      return {};
  }
}
function condition() {
  if (form.value === '') return undefined;
  return {
    op: form.op,
    value: fromInput(Number(form.value), unit.value),
    ...(form.critical !== '' ? { critical: fromInput(Number(form.critical), unit.value) } : {}),
  };
}

// ---------------------------------------------------------------- preview

const preview = ref<RulePreview | null>(null);
const previewError = ref(false);
const previewing = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
async function loadPreview() {
  const mine = ++seq;
  previewing.value = true;
  previewError.value = false;
  try {
    const cond = isMetric.value ? condition() : undefined;
    if (isMetric.value && !cond) {
      preview.value = null;
      return;
    }
    const custom = isNew.value || props.rule?.type === 'threshold';
    const res = await api<RulePreview>('/alert-rules/preview', {
      method: 'POST',
      body: {
        ...(props.rule ? { ruleId: props.rule.id } : {}),
        ...(custom
          ? {
              metric: form.metric,
              clusterId: form.everyOfType ? null : form.clusterId,
              scope: scope(),
            }
          : {}),
        ...(cond ? { condition: cond } : {}),
        forSeconds: Math.round(form.forMinutes * 60),
      },
    });
    if (mine === seq) preview.value = res;
  } catch {
    if (mine === seq) previewError.value = true;
  } finally {
    if (mine === seq) previewing.value = false;
  }
}
watch(
  () => [
    open.value,
    form.metric,
    form.clusterId,
    form.scopeKind,
    form.scopeText,
    form.op,
    form.value,
    form.critical,
    form.forMinutes,
  ],
  () => {
    if (!open.value) return;
    clearTimeout(timer);
    timer = setTimeout(() => void loadPreview(), 500);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const series = computed<ChartSeries[]>(() => {
  const p = preview.value;
  if (!p?.series) return [];
  return [{ name: p.series.name, points: p.series.points as [number, number | null][] }];
});
/** The backtest's 24 hours, not the top bar's range. */
const previewWindow = computed<[number, number]>(() => {
  const pts = preview.value?.series?.points ?? [];
  const to = (pts.at(-1)?.[0] as number | undefined) ?? Math.floor(Date.now() / 1000);
  return [to - (preview.value?.hours ?? 24) * 3600, to];
});
const thresholds = computed(() =>
  conditionThresholds(condition() ?? null, (unit.value ?? 'count') as Unit, t),
);

// ---------------------------------------------------------------- save

async function save() {
  error.value = undefined;
  const cond = isMetric.value ? condition() : undefined;
  if (isMetric.value && !cond) {
    error.value = t('alerts.custom.needThreshold');
    return;
  }
  saving.value = true;
  try {
    const common = {
      forSeconds: Math.round(form.forMinutes * 60),
      renotifySeconds: form.renotify,
      channelIds: form.channelIds,
      // Threshold rules have one model: warning, plus critical above its own threshold.
      severity: isMetric.value ? ('warning' as const) : form.severity,
      ...(cond ? { condition: cond } : {}),
    };
    if (isNew.value) {
      await api('/alert-rules', {
        method: 'POST',
        body: {
          ...common,
          condition: cond!,
          name: form.name.trim() || metricName(form.metric),
          metric: form.metric,
          clusterId: form.everyOfType ? null : form.clusterId,
          scope: scope(),
        } satisfies CreateAlertRuleRequest,
      });
    } else {
      const body: PatchAlertRuleRequest = { ...common };
      if (props.rule!.type === 'threshold') {
        Object.assign(body, {
          name: form.name.trim() || props.rule!.name,
          scope: scope(),
          clusterId: form.everyOfType ? null : form.clusterId,
        });
      }
      await api(`/alert-rules/${props.rule!.id}`, { method: 'PATCH', body });
    }
    open.value = false;
    emit('saved');
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('alerts.rules.saveFailed');
  } finally {
    saving.value = false;
  }
}

async function resetToDefault() {
  saving.value = true;
  try {
    await api(`/alert-rules/${props.rule!.id}/reset`, { method: 'POST' });
    open.value = false;
    emit('saved');
  } catch {
    error.value = t('alerts.rules.saveFailed');
  } finally {
    saving.value = false;
  }
}

const slot =
  'h-8 w-20 rounded-control border border-border-strong bg-surface-3 px-2 text-center font-mono text-14 text-text tabular focus:border-primary max-lg:h-11 max-md:text-16';
const channelOptions = computed(() =>
  props.channels.map((c) => ({
    value: c.id,
    label: c.name,
    description: t(`channels.types.${c.type}`),
  })),
);
const ruleKeyId = computed(() => (props.rule?.ruleKey ?? '').replaceAll('.', '_'));
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-bg/60" />
      <DialogContent
        class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[540px] flex-col border-l border-border-strong bg-surface-1 shadow-xl max-md:border-l-0"
        data-testid="rule-drawer"
      >
        <header class="flex items-center gap-2.5 border-b border-border px-4 py-3.5 max-lg:py-1.5">
          <DialogTitle class="min-w-0 truncate text-16 font-semibold text-text">
            {{ isNew ? $t('alerts.drawer.newTitle') : rule!.name }}
          </DialogTitle>
          <TonePill
            tone="neutral"
            :label="
              isNew || rule?.type === 'threshold'
                ? $t('alerts.drawer.customRule')
                : $t('alerts.drawer.defaultRule')
            "
          />
          <span class="flex-1" />
          <DialogClose
            class="rounded-control p-1 text-text-muted hover:bg-surface-2 hover:text-text max-lg:-mr-2 max-lg:flex max-lg:size-11 max-lg:items-center max-lg:justify-center"
            :aria-label="$t('common.close')"
          >
            <X class="size-4" aria-hidden="true" />
          </DialogClose>
        </header>
        <DialogDescription class="sr-only">{{ $t('alerts.drawer.description') }}</DialogDescription>

        <form class="flex min-h-0 flex-1 flex-col" novalidate @submit.prevent="save">
          <div class="flex flex-col gap-5 overflow-y-auto px-4 py-4">
            <!-- WHEN -->
            <div class="flex flex-col gap-2">
              <span class="text-12 tracking-wide text-text-subtle uppercase">{{
                $t('alerts.drawer.when')
              }}</span>
              <div v-if="isMetric" class="flex flex-wrap items-center gap-2 text-14 leading-loose">
                <template v-if="isNew || rule?.type === 'threshold'">
                  <ComboBox
                    v-if="isNew && !serviceScope"
                    :model-value="form.clusterId"
                    :options="
                      clusters.map((c) => ({
                        value: c.id,
                        label: c.name,
                        description: $t(`clusters.kind.${c.kind}`),
                      }))
                    "
                    :label="$t('alerts.custom.cluster')"
                    class="w-44"
                    testid="drawer-cluster"
                    @update:model-value="form.clusterId = $event ?? form.clusterId"
                  />
                  <ComboBox
                    :model-value="form.metric"
                    :options="metricOptions"
                    :label="$t('alerts.custom.metric')"
                    :disabled="!isNew"
                    class="w-60"
                    testid="drawer-metric"
                    @update:model-value="form.metric = $event ?? form.metric"
                  />
                  <span class="text-text-muted">{{ $t('alerts.drawer.on') }}</span>
                  <ComboBox
                    v-if="serviceScope && isNew && serviceScope.name && serviceType"
                    :model-value="form.everyOfType ? 'every' : 'one'"
                    :options="[
                      { value: 'one', label: serviceScope.name },
                      {
                        value: 'every',
                        label: $t('alerts.drawer.everyOfType', { type: serviceName(serviceType) }),
                      },
                    ]"
                    :label="$t('alerts.custom.scope')"
                    class="w-56"
                    testid="drawer-service-scope"
                    @update:model-value="form.everyOfType = $event === 'every'"
                  />
                  <span
                    v-else-if="serviceScope"
                    class="rounded-control border border-border-strong bg-surface-3 px-2.5 py-0.5 font-mono text-14 text-text"
                    data-testid="drawer-service"
                    >{{
                      form.everyOfType && serviceType
                        ? $t('alerts.drawer.everyOfType', { type: serviceName(serviceType) })
                        : serviceScope.name
                    }}</span
                  >
                  <ComboBox
                    v-else
                    :model-value="form.scopeKind"
                    :options="
                      SCOPES[kind].map((s) => ({
                        value: s,
                        label: $t(`alerts.custom.scopes.${s}`),
                      }))
                    "
                    :label="$t('alerts.custom.scope')"
                    class="w-40"
                    testid="drawer-scope"
                    @update:model-value="form.scopeKind = ($event as ScopeKind) ?? form.scopeKind"
                  />
                </template>
                <template v-else>
                  <span
                    class="rounded-control border border-border-strong bg-surface-3 px-2.5 py-0.5 text-14 text-text"
                    data-testid="drawer-metric-fixed"
                  >
                    {{ $t(`alerts.drawer.defaultMetric.${ruleKeyId}`) }}
                  </span>
                  <span class="text-text-muted">{{ $t('alerts.drawer.on') }}</span>
                  <span
                    class="rounded-control border border-border-strong bg-surface-3 px-2.5 py-0.5 text-14 text-text"
                  >
                    {{ $t(`alerts.drawer.defaultScope.${ruleKeyId}`) }}
                  </span>
                </template>
                <span class="text-text-muted">{{ $t('alerts.drawer.is') }}</span>
                <ComboBox
                  v-if="isNew || rule?.type === 'threshold'"
                  :model-value="form.op"
                  :options="[
                    { value: '>', label: $t('alerts.custom.above') },
                    { value: '<', label: $t('alerts.custom.below') },
                  ]"
                  :label="$t('alerts.custom.condition')"
                  class="w-28"
                  @update:model-value="form.op = ($event as '>' | '<') ?? form.op"
                />
                <span v-else class="text-text-muted">{{
                  form.op === '<' ? $t('alerts.custom.below') : $t('alerts.custom.above')
                }}</span>
                <input
                  v-model="form.value"
                  type="number"
                  step="any"
                  :class="slot"
                  :aria-label="$t('alerts.custom.threshold')"
                  data-testid="drawer-threshold"
                />
                <span class="text-text-muted">{{ unitLabel }} {{ $t('alerts.drawer.for') }}</span>
                <input
                  v-model.number="form.forMinutes"
                  type="number"
                  min="0"
                  max="1440"
                  :class="slot"
                  :aria-label="$t('alerts.rules.forMinutes')"
                  data-testid="drawer-for"
                />
                <span class="text-text-muted">{{ $t('alerts.drawer.min') }}</span>
              </div>
              <div v-else class="flex flex-wrap items-center gap-2 text-14 leading-loose">
                <span class="text-text-muted"
                  ><RuleSentence :rule="{ ...rule!, forSeconds: 0 }"
                /></span>
                <span class="text-text-muted">{{ $t('alerts.drawer.for') }}</span>
                <input
                  v-model.number="form.forMinutes"
                  type="number"
                  min="0"
                  max="1440"
                  :class="slot"
                  :aria-label="$t('alerts.rules.forMinutes')"
                  data-testid="drawer-for"
                />
                <span class="text-text-muted">{{ $t('alerts.drawer.min') }}</span>
              </div>
              <div
                v-if="
                  (isNew || rule?.type === 'threshold') &&
                  form.scopeKind !== 'cluster' &&
                  form.scopeKind !== 'service'
                "
                class="flex flex-wrap gap-2"
              >
                <template v-if="form.scopeKind === 'workload'">
                  <TextField
                    v-model="form.workload.namespace"
                    :label="$t('alerts.matchers.namespace')"
                    class="w-36"
                  />
                  <TextField
                    v-model="form.workload.name"
                    :label="$t('alerts.matchers.workload')"
                    class="w-44"
                  />
                </template>
                <TextField
                  v-else
                  v-model="form.scopeText"
                  :label="$t(`alerts.custom.scopeInput.${form.scopeKind}`)"
                  :hint="$t(`alerts.custom.scopeHint.${form.scopeKind}`)"
                  class="w-full"
                  data-testid="drawer-scope-text"
                />
              </div>
            </div>

            <!-- THEN -->
            <div class="flex flex-col gap-2">
              <span class="text-12 tracking-wide text-text-subtle uppercase">{{
                $t('alerts.drawer.then')
              }}</span>
              <div v-if="isMetric" class="flex flex-wrap items-center gap-2 text-14 leading-loose">
                <span class="text-text-muted">{{ $t('alerts.drawer.raise') }}</span>
                <TonePill tone="warning" :label="$t('alerts.severity.warning')" />
                <span class="text-text-muted"
                  >·
                  {{
                    form.op === '<' ? $t('alerts.custom.below') : $t('alerts.custom.above')
                  }}</span
                >
                <input
                  v-model="form.critical"
                  type="number"
                  step="any"
                  :placeholder="$t('alerts.rules.none')"
                  :class="slot"
                  :aria-label="$t('alerts.rules.criticalThreshold')"
                  data-testid="drawer-critical"
                />
                <span class="text-text-muted"
                  >{{ unitLabel }} {{ $t('alerts.drawer.makeIt') }}</span
                >
                <TonePill tone="critical" :label="$t('alerts.severity.critical')" />
                <span class="text-12 text-text-subtle">{{ $t('alerts.drawer.optional') }}</span>
              </div>
              <div v-else class="flex flex-wrap items-center gap-2 text-14">
                <span class="text-text-muted">{{ $t('alerts.drawer.raise') }}</span>
                <div
                  class="inline-flex overflow-hidden rounded-control border border-border"
                  role="radiogroup"
                  :aria-label="$t('alerts.columns.severity')"
                >
                  <label
                    v-for="s in ['warning', 'critical'] as const"
                    :key="s"
                    :class="[
                      'flex cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1 text-13 last:border-r-0 max-lg:min-h-11',
                      form.severity === s
                        ? 'bg-surface-3 text-text'
                        : 'text-text-muted hover:bg-surface-2',
                    ]"
                  >
                    <input
                      v-model="form.severity"
                      type="radio"
                      :value="s"
                      class="sr-only"
                      :data-testid="`drawer-severity-${s}`"
                    />
                    <component
                      :is="s === 'critical' ? CircleX : TriangleAlert"
                      :class="['size-3.5', s === 'critical' ? 'text-critical' : 'text-warning']"
                      aria-hidden="true"
                    />
                    {{ $t(`alerts.severity.${s}`) }}
                  </label>
                </div>
              </div>
            </div>

            <!-- SEND TO -->
            <div class="flex flex-col gap-2">
              <span class="text-12 tracking-wide text-text-subtle uppercase">{{
                $t('alerts.drawer.sendTo')
              }}</span>
              <ComboBox
                v-model="form.channelIds"
                multiple
                clearable
                :options="channelOptions"
                :label="$t('alerts.drawer.sendTo')"
                :placeholder="$t('alerts.rules.uiOnly')"
                :empty-text="$t('alerts.rules.noChannels')"
                testid="drawer-channels"
              />
              <div class="flex flex-wrap items-center gap-2 text-14">
                <span class="text-text-muted">{{ $t('alerts.drawer.remind') }}</span>
                <ComboBox
                  :model-value="String(form.renotify)"
                  :options="
                    REMIND.map((r) => ({
                      value: String(r),
                      label: $t(`alerts.drawer.remindOptions.${r}`),
                    }))
                  "
                  :label="$t('alerts.drawer.remind')"
                  class="w-36"
                  testid="drawer-remind"
                  @update:model-value="form.renotify = Number($event ?? form.renotify)"
                />
                <span class="text-text-muted">{{ $t('alerts.drawer.whileItLasts') }}</span>
              </div>
            </div>

            <!-- PREVIEW -->
            <section
              class="rounded-card border border-border bg-surface-2 p-3"
              data-testid="drawer-preview"
              aria-live="polite"
            >
              <template v-if="isMetric">
                <TimeSeriesChart
                  :title="$t('alerts.drawer.previewTitle', { name: preview?.series?.name ?? '' })"
                  :unit="(unit ?? 'count') as Unit"
                  :series="series"
                  :window="previewWindow"
                  :thresholds="thresholds"
                  :loading="previewing && !preview"
                  :error="previewError"
                  :empty-text="$t('alerts.custom.previewEmpty')"
                  :error-text="$t('alerts.custom.previewError')"
                  @retry="loadPreview"
                />
                <p v-if="preview" class="mt-2 text-13 text-text-muted" data-testid="drawer-fired">
                  {{ $t('alerts.drawer.wouldHaveFired', { n: preview.fired }, preview.fired) }}
                  <template v-if="preview.fired">
                    {{
                      preview.critical
                        ? $t('alerts.drawer.ofWhichCritical', { n: preview.critical })
                        : $t('alerts.drawer.warningOnly')
                    }}
                  </template>
                </p>
              </template>
              <template v-else-if="preview">
                <!-- State rules: the chart of the latest alert, as on its page. -->
                <AlertChart
                  v-if="preview.chart"
                  :chart="preview.chart"
                  :severity="form.severity"
                  data-testid="drawer-state-chart"
                />
                <p class="mt-2 text-13 text-text-muted" data-testid="drawer-fired">
                  {{ $t('alerts.drawer.firedLastWeek', { n: preview.fired }, preview.fired) }}
                </p>
              </template>
            </section>

            <!-- ADVANCED -->
            <div class="border-t border-dashed border-border pt-3 text-13 text-text-muted">
              <button
                type="button"
                class="flex items-center gap-1.5 text-left hover:text-text max-lg:min-h-11"
                :aria-expanded="showAdvanced"
                @click="showAdvanced = !showAdvanced"
              >
                <ChevronRight
                  :class="['size-4 transition-transform', showAdvanced ? 'rotate-90' : '']"
                  aria-hidden="true"
                />
                {{ $t('alerts.drawer.advanced') }}
              </button>
              <div v-if="showAdvanced" class="mt-2 flex flex-col gap-2 pl-5">
                <TextField
                  v-if="isNew || rule?.type === 'threshold'"
                  v-model="form.name"
                  :label="$t('alerts.custom.name')"
                  :hint="$t('alerts.custom.nameHint')"
                  :maxlength="200"
                />
                <p>{{ $t('alerts.drawer.resolveInfo') }}</p>
                <p>{{ $t('alerts.drawer.flappingInfo') }}</p>
              </div>
            </div>
            <p v-if="error" class="text-13 text-critical" role="alert" data-testid="drawer-error">
              {{ error }}
            </p>
          </div>

          <footer
            class="mt-auto flex items-center gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <BaseButton
              v-if="isDefault || !!rule?.defaultKey"
              variant="ghost"
              :disabled="saving"
              data-testid="drawer-reset"
              @click="resetToDefault"
            >
              {{ $t('alerts.drawer.reset') }}
            </BaseButton>
            <span class="flex-1" />
            <DialogClose as-child>
              <BaseButton variant="secondary">{{ $t('common.cancel') }}</BaseButton>
            </DialogClose>
            <BaseButton type="submit" :loading="saving" data-testid="drawer-save">{{
              $t('alerts.drawer.save')
            }}</BaseButton>
          </footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
