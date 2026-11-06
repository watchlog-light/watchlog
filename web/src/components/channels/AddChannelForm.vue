<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { CreateAlertChannelRequest, CreatedAlertChannel } from '@watchlog/api-types';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import CodeBlock from '@/components/ui/CodeBlock.vue';
import TextField from '@/components/ui/TextField.vue';

// Adds a Slack, email or webhook channel (Telegram has its own guided setup). A
// webhook's signing secret is shown once, here, before the form closes.
const props = defineProps<{ type: 'slack' | 'email' | 'webhook'; firstChannel: boolean }>();
const emit = defineEmits<{ created: []; cancel: [] }>();
const { t } = useI18n();

const name = ref('');
const target = ref('');
const useForAll = ref(props.firstChannel);
const error = ref<string>();
const saving = ref(false);
const secret = ref<string | null>(null);

function settings(): CreateAlertChannelRequest['settings'] {
  const v = target.value.trim();
  if (props.type === 'slack') return { webhookUrl: v };
  if (props.type === 'webhook') return { url: v };
  return { recipients: v.split(/[\s,;]+/).filter(Boolean) };
}

async function create() {
  error.value = undefined;
  saving.value = true;
  try {
    const res = await api<CreatedAlertChannel>('/alert-channels', {
      method: 'POST',
      body: {
        type: props.type,
        name: name.value.trim() || t(`channels.types.${props.type}`),
        settings: settings(),
        useForAllRules: useForAll.value,
      } satisfies CreateAlertChannelRequest,
    });
    if (res.signingSecret) secret.value = res.signingSecret;
    else emit('created');
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 400 && err.problem?.detail
        ? err.problem.detail
        : t('channels.errors.create');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div
    v-if="secret"
    class="mt-2 flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
    data-testid="signing-secret"
  >
    <p class="text-13 text-text">{{ $t('channels.signingSecret') }}</p>
    <CodeBlock :code="secret" :label="$t('channels.signingSecretLabel')" />
    <BaseButton class="self-start" @click="emit('created')">{{ $t('channels.done') }}</BaseButton>
  </div>
  <form
    v-else
    class="mt-2 flex flex-col gap-3 rounded-control border border-border bg-surface-2 p-3"
    :data-testid="`add-${type}-form`"
    novalidate
    @submit.prevent="create"
  >
    <TextField
      v-model="target"
      :label="$t(`channels.form.target.${type}`)"
      :hint="$t(`channels.form.targetHint.${type}`)"
      required
    />
    <TextField
      v-model="name"
      :label="$t('channels.form.name')"
      :hint="$t('channels.form.nameHint')"
      :maxlength="100"
    />
    <label class="flex items-center gap-2 text-13 text-text max-lg:min-h-11">
      <input v-model="useForAll" type="checkbox" class="accent-primary" />
      {{ $t('channels.form.useForAll') }}
    </label>
    <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
    <div class="flex gap-2">
      <BaseButton type="submit" :loading="saving" :data-testid="`add-${type}-submit`">
        {{ $t('channels.form.submit') }}
      </BaseButton>
      <BaseButton variant="ghost" @click="emit('cancel')">{{ $t('common.cancel') }}</BaseButton>
    </div>
  </form>
</template>
