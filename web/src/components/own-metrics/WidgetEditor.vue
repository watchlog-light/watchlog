<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The side panel that makes or changes a widget (1.0.0, ADR-237): a metric, how it is shown,
// one label to split by, a size and a title, with a live preview. No queries: there is no
// field to write one in.
import type { OwnMetric, OwnWidget } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import DashboardWidget from '@/components/own-metrics/DashboardWidget.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';
import { SHAPES, SIZES, widgetFor, type WidgetShape, type WidgetWidth } from '@/lib/own-dashboard';
import { ownerText } from '@/lib/own-metrics';

const props = defineProps<{
  /** The widget being changed; null to make a new one. */
  widget: OwnWidget | null;
  /** The metrics of the cluster the page is on. */
  metrics: OwnMetric[];
  cluster: { id: string; name: string };
  taken: OwnWidget[];
}>();
const emit = defineEmits<{ apply: [widget: OwnWidget]; close: [] }>();
const { t } = useI18n();
const NO_SPLIT = '__none__';

const draft = ref<OwnWidget | null>(null);
/** The title follows the metric until it is typed over. */
const titled = ref(false);
function start() {
  if (props.widget) {
    draft.value = { ...props.widget };
    titled.value = true;
  } else {
    const first = props.metrics[0];
    draft.value = first
      ? widgetFor(first, props.cluster.id, props.cluster.name, props.taken)
      : null;
    titled.value = false;
  }
}
watch(() => props.widget?.id, start, { immediate: true });

/** A widget of another cluster keeps its metric: this panel lists this cluster's only. */
const foreign = computed(() => !!props.widget && props.widget.clusterId !== props.cluster.id);
const metricOptions = computed(() =>
  props.metrics.map((m) => ({
    value: m.name,
    label: m.name,
    description: [m.words, ...m.owners.slice(0, 1).map((o) => ownerText(o) ?? '')]
      .filter(Boolean)
      .join(' · '),
  })),
);
const metricModel = computed<string | null>({
  get: () => draft.value?.metric ?? null,
  set: (name) => {
    const m = props.metrics.find((x) => x.name === name);
    if (!m || !draft.value) return;
    const fresh = widgetFor(m, props.cluster.id, props.cluster.name, props.taken);
    draft.value = {
      ...fresh,
      id: draft.value.id,
      w: draft.value.w,
      shape: fresh.shape === 'number' ? 'number' : draft.value.shape,
      title: titled.value ? draft.value.title : fresh.title,
    };
  },
});
const labels = computed(() => draft.value?.resolved?.labels ?? []);
const splitOptions = computed(() => [
  { value: NO_SPLIT, label: t('ownMetrics.detail.splitNothing') },
  ...labels.value.map((l) => ({ value: l, label: l })),
  // A label the metric no longer lists stays choosable while the widget has it.
  ...(draft.value?.by && !labels.value.includes(draft.value.by)
    ? [{ value: draft.value.by, label: draft.value.by }]
    : []),
]);
const splitModel = computed<string | null>({
  get: () => draft.value?.by ?? NO_SPLIT,
  set: (v) => {
    if (draft.value) draft.value = { ...draft.value, by: !v || v === NO_SPLIT ? null : v };
  },
});
const setShape = (shape: WidgetShape) => {
  if (!draft.value) return;
  draft.value = { ...draft.value, shape, ...(shape === 'number' ? { by: null } : {}) };
};
const setWidth = (w: WidgetWidth) => {
  if (draft.value) draft.value = { ...draft.value, w };
};
const title = computed<string>({
  get: () => draft.value?.title ?? '',
  set: (v) => {
    titled.value = true;
    if (draft.value) draft.value = { ...draft.value, title: v };
  },
});

function apply() {
  if (!draft.value) return;
  emit('apply', {
    ...draft.value,
    title: draft.value.title.trim() || (draft.value.resolved?.words ?? draft.value.metric),
  });
}
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="own-editor">
    <header class="flex items-center justify-between gap-3">
      <h2 class="text-16 font-semibold text-text">
        {{ $t(widget ? 'ownMetrics.editor.change' : 'ownMetrics.editor.add') }}
      </h2>
      <BaseButton variant="ghost" data-testid="own-editor-close" @click="emit('close')">
        {{ $t('common.close') }}
      </BaseButton>
    </header>
    <p v-if="!draft" class="text-14 text-text-muted" data-testid="own-editor-none">
      {{ $t('ownMetrics.editor.noMetrics') }}
    </p>
    <template v-else>
      <div class="flex flex-col gap-1.5">
        <span class="text-12 font-medium text-text-muted">{{
          $t('ownMetrics.editor.metric')
        }}</span>
        <p v-if="foreign" class="font-mono text-13 break-all text-text">
          {{ draft.metric }} · {{ draft.clusterName }}
        </p>
        <ComboBox
          v-else
          v-model="metricModel"
          :options="metricOptions"
          :label="$t('ownMetrics.editor.metric')"
          :empty-text="$t('ownMetrics.list.none')"
          testid="own-editor-metric"
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <span id="own-editor-shape" class="text-12 font-medium text-text-muted">{{
          $t('ownMetrics.editor.shape')
        }}</span>
        <div class="grid grid-cols-4 gap-1.5" role="radiogroup" aria-labelledby="own-editor-shape">
          <button
            v-for="s in SHAPES"
            :key="s"
            type="button"
            role="radio"
            :aria-checked="draft.shape === s"
            :class="[
              'h-9 rounded-control border text-13 transition-colors max-lg:h-11',
              draft.shape === s
                ? 'border-primary bg-primary/10 text-text'
                : 'border-border text-text-muted hover:text-text',
            ]"
            :data-testid="`own-editor-shape-${s}`"
            @click="setShape(s)"
          >
            {{ $t(`ownMetrics.editor.shapes.${s}`) }}
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-12 font-medium text-text-muted">{{ $t('ownMetrics.editor.split') }}</span>
        <ComboBox
          v-model="splitModel"
          :options="splitOptions"
          :label="$t('ownMetrics.editor.split')"
          :disabled="draft.shape === 'number'"
          testid="own-editor-split"
        />
        <span v-if="draft.shape === 'number'" class="text-12 text-text-subtle">{{
          $t('ownMetrics.editor.numberNoSplit')
        }}</span>
      </div>

      <div class="flex flex-col gap-1.5">
        <span id="own-editor-size" class="text-12 font-medium text-text-muted">{{
          $t('ownMetrics.editor.size')
        }}</span>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby="own-editor-size">
          <button
            v-for="s in SIZES"
            :key="s.key"
            type="button"
            role="radio"
            :aria-checked="draft.w === s.w"
            :class="[
              'h-9 rounded-control border px-3 text-13 transition-colors max-lg:h-11',
              draft.w === s.w
                ? 'border-primary bg-primary/10 text-text'
                : 'border-border text-text-muted hover:text-text',
            ]"
            :data-testid="`own-editor-size-${s.w}`"
            @click="setWidth(s.w)"
          >
            {{ $t(`ownMetrics.editor.sizes.${s.key}`) }}
          </button>
        </div>
      </div>

      <TextField v-model="title" :label="$t('ownMetrics.editor.title')" :maxlength="80" />

      <div class="flex flex-col gap-1.5">
        <span class="text-12 font-medium text-text-muted">{{
          $t('ownMetrics.editor.preview')
        }}</span>
        <DashboardWidget :widget="draft" plain :current-cluster="cluster.id" />
      </div>

      <BaseButton block data-testid="own-editor-apply" @click="apply">
        {{ $t(widget ? 'ownMetrics.editor.update' : 'ownMetrics.editor.addTo') }}
      </BaseButton>
      <p class="text-12 leading-relaxed text-text-subtle">{{ $t('ownMetrics.editor.hint') }}</p>
    </template>
  </section>
</template>
