<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Hash, Webhook } from '@lucide/vue';
import type { AlertChannel } from '@watchlog/api-types';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import TonePill from '@/components/kube/TonePill.vue';
import BaseButton from '@/components/ui/BaseButton.vue';
import AddChannelForm from './AddChannelForm.vue';
import ChannelRow from './ChannelRow.vue';

// Slack (incoming webhook) or a generic signed webhook: its channels and "+ Add".
const props = defineProps<{
  type: 'slack' | 'webhook';
  channels: AlertChannel[];
  canManage: boolean;
  firstChannel: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const adding = ref(false);
const icon = computed(() => (props.type === 'slack' ? Hash : Webhook));
const detail = (c: AlertChannel) =>
  props.type === 'slack'
    ? t('channels.webhookSet', { last: c.secrets.webhookUrl ?? '' })
    : (c.config.url ?? '');
const pill = computed(() =>
  props.channels.length
    ? {
        tone: 'ok' as const,
        label: t('channels.count', { n: props.channels.length }, props.channels.length),
      }
    : { tone: 'neutral' as const, label: t('channels.notSet') },
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
    :data-testid="`${type}-card`"
  >
    <header class="flex flex-wrap items-center gap-2.5">
      <span
        class="flex size-8 items-center justify-center rounded-control bg-surface-3 text-text-muted"
      >
        <component :is="icon" class="size-4" aria-hidden="true" />
      </span>
      <h2 class="text-14 font-semibold text-text">{{ $t(`channels.types.${type}`) }}</h2>
      <span class="flex-1" />
      <TonePill v-bind="pill" />
      <BaseButton
        v-if="canManage && !adding"
        variant="secondary"
        :data-testid="`add-${type}`"
        @click="adding = true"
      >
        {{ $t('channels.add') }}
      </BaseButton>
    </header>
    <p class="text-13 text-text-muted">{{ $t(`channels.describe.${type}`) }}</p>
    <ul v-if="channels.length" class="flex flex-col">
      <ChannelRow
        v-for="c in channels"
        :key="c.id"
        :channel="c"
        :detail="detail(c)"
        :can-manage="canManage"
        @changed="emit('changed')"
      />
    </ul>
    <AddChannelForm
      v-if="adding"
      :type="type"
      :first-channel="firstChannel"
      @created="
        adding = false;
        emit('changed');
      "
      @cancel="adding = false"
    />
  </section>
</template>
