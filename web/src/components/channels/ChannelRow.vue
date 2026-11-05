<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { AlertChannel, ChannelTestResult } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import { formatDateTime } from '@/lib/format';
import type { Tone } from '@/lib/kube';

// One alert channel inside its type's card (ADR-080): what it sends to, whether its
// last delivery worked, "Send test" with the provider's answer, delete with a confirm.
const props = defineProps<{ channel: AlertChannel; detail: string; canManage: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();

const testing = ref(false);
const result = ref<ChannelTestResult | null>(null);
const confirming = ref(false);

const status = computed<{ tone: Tone; label: string }>(() => {
  const ch = props.channel;
  if (ch.type === 'telegram' && !ch.config.connected) {
    return { tone: 'warning', label: t('channels.status.notConnected') };
  }
  if (ch.lastError) return { tone: 'critical', label: t('channels.status.failing') };
  if (ch.verifiedAt || ch.lastSentAt) return { tone: 'ok', label: t('channels.status.working') };
  return { tone: 'neutral', label: t('channels.status.untested') };
});

async function test() {
  testing.value = true;
  try {
    result.value = await api<ChannelTestResult>(`/alert-channels/${props.channel.id}/test`, {
      method: 'POST',
    });
  } catch (err) {
    result.value = {
      ok: false,
      error:
        err instanceof ApiError && err.status === 429
          ? t('channels.errors.rateLimited')
          : t('channels.errors.test'),
    };
  } finally {
    testing.value = false;
    emit('changed');
  }
}

async function remove() {
  if (!confirming.value) {
    confirming.value = true;
    return;
  }
  confirming.value = false;
  await api(`/alert-channels/${props.channel.id}`, { method: 'DELETE' });
  emit('changed');
}
</script>

<template>
  <li
    class="flex flex-col gap-1.5 border-t border-border py-2.5 first:border-t-0"
    data-testid="channel-row"
  >
    <div class="flex flex-wrap items-center gap-2">
      <div class="min-w-0 flex-1">
        <p class="truncate text-14 font-medium text-text">{{ channel.name }}</p>
        <p class="truncate text-12 text-text-muted">
          {{ detail }}
          <template v-if="channel.lastSentAt">
            · {{ $t('channels.lastSent', { at: formatDateTime(channel.lastSentAt) }) }}
          </template>
        </p>
      </div>
      <TonePill v-bind="status" />
      <template v-if="canManage">
        <BaseButton variant="ghost" :loading="testing" data-testid="send-test" @click="test">
          {{ $t('channels.test') }}
        </BaseButton>
        <BaseButton
          :variant="confirming ? 'danger' : 'ghost'"
          data-testid="delete-channel"
          @click="remove"
        >
          {{ confirming ? $t('channels.confirmDelete') : $t('common.delete') }}
        </BaseButton>
      </template>
    </div>
    <p
      v-if="result"
      :class="['text-13', result.ok ? 'text-text' : 'text-critical']"
      role="status"
      data-testid="test-result"
    >
      {{ result.ok ? $t('channels.testOk') : $t('channels.testFailed', { error: result.error }) }}
    </p>
    <p v-else-if="channel.lastError" class="text-12 text-critical" data-testid="last-error">
      {{
        $t('channels.lastError', {
          error: channel.lastError,
          at: formatDateTime(channel.lastErrorAt!),
        })
      }}
    </p>
  </li>
</template>
