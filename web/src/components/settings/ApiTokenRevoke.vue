<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ApiToken } from '@watchlog/api-types';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import BaseButton from '@/components/ui/BaseButton.vue';
import ModalDialog from '@/components/ui/ModalDialog.vue';
import { useNarrow } from '@/composables/useNarrow';
import { useApiTokenText } from '@/composables/useApiTokenText';

// Revoking is immediate and can't be undone: confirm with what the token was used for.
const props = defineProps<{ token: ApiToken | null }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ revoked: [] }>();
const { t } = useI18n();
const narrow = useNarrow();
const text = useApiTokenText();
const busy = ref(false);
const error = ref<string>();
watch(open, () => (error.value = undefined));

async function revoke() {
  if (!props.token) return;
  busy.value = true;
  error.value = undefined;
  try {
    await api<void>(`/api-tokens/${props.token.id}`, { method: 'DELETE' });
    open.value = false;
    emit('revoked');
  } catch {
    error.value = t('apiTokens.revoke.failed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalDialog
    v-model:open="open"
    :title="token ? t('apiTokens.revoke.title', { name: token.name }) : ''"
    :description="t('apiTokens.revoke.text')"
  >
    <template v-if="token">
      <dl
        class="grid grid-cols-2 gap-2.5 rounded-control border border-border bg-bg p-3.5 text-13"
        data-testid="api-token-revoke-summary"
      >
        <div class="flex flex-col gap-0.5">
          <dt class="text-11 tracking-wider text-text-muted uppercase">
            {{ $t('apiTokens.columns.token') }}
          </dt>
          <dd class="font-mono text-text">{{ token.prefix }}…</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-11 tracking-wider text-text-muted uppercase">
            {{ $t('apiTokens.columns.lastUsed') }}
          </dt>
          <dd class="text-text">
            {{ text.lastUsed(token) }}
          </dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-11 tracking-wider text-text-muted uppercase">
            {{ $t('apiTokens.columns.calls') }}
          </dt>
          <dd class="text-text">
            {{ text.calls(token) }}
          </dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-11 tracking-wider text-text-muted uppercase">
            {{ $t('apiTokens.columns.expires') }}
          </dt>
          <dd class="text-text">
            {{ text.expires(token) }}
          </dd>
        </div>
      </dl>
      <p v-if="error" class="text-13 text-critical" role="alert">{{ error }}</p>
      <div :class="narrow ? 'grid grid-cols-2 gap-2' : 'flex justify-end gap-2'">
        <BaseButton variant="secondary" @click="open = false">{{ $t('common.cancel') }}</BaseButton>
        <BaseButton
          variant="danger"
          :loading="busy"
          data-testid="api-token-revoke-confirm"
          @click="revoke"
        >
          {{ $t('apiTokens.revoke.confirm') }}
        </BaseButton>
      </div>
    </template>
  </ModalDialog>
</template>
