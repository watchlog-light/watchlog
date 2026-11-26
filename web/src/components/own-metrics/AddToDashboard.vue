<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "Add to a dashboard" from a metric's page (1.0.0, ADR-237): pick a dashboard, or name a new
// one; the metric lands there as a medium line (a timestamp as a small number), ready to be
// changed in the dashboard's edit mode.
import type { OwnMetric } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownDashboardsApi } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { useLoader } from '@/composables/useLoader';
import { toInput, widgetFor } from '@/lib/own-dashboard';

const props = defineProps<{ metric: OwnMetric; cluster: { id: string; name: string } }>();
const emit = defineEmits<{ added: [dashboard: { id: string; name: string }] }>();
const open = defineModel<boolean>('open', { required: true });
const { t } = useI18n();
const NEW = '__new__';

const list = useLoader(() => ownDashboardsApi.list());
const choice = ref<string | null>(null);
const name = ref('');
const error = ref('');
const busy = ref(false);
watch(
  open,
  async (v) => {
    if (!v) return;
    error.value = '';
    name.value = '';
    await list.load();
    const all = list.data.value?.dashboards ?? [];
    choice.value = all[0]?.id ?? NEW;
  },
  { immediate: true },
);
const canMake = computed(() => {
  const d = list.data.value;
  return !!d && d.dashboards.length < d.limits.dashboards;
});
const options = computed(() => [
  ...(list.data.value?.dashboards ?? []).map((d) => ({
    value: d.id,
    label: d.name,
    description: t('ownMetrics.dashboards.widgets', { n: d.widgets }, d.widgets),
  })),
  ...(canMake.value ? [{ value: NEW, label: t('ownMetrics.dashboards.newOption') }] : []),
]);

async function add() {
  error.value = '';
  busy.value = true;
  try {
    let id = choice.value;
    let title = '';
    if (id === NEW || !id) {
      if (!name.value.trim()) {
        error.value = t('ownMetrics.dashboards.nameNeeded');
        return;
      }
      const made = await ownDashboardsApi.create(name.value.trim());
      id = made.id;
      title = made.name;
    }
    const board = await ownDashboardsApi.get(id);
    const w = widgetFor(props.metric, props.cluster.id, props.cluster.name, board.widgets);
    await ownDashboardsApi.save(id, { widgets: [...board.widgets.map(toInput), toInput(w)] });
    open.value = false;
    emit('added', { id, name: title || board.name });
  } catch (err) {
    error.value =
      (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.dashboards.failed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="$t('ownMetrics.dashboards.addTitle')"
    :description="metric.name"
  >
    <form class="flex flex-col gap-4" data-testid="own-addto" @submit.prevent="add">
      <label class="flex flex-col gap-1.5 text-13 text-text-muted">
        {{ $t('ownMetrics.dashboards.which') }}
        <ComboBox
          v-model="choice"
          :options="options"
          :label="$t('ownMetrics.dashboards.which')"
          testid="own-addto-which"
        />
      </label>
      <TextField
        v-if="choice === NEW"
        v-model="name"
        :label="$t('ownMetrics.dashboards.name')"
        :maxlength="80"
      />
      <p v-if="error" class="text-13 text-critical-text" role="alert" data-testid="own-addto-error">
        {{ error }}
      </p>
      <div class="flex justify-end gap-2">
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.cancel') }}</BaseButton>
        <BaseButton type="submit" :loading="busy" data-testid="own-addto-add">
          {{ $t('ownMetrics.editor.addTo') }}
        </BaseButton>
      </div>
    </form>
  </ModalDialog>
</template>
