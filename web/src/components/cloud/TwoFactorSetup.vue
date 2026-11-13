<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { cloudApi, cloudErrorKey } from '@/api/cloud';
import BaseButton from '@/components/ui/BaseButton.vue';
import TextField from '@/components/ui/TextField.vue';
import { useCopy } from '@/composables/useCopy';
import FormAlert from './FormAlert.vue';
import RecoveryCodes from './RecoveryCodes.vue';

// Turning on 2FA (ADR-175): the secret for the authenticator app, then one code from it,
// then the recovery codes, shown once. The web has no QR library and adds none, so the
// secret is shown as text and as an otpauth:// link (phones open it in their app).
const emit = defineEmits<{ done: [] }>();
const setup = ref<{ secret: string; uri: string } | null>(null);
const code = ref('');
const codes = ref<string[] | null>(null);
const error = ref<string>();
const busy = ref(false);
const copier = useCopy();

async function start() {
  error.value = undefined;
  try {
    setup.value = await cloudApi.setupMfa();
  } catch (err) {
    error.value = cloudErrorKey(err);
  }
}

async function enable() {
  error.value = undefined;
  const value = code.value.replace(/\s/g, '');
  if (!/^\d{6}$/.test(value)) {
    error.value = 'cloud.mfa.sixDigits';
    return;
  }
  busy.value = true;
  try {
    codes.value = (await cloudApi.enableMfa(value)).recoveryCodes;
  } catch (err) {
    error.value = cloudErrorKey(err);
  } finally {
    busy.value = false;
  }
}

/** The secret in groups of four, easier to type. */
const grouped = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();
onMounted(start);
</script>

<template>
  <div class="flex flex-col gap-5" data-testid="mfa-setup">
    <RecoveryCodes v-if="codes" :codes="codes" @done="emit('done')" />
    <template v-else-if="setup">
      <ol class="flex flex-col gap-4 text-14 text-text">
        <li class="flex flex-col gap-2">
          <span>{{ $t('cloud.mfa.setup.step1') }}</span>
          <div class="flex flex-wrap items-center gap-2">
            <code
              class="rounded-control border border-border bg-bg px-3 py-2 font-mono text-14 break-all"
              data-testid="mfa-secret"
              >{{ grouped(setup.secret) }}</code
            >
            <BaseButton variant="secondary" @click="copier.copy(setup.secret)">
              <span aria-live="polite">{{
                $t(copier.state.value === 'copied' ? 'common.copied' : 'common.copy')
              }}</span>
            </BaseButton>
          </div>
          <a
            :href="setup.uri"
            class="inline-flex items-center self-start text-13 text-primary hover:text-primary-hover max-lg:min-h-11"
            data-testid="mfa-uri"
            >{{ $t('cloud.mfa.setup.openApp') }}</a
          >
        </li>
        <li>
          <form class="flex flex-col gap-3" novalidate @submit.prevent="enable">
            <TextField
              v-model="code"
              :label="$t('cloud.mfa.setup.step2')"
              autocomplete="one-time-code"
              inputmode="numeric"
              :maxlength="7"
              mono
              required
            />
            <FormAlert v-if="error">{{ $t(error) }}</FormAlert>
            <BaseButton type="submit" :loading="busy" class="self-start" data-testid="mfa-enable">
              {{ $t('cloud.mfa.setup.enable') }}
            </BaseButton>
          </form>
        </li>
      </ol>
    </template>
    <template v-else-if="error">
      <FormAlert>{{ $t(error) }}</FormAlert>
      <BaseButton variant="secondary" class="self-start" @click="start">{{
        $t('common.retry')
      }}</BaseButton>
    </template>
    <p v-else class="text-13 text-text-muted">{{ $t('common.loading') }}</p>
  </div>
</template>
