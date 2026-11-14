<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ResetInfo, UserEnvelope } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useLoader } from '@/composables/useLoader';
import { useAuthStore } from '@/stores/auth';

// Set a new password from a reset link (ADR-140): it works once and for one hour;
// setting it signs the account out everywhere, then signs in here (Cloud with 2FA on:
// after the code).
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const token = computed(() => String(route.params.token));
const info = useLoader(() => api<ResetInfo>(`/password-resets/${token.value}`));
onMounted(info.load);

const password = ref('');
const error = ref<string>();
const busy = ref(false);

async function save() {
  error.value = undefined;
  if (password.value.length < 12) {
    error.value = t('invite.tooShort');
    return;
  }
  busy.value = true;
  try {
    const res = await api<UserEnvelope | { mfaRequired: true }>(`/password-resets/${token.value}`, {
      method: 'POST',
      body: { password: password.value },
    });
    // Cloud with 2FA on: the password is set; the code signs in (a link is no second factor).
    if ('mfaRequired' in res) {
      await router.replace({ name: 'signin-2fa' });
      return;
    }
    auth.user = res.user;
    await router.replace('/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : t('auth.errors.generic');
    if (err instanceof ApiError && err.status === 410) void info.load();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthCard
    v-if="info.data.value?.status === 'valid'"
    :title="$t('reset.title')"
    :intro="$t('reset.intro', { email: info.data.value.email })"
  >
    <form class="flex flex-col gap-4" novalidate data-testid="reset" @submit.prevent="save">
      <TextField
        v-model="password"
        :label="$t('reset.password')"
        :hint="$t('invite.passwordHint')"
        type="password"
        autocomplete="new-password"
        required
      />
      <p
        v-if="error"
        role="alert"
        class="rounded-control border border-critical bg-surface-2 px-3 py-2 text-13 text-text"
      >
        {{ error }}
      </p>
      <BaseButton type="submit" block :loading="busy" data-testid="reset-submit">{{
        $t('reset.submit')
      }}</BaseButton>
      <p class="text-12 text-text-muted">{{ $t('reset.foot') }}</p>
    </form>
  </AuthCard>
  <AuthCard
    v-else-if="info.data.value || info.error.value"
    :title="$t('reset.goneTitle')"
    :intro="info.data.value?.status === 'used' ? $t('reset.used') : $t('reset.expired')"
  >
    <RouterLink
      :to="{ name: 'login' }"
      class="self-center text-13 text-text-muted hover:text-text max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
      data-testid="reset-gone"
    >
      {{ $t('invite.signIn') }}
    </RouterLink>
  </AuthCard>
</template>
