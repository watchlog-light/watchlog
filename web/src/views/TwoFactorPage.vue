<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { cloudApi, cloudErrorKey, problemCode } from '@/api/cloud';
import FormAlert from '@/components/cloud/FormAlert.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

// The sign-in's second step (ADR-175): after the password or GitHub/Google, a code from the
// authenticator app, or one of the recovery codes. The step lives 10 minutes and allows 5
// wrong codes; then the user signs in again (401 invalid-token).
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const recovery = ref(false);
const code = ref('');
const error = ref<string>();
const expired = ref(false);
const busy = ref(false);

const redirect = computed(() => {
  const r = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  return r.startsWith('/') && !r.startsWith('//') ? r : '/';
});

async function toggle() {
  recovery.value = !recovery.value;
  code.value = '';
  error.value = undefined;
  await nextTick();
  document.querySelector<HTMLInputElement>('[data-testid="mfa-step"] input')?.focus();
}

async function submit() {
  error.value = undefined;
  const value = recovery.value ? code.value.trim().toLowerCase() : code.value.replace(/\s/g, '');
  if (!recovery.value && !/^\d{6}$/.test(value)) return void (error.value = 'cloud.mfa.sixDigits');
  if (recovery.value && !/^[a-z0-9]{5}-?[a-z0-9]{5}$/.test(value))
    return void (error.value = 'cloud.mfa.recoveryFormat');
  busy.value = true;
  try {
    const { user } = await cloudApi.verifyMfa(value);
    await auth.signedIn(user);
    await router.replace(redirect.value);
  } catch (err) {
    if (problemCode(err) === 'invalid-token') expired.value = true;
    else error.value = cloudErrorKey(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AuthCard
    v-if="expired"
    :title="$t('cloud.mfa.expiredTitle')"
    :intro="$t('cloud.errors.invalid-token')"
  >
    <RouterLink
      :to="{ name: 'login', query: route.query.redirect ? { redirect: redirect } : {} }"
      class="flex h-11 items-center justify-center rounded-control bg-primary text-14 font-semibold text-on-primary hover:bg-primary-hover"
      data-testid="mfa-again"
      >{{ $t('cloud.mfa.signInAgain') }}</RouterLink
    >
  </AuthCard>
  <AuthCard
    v-else
    :title="$t('cloud.mfa.title')"
    :intro="recovery ? $t('cloud.mfa.recoveryIntro') : $t('cloud.mfa.intro')"
  >
    <form class="flex flex-col gap-4" novalidate data-testid="mfa-step" @submit.prevent="submit">
      <TextField
        v-if="recovery"
        v-model="code"
        :label="$t('cloud.mfa.recoveryLabel')"
        autocomplete="off"
        :maxlength="11"
        mono
        required
      />
      <TextField
        v-else
        v-model="code"
        :label="$t('cloud.mfa.codeLabel')"
        autocomplete="one-time-code"
        inputmode="numeric"
        :maxlength="7"
        mono
        required
      />
      <FormAlert v-if="error">{{ $t(error) }}</FormAlert>
      <BaseButton type="submit" block :loading="busy" data-testid="mfa-submit">
        {{ $t('cloud.mfa.submit') }}
      </BaseButton>
      <button
        type="button"
        class="self-center text-13 text-text-muted hover:text-text max-lg:min-h-11"
        data-testid="mfa-toggle"
        @click="toggle"
      >
        {{ recovery ? $t('cloud.mfa.useApp') : $t('cloud.mfa.useRecovery') }}
      </button>
    </form>
  </AuthCard>
</template>
