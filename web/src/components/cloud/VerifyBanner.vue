<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { MailWarning, X } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import ResendVerification from './ResendVerification.vue';

// "Verify your email" (ADR-175): over every page while the address isn't verified. It
// doesn't block for 7 days; the banner says until when. Dismissed for this page view only.
const auth = useAuthStore();
const hidden = ref(false);
const shown = computed(
  () => auth.isCloud && auth.account && !auth.account.emailVerified && !hidden.value,
);
const by = computed(() =>
  auth.account?.verifyBy
    ? new Date(auth.account.verifyBy).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : null,
);
</script>

<template>
  <div
    v-if="shown"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface-1 px-4 py-2 text-13 text-text md:px-6"
    role="region"
    :aria-label="$t('cloud.verify.bannerLabel')"
    data-testid="verify-banner"
  >
    <MailWarning class="size-4 shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-0 flex-1">
      {{
        by
          ? $t('cloud.verify.banner', { email: auth.account!.email, date: by })
          : $t('cloud.verify.bannerNoDate', { email: auth.account!.email })
      }}
    </p>
    <ResendVerification compact class="max-sm:w-full" />
    <button
      type="button"
      class="flex size-8 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text max-lg:size-11"
      :aria-label="$t('cloud.verify.dismiss')"
      @click="hidden = true"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
  </div>
</template>
