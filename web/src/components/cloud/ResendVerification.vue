<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { cloudApi, cloudErrorKey, problemCode } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import { useAuthStore } from '@/stores/auth';
import FormAlert from './FormAlert.vue';
import TurnstileWidget from './TurnstileWidget.vue';

// "Send a new link" (ADR-175): 3 an hour per account, behind Turnstile when it is on.
// `compact` is the banner's inline button; the widget then appears after the first press.
const props = defineProps<{ compact?: boolean }>();
const auth = useAuthStore();
const siteKey = computed(() => auth.cloud?.turnstileSiteKey ?? null);
const token = ref<string | null>(null);
const widget = ref<InstanceType<typeof TurnstileWidget> | null>(null);
const asked = ref(!props.compact);
const busy = ref(false);
const sent = ref(false);
const error = ref<string>();

async function resend() {
  error.value = undefined;
  if (siteKey.value && !token.value) {
    if (asked.value) error.value = 'cloud.turnstile.needed';
    asked.value = true;
    return;
  }
  busy.value = true;
  try {
    await cloudApi.resendVerification(token.value ?? undefined);
    sent.value = true;
  } catch (err) {
    if (problemCode(err) === 'already-verified') await auth.loadAccount();
    error.value = cloudErrorKey(err);
    widget.value?.reset();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="resend">
    <p v-if="sent" role="status" class="text-13 text-text" data-testid="resend-sent">
      {{ $t('cloud.verify.sent', { email: auth.account?.email ?? auth.user?.email ?? '' }) }}
    </p>
    <template v-else>
      <TurnstileWidget v-if="siteKey && asked" ref="widget" v-model="token" :site-key="siteKey" />
      <BaseButton
        :variant="compact ? 'secondary' : 'primary'"
        :block="!compact"
        :loading="busy"
        data-testid="resend-button"
        @click="resend"
      >
        {{ $t('cloud.verify.resend') }}
      </BaseButton>
    </template>
    <FormAlert v-if="error">{{ $t(error) }}</FormAlert>
  </div>
</template>
