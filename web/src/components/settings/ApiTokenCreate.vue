<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Lock, TriangleAlert } from '@lucide/vue';
import type { CreateApiTokenResponse } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import ApiTokenReveal from '@/components/settings/ApiTokenReveal.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import TextField from '@/components/ui/TextField.vue';
import { useNarrow } from '@/composables/useNarrow';
import {
  DEFAULT_EXPIRY,
  EXPIRY_CHOICES,
  expiryDate,
  formatDay,
  type ExpiryChoice,
} from '@/lib/api-tokens';

// Create a token (name, expiry; always read only), then show it once with the snippets
// for each app (ADR-125). The reveal can't be dismissed until the user says they stored it.
const props = defineProps<{ baseUrl: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [] }>();
const { t } = useI18n();
const narrow = useNarrow();

const name = ref('');
const expiry = ref<ExpiryChoice>(DEFAULT_EXPIRY);
const error = ref<string>();
const submitting = ref(false);
const created = ref<CreateApiTokenResponse>();

// A fresh form every time it opens; the token value is dropped when it closes.
watch(open, (now) => {
  if (now) {
    name.value = '';
    expiry.value = DEFAULT_EXPIRY;
    error.value = undefined;
    created.value = undefined;
  } else {
    created.value = undefined;
  }
});

const expiryLine = computed(() => {
  const date = expiryDate(expiry.value);
  return date
    ? t('apiTokens.create.expiresOn', { date: formatDay(date) })
    : t('apiTokens.create.neverExpires');
});

async function create() {
  if (!name.value.trim() || submitting.value) return;
  error.value = undefined;
  submitting.value = true;
  try {
    created.value = await api<CreateApiTokenResponse>('/api-tokens', {
      method: 'POST',
      body: { name: name.value.trim(), expiresInDays: expiry.value },
    });
    emit('created');
  } catch (err) {
    error.value =
      err instanceof ApiError && err.status === 409 && err.problem?.detail
        ? err.problem.detail
        : t('apiTokens.create.failed');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="
      created
        ? t('apiTokens.reveal.title', { name: created.token.name })
        : t('apiTokens.create.title')
    "
    :description="created ? t('apiTokens.reveal.once') : t('apiTokens.create.intro')"
    :warn="!!created"
    :size="created ? 'lg' : 'md'"
    :locked="!!created"
  >
    <template v-if="created" #icon>
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-ok"
        aria-hidden="true"
      >
        <Check class="size-4.5" />
      </span>
    </template>

    <ApiTokenReveal
      v-if="created"
      :token="created.token"
      :value="created.value"
      :base-url="props.baseUrl"
      @done="open = false"
    />

    <form
      v-else
      class="flex flex-col gap-5"
      data-testid="api-token-create-form"
      novalidate
      @submit.prevent="create"
    >
      <TextField
        v-model="name"
        :label="$t('apiTokens.create.name')"
        :placeholder="$t('apiTokens.create.namePlaceholder')"
        :hint="$t('apiTokens.create.nameHint')"
        :maxlength="100"
        required
        data-testid="api-token-name"
      />
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-2 text-13 font-medium text-text">
          {{ $t('apiTokens.create.expires') }}
        </legend>
        <div class="grid grid-cols-4 gap-1.5" data-testid="api-token-expiry">
          <button
            v-for="days in EXPIRY_CHOICES"
            :key="String(days)"
            type="button"
            :aria-pressed="expiry === days"
            :class="[
              'h-11 rounded-control border px-1 text-13 font-medium transition-colors',
              expiry === days
                ? 'border-primary bg-primary-soft text-text'
                : 'border-border-strong text-text-muted hover:bg-surface-2 hover:text-text',
            ]"
            @click="expiry = days"
          >
            {{ $t(`apiTokens.create.choice.${days ?? 'never'}`) }}
          </button>
        </div>
        <p class="text-12 text-text-muted" data-testid="api-token-expiry-line">{{ expiryLine }}</p>
        <p
          v-if="expiry === null"
          class="flex gap-2.5 rounded-control border border-warning/40 bg-warning/10 px-3 py-2.5 text-13 leading-relaxed text-warning"
        >
          <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {{ $t('apiTokens.create.neverWarning') }}
        </p>
      </fieldset>
      <div class="flex gap-3 rounded-control border border-border bg-bg p-3.5">
        <Lock class="mt-0.5 size-4.5 shrink-0 text-text-muted" aria-hidden="true" />
        <div class="flex flex-col gap-1">
          <span class="text-13 font-semibold text-text">{{
            $t('apiTokens.create.scopeTitle')
          }}</span>
          <span class="text-13 leading-relaxed text-text-muted">{{
            $t('apiTokens.create.scopeText')
          }}</span>
        </div>
      </div>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
      <div :class="narrow ? 'grid grid-cols-2 gap-2' : 'flex justify-end gap-2'">
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.cancel') }}</BaseButton>
        <BaseButton
          type="submit"
          :disabled="!name.trim()"
          :loading="submitting"
          data-testid="api-token-create-submit"
        >
          {{ $t('apiTokens.create.submit') }}
        </BaseButton>
      </div>
    </form>
  </ModalDialog>
</template>
