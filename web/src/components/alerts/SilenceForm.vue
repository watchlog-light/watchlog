<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { Alert, CreateSilenceRequest, Silence } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { alertWhere, silenceMatchersFor } from '@/lib/alerts';

// Silence an alert's rule and scope for a while, with a comment (ADR-077).
const props = defineProps<{ alert: Alert }>();
const emit = defineEmits<{ done: [silence: Silence]; cancel: [] }>();
const { t } = useI18n();

const DURATIONS = [60, 240, 1440, 10080] as const;
const minutes = ref<number>(60);
const comment = ref('');
const error = ref<string>();
const saving = ref(false);
const matchers = computed(() => silenceMatchersFor(props.alert));

async function submit() {
  error.value = undefined;
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
      err instanceof ApiError && err.status === 403
        ? t('alerts.silence.forbidden')
        : t('alerts.silence.failed');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form
    class="flex flex-col gap-4 rounded-card border border-border bg-surface-1 p-5"
    data-testid="silence-form"
    novalidate
    @submit.prevent="submit"
  >
    <div>
      <h3 class="text-14 font-semibold text-text">{{ $t('alerts.silence.title') }}</h3>
      <p class="mt-1 text-13 text-text-muted">
        {{ $t('alerts.silence.scope', { rule: alert.rule.name, where: alertWhere(alert) }) }}
      </p>
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
          <input v-model="minutes" type="radio" name="duration" :value="d" class="accent-primary" />
          {{ $t(`alerts.silence.durations.${d}`) }}
        </label>
      </div>
    </fieldset>
    <TextField
      v-model="comment"
      :label="$t('alerts.silence.comment')"
      :hint="$t('alerts.silence.commentHint')"
      :error="error"
      :maxlength="1000"
    />
    <div class="flex gap-2">
      <BaseButton type="submit" :loading="saving" data-testid="silence-submit">
        {{ $t('alerts.silence.submit') }}
      </BaseButton>
      <BaseButton variant="ghost" @click="$emit('cancel')">{{ $t('common.cancel') }}</BaseButton>
    </div>
  </form>
</template>
