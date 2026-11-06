<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Cluster, CreateSilenceRequest, Silence } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ComboBox from '@/components/ui/ComboBox.vue';
import TextField from '@/components/ui/TextField.vue';

// "Silence…" (alerts redesign item 7): silence by cluster, namespace, workload, node or
// severity for a while, e.g. during maintenance (ADR-077).
defineProps<{ clusters: Cluster[] }>();
const emit = defineEmits<{ done: [silence: Silence]; cancel: [] }>();
const { t } = useI18n();

const DURATIONS = [60, 240, 1440, 10080] as const;
const cluster = ref<string | null>(null);
const severity = ref<string | null>(null);
const namespace = ref('');
const workload = ref('');
const node = ref('');
const minutes = ref<number>(60);
const comment = ref('');
const error = ref<string>();
const saving = ref(false);

const matchers = computed(() => {
  const m: Record<string, string> = {};
  if (cluster.value) m.cluster = cluster.value;
  if (severity.value) m.severity = severity.value;
  for (const [k, v] of [
    ['namespace', namespace.value],
    ['workload', workload.value],
    ['node', node.value],
  ] as const) {
    if (v.trim()) m[k] = v.trim();
  }
  return m;
});

async function submit() {
  error.value = undefined;
  if (Object.keys(matchers.value).length === 0) {
    error.value = t('alerts.silence.needMatcher');
    return;
  }
  saving.value = true;
  try {
    const body: CreateSilenceRequest = {
      matchers: matchers.value as CreateSilenceRequest['matchers'],
      durationMinutes: minutes.value,
      comment: comment.value.trim(),
    };
    emit('done', await api<Silence>('/silences', { method: 'POST', body }));
  } catch (err) {
    error.value =
      err instanceof ApiError && err.problem?.detail
        ? err.problem.detail
        : t('alerts.silence.failed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
    data-testid="new-silence-form"
    novalidate
    @submit.prevent="submit"
  >
    <div>
      <h3 class="text-14 font-semibold text-text">{{ $t('alerts.silence.newTitle') }}</h3>
      <p class="mt-1 text-13 text-text-muted">{{ $t('alerts.silence.newIntro') }}</p>
    </div>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <span class="text-13 font-medium text-text">{{ $t('alerts.matchers.cluster') }}</span>
        <ComboBox
          v-model="cluster"
          clearable
          :options="
            clusters.map((c) => ({
              value: c.id,
              label: c.name,
              description: $t(`clusters.kind.${c.kind}`),
            }))
          "
          :label="$t('alerts.matchers.cluster')"
          :placeholder="$t('alerts.silence.any')"
          testid="silence-cluster"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-13 font-medium text-text">{{ $t('alerts.matchers.severity') }}</span>
        <ComboBox
          v-model="severity"
          clearable
          :options="[
            { value: 'warning', label: $t('alerts.severity.warning') },
            { value: 'critical', label: $t('alerts.severity.critical') },
          ]"
          :label="$t('alerts.matchers.severity')"
          :placeholder="$t('alerts.silence.any')"
          testid="silence-severity"
        />
      </div>
      <TextField
        v-model="namespace"
        :label="$t('alerts.matchers.namespace')"
        :placeholder="$t('alerts.silence.any')"
      />
      <TextField
        v-model="workload"
        :label="$t('alerts.matchers.workload')"
        :placeholder="$t('alerts.silence.any')"
      />
      <TextField
        v-model="node"
        :label="$t('alerts.matchers.node')"
        :placeholder="$t('alerts.silence.any')"
      />
    </div>
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1.5 text-13 font-medium text-text">{{ $t('alerts.silence.for') }}</legend>
      <div class="flex flex-wrap gap-2">
        <label
          v-for="d in DURATIONS"
          :key="d"
          :class="[
            'flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-13 max-lg:min-h-11',
            minutes === d
              ? 'border-primary bg-primary-soft text-text'
              : 'border-border text-text-muted hover:bg-surface-2',
          ]"
        >
          <input
            v-model="minutes"
            type="radio"
            name="new-silence-duration"
            :value="d"
            class="accent-primary"
          />
          {{ $t(`alerts.silence.durations.${d}`) }}
        </label>
      </div>
    </fieldset>
    <TextField
      v-model="comment"
      :label="$t('alerts.silence.comment')"
      :hint="$t('alerts.silence.commentHint')"
      :maxlength="1000"
    />
    <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
    <div class="flex gap-2">
      <BaseButton type="submit" :loading="saving" data-testid="new-silence-submit">{{
        $t('alerts.silence.submit')
      }}</BaseButton>
      <BaseButton variant="ghost" @click="emit('cancel')">{{ $t('common.cancel') }}</BaseButton>
    </div>
  </form>
</template>
