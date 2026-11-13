<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { useRouter } from 'vue-router';
import TwoFactorSetup from '@/components/cloud/TwoFactorSetup.vue';
import AuthCard from '@/layouts/AuthCard.vue';
import { useAuthStore } from '@/stores/auth';

// "Set up 2FA first" (ADR-175): an Owner of an org that pays (entitlements from billing)
// must turn on 2FA before anything else. Turning it on rotates the session; the app then
// opens as usual.
const auth = useAuthStore();
const router = useRouter();

async function done() {
  await auth.loadAccount();
  await router.replace('/');
}
async function signOut() {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <AuthCard :title="$t('cloud.gate.mfaTitle')" :intro="$t('cloud.gate.mfaIntro')" wide>
    <div class="flex flex-col gap-4" data-testid="mfa-gate">
      <TwoFactorSetup @done="done" />
      <button
        type="button"
        class="self-center text-13 text-text-muted hover:text-text max-lg:min-h-11"
        @click="signOut"
      >
        {{ $t('account.signOut') }}
      </button>
    </div>
  </AuthCard>
</template>
