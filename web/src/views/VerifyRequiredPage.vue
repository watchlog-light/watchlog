<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import ResendVerification from '@/components/cloud/ResendVerification.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

// The blocking gate (ADR-175): an address not verified 7 days after sign-up can sign in only
// to verify it. The link in the email lifts the gate; "I've verified" checks again.
const auth = useAuthStore();
const router = useRouter();

async function recheck() {
  await auth.loadAccount();
  if (!auth.restriction) await router.replace('/');
}
async function signOut() {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <AuthCard
    :title="$t('cloud.gate.verifyTitle')"
    :intro="$t('cloud.gate.verifyIntro', { email: auth.account?.email ?? auth.user?.email ?? '' })"
  >
    <div class="flex flex-col gap-4" data-testid="verify-gate">
      <ResendVerification />
      <button
        type="button"
        class="h-9 rounded-control border border-border-strong text-14 font-semibold text-text hover:bg-surface-2 max-lg:h-11"
        data-testid="gate-recheck"
        @click="recheck"
      >
        {{ $t('cloud.gate.recheck') }}
      </button>
      <button
        type="button"
        class="self-center text-13 text-text-muted hover:text-text max-lg:min-h-11"
        data-testid="gate-sign-out"
        @click="signOut"
      >
        {{ $t('account.signOut') }}
      </button>
    </div>
  </AuthCard>
</template>
