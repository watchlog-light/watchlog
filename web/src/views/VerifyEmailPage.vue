<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleCheck } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { cloudApi, cloudErrorKey, problemCode } from '@/api/cloud';
import ResendVerification from '@/components/cloud/ResendVerification.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

// The link in the verification email (ADR-175): /verify-email/<token>. Opened signed in or
// not. A link lasts 24 hours; an expired one offers a new one when signed in.
const route = useRoute();
const auth = useAuthStore();
const state = ref<'checking' | 'verified' | 'failed'>('checking');
const errorKey = ref('');
const expired = ref(false);

onMounted(async () => {
  try {
    await cloudApi.verifyEmail(String(route.params.token));
    state.value = 'verified';
    if (auth.user) await auth.loadAccount();
  } catch (err) {
    expired.value = problemCode(err) === 'token-expired';
    errorKey.value = cloudErrorKey(err);
    state.value = 'failed';
  }
});
const next = computed(() => (auth.user ? { path: '/' } : { name: 'login' }));
</script>

<template>
  <AuthCard
    v-if="state === 'checking'"
    :title="$t('cloud.verify.title')"
    :intro="$t('cloud.verify.checking')"
  >
    <p class="sr-only" role="status">{{ $t('cloud.verify.checking') }}</p>
  </AuthCard>
  <AuthCard
    v-else-if="state === 'verified'"
    :title="$t('cloud.verify.doneTitle')"
    :intro="$t('cloud.verify.doneIntro')"
  >
    <div class="flex flex-col gap-4" role="status" data-testid="verify-done">
      <CircleCheck class="size-8 self-center text-ok" aria-hidden="true" />
      <RouterLink
        :to="next"
        class="flex h-11 items-center justify-center rounded-control bg-primary text-14 font-semibold text-on-primary hover:bg-primary-hover"
        >{{ auth.user ? $t('cloud.verify.continue') : $t('cloud.signup.signIn') }}</RouterLink
      >
    </div>
  </AuthCard>
  <AuthCard v-else :title="$t('cloud.verify.failedTitle')" :intro="$t(errorKey)">
    <div class="flex flex-col gap-4" data-testid="verify-failed">
      <ResendVerification
        v-if="auth.user && (expired || errorKey === 'cloud.errors.invalid-token')"
      />
      <RouterLink
        :to="next"
        class="self-center text-13 text-text-muted hover:text-text max-lg:inline-flex max-lg:min-h-11 max-lg:items-center"
        >{{ auth.user ? $t('cloud.verify.continue') : $t('cloud.signup.signIn') }}</RouterLink
      >
    </div>
  </AuthCard>
</template>
