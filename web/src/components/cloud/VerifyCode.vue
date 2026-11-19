<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ref } from 'vue';
import { cloudApi, cloudErrorKey, problemCode } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { useAuthStore } from '@/stores/auth';

// The code from the verification email (ADR-220): six digits, typed where the user is
// signed in. `compact` is the banner's inline form. A phone offers the code from the mail
// (autocomplete="one-time-code").
defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ verified: [] }>();
const auth = useAuthStore();
const code = ref('');
const busy = ref(false);
const error = ref<string>();

async function confirm() {
  error.value = undefined;
  const digits = code.value.replace(/\D/g, '');
  if (digits.length !== 6) {
    error.value = 'cloud.verify.codeLength';
    return;
  }
  busy.value = true;
  try {
    await cloudApi.verifyCode(digits);
    await auth.loadAccount();
    emit('verified');
  } catch (err) {
    if (problemCode(err) === 'already-verified') {
      await auth.loadAccount();
      emit('verified');
      return;
    }
    error.value = cloudErrorKey(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form
    :class="compact ? 'flex flex-wrap items-end gap-2' : 'flex flex-col gap-3'"
    data-testid="verify-code"
    novalidate
    @submit.prevent="confirm"
  >
    <TextField
      v-model="code"
      :label="$t('cloud.verify.codeLabel')"
      autocomplete="one-time-code"
      inputmode="numeric"
      :maxlength="7"
      mono
      :error="error ? $t(error) : undefined"
      :class="compact ? 'w-36' : ''"
      data-testid="verify-code-input"
    />
    <BaseButton
      type="submit"
      :variant="compact ? 'secondary' : 'primary'"
      :block="!compact"
      :loading="busy"
      data-testid="verify-code-submit"
    >
      {{ $t('cloud.verify.confirm') }}
    </BaseButton>
  </form>
</template>
