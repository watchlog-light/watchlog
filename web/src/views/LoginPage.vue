<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const email = ref('');
const password = ref('');
const error = ref<string>();
const submitting = ref(false);

function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return t('auth.errors.generic');
  if (err.status === 401) return t('auth.errors.invalidCredentials');
  if (err.status === 429) return t('auth.errors.tooManyAttempts');
  if (err.status === 0 || err.status >= 500) return t('auth.errors.unavailable');
  return t('auth.errors.generic');
}

async function submit() {
  error.value = undefined;
  submitting.value = true;
  try {
    await auth.login({ email: email.value.trim(), password: password.value });
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    // Only follow same-app paths, never absolute URLs.
    await router.replace(redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AuthCard :title="$t('auth.login.title')" :intro="$t('auth.login.intro')">
    <form class="flex flex-col gap-4" novalidate @submit.prevent="submit">
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
        autocomplete="current-password"
        required
      />
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton type="submit" block :loading="submitting">
        {{ $t('auth.login.submit') }}
      </BaseButton>
    </form>
  </AuthCard>
</template>
