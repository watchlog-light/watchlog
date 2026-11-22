<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { AlertChannel, ChannelTestResult } from '@watchlog/api-types';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { channelState, STATE_TONE } from '@/lib/channels';
import { formatDateTime } from '@/lib/format';
import type { Tone } from '@/lib/kube';
import { useToastStore } from '@/stores/toast';

// One alert channel inside its type's card (ADR-080): what it sends to, whether its
// last delivery worked, "Send test" and what it said, and Delete, which asks first (ADR-219).
const props = defineProps<{ channel: AlertChannel; detail: string; canManage: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();

const testing = ref(false);
const result = ref<ChannelTestResult | null>(null);
const asking = ref(false);
/** Deleted: the row goes at once, before the list is loaded again. */
const gone = ref(false);
const toast = useToastStore();

const status = computed<{ tone: Tone; label: string }>(() => {
  const state = channelState(props.channel);
  return { tone: STATE_TONE[state], label: t(`channels.status.${state}`) };
});
// A failed test's text goes once a later message got through: the row says "Working" then.
watch(
  () => props.channel.lastSentAt,
  () => {
    if (result.value && !result.value.ok && !props.channel.lastError) result.value = null;
  },
);

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

/** After the dialog's yes; throws when the server refused, and the row then stays. */
async function remove() {
  await api(`/alert-channels/${props.channel.id}`, { method: 'DELETE' });
  gone.value = true;
  toast.show(t('channels.deleted', { name: props.channel.name }));
  emit('changed');
}
</script>

<template>
  <li
    v-if="!gone"
    class="flex min-w-0 flex-col gap-1.5 border-t border-border py-2.5 first:border-t-0"
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
        <BaseButton variant="ghost" data-testid="delete-channel" @click="asking = true">
          {{ $t('common.delete') }}
        </BaseButton>
      </template>
    </div>
    <p
      v-if="result"
      :class="['min-w-0 text-13 wrap-anywhere', result.ok ? 'text-text' : 'text-critical-text']"
      role="status"
      data-testid="test-result"
    >
      {{ result.ok ? $t('channels.testOk') : $t('channels.testFailed', { error: result.error }) }}
    </p>
    <p
      v-else-if="channel.lastError"
      class="min-w-0 text-12 wrap-anywhere text-critical-text"
      data-testid="last-error"
    >
      {{
        $t('channels.lastError', {
          error: channel.lastError,
          at: formatDateTime(channel.lastErrorAt!),
        })
      }}
    </p>
    <ConfirmDialog
      v-if="asking"
      v-model:open="asking"
      :title="$t('channels.deleteTitle')"
      :subject="channel.name"
      :lines="[
        $t('channels.deleteBody'),
        $t('channels.deleteRules', { n: channel.ruleCount }, channel.ruleCount),
      ]"
      :confirm-label="$t('channels.deleteConfirm')"
      :action="remove"
      testid="delete-channel"
    />
  </li>
</template>
