<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

// Mirrors the backend rule (MIN_PASSWORD_LENGTH, ADR-034).
const MIN_PASSWORD_LENGTH = 10;

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

const code = ref('');
const name = ref('');
const email = ref('');
const password = ref('');
const error = ref<string>();
const submitted = ref(false);
const submitting = ref(false);

const passwordError = computed(() =>
  submitted.value && password.value.length < MIN_PASSWORD_LENGTH
    ? t('auth.setup.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
    : undefined,
);

function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return t('auth.errors.generic');
  if (err.status === 403) return t('auth.errors.invalidCode');
  if (err.status === 409) return t('auth.errors.setupDone');
  if (err.status === 429) return t('auth.errors.tooManyAttempts');
  if (err.status === 400) return t('auth.errors.invalidInput');
  if (err.status === 0 || err.status >= 500) return t('auth.errors.unavailable');
  return t('auth.errors.generic');
}

async function submit() {
  submitted.value = true;
  error.value = undefined;
  if (passwordError.value) return;
  submitting.value = true;
  try {
    await auth.completeSetup({
      code: code.value.trim(),
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
    });
    await router.replace('/');
  } catch (err) {
    error.value = errorMessage(err);
    if (err instanceof ApiError && err.status === 409) {
      auth.setupRequired = false;
      await router.replace({ name: 'login' });
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthCard :title="$t('auth.setup.title')" :intro="$t('auth.setup.intro')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
      <TextField
        v-model="code"
        :label="$t('auth.setup.code')"
        :hint="$t('auth.setup.codeHint')"
        autocomplete="one-time-code"
        mono
        required
        :maxlength="32"
      />
      <TextField
        v-model="name"
        :label="$t('auth.fields.name')"
        autocomplete="name"
        required
        :maxlength="100"
      />
      <TextField
        v-model="email"
        :label="$t('auth.fields.email')"
        type="email"
        autocomplete="username"
        required
      />
      <TextField
        v-model="password"
        :label="$t('auth.fields.password')"
        type="password"
        autocomplete="new-password"
        :hint="$t('auth.setup.passwordHint', { min: MIN_PASSWORD_LENGTH })"
        :error="passwordError"
        required
        :minlength="MIN_PASSWORD_LENGTH"
      />
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton type="submit" block :loading="submitting">
        {{ $t('auth.setup.submit') }}
      </BaseButton>
    </form>
  </AuthCard>
</template>
