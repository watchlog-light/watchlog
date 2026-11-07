<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { AlertChannel, AlertChannelList } from '@watchlog/api-types';
import { computed, onMounted } from 'vue';
import SmtpCard from '@/components/channels/SmtpCard.vue';
import TelegramCard from '@/components/channels/TelegramCard.vue';
import TypeCard from '@/components/channels/TypeCard.vue';
import PublicAddressNotice from '@/components/settings/PublicAddressNotice.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useLoader } from '@/composables/useLoader';
import { api } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

// Settings → Alert channels (alerts redesign): one card per kind of channel — the email
// server with its recipients, Telegram's guided setup, Slack and webhooks.
const canManage = useAuthStore().canManage;
const list = useLoader(async () => (await api<AlertChannelList>('/alert-channels')).channels);
const channels = computed(() => list.data.value ?? []);
const of = (type: AlertChannel['type']) => channels.value.filter((c) => c.type === type);
const first = computed(() => list.loaded.value && channels.value.length === 0);
onMounted(list.load);
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="channel-settings">
    <header>
      <h2 class="flex items-center gap-2 text-20 font-semibold text-text">
        {{ $t('channels.title') }}
        <LoadingIndicator :active="list.refreshing.value" />
      </h2>
      <p class="mt-1 text-14 text-text-muted">{{ $t('channels.intro') }}</p>
    </header>
    <PublicAddressNotice />
    <ErrorState
      v-if="list.error.value"
      :inline="list.loaded.value"
      :message="$t('channels.errors.load')"
      :retrying="list.loading.value"
      @retry="list.load"
    />
    <div
      v-if="list.skeleton.value"
      class="grid grid-cols-1 gap-3.5 lg:grid-cols-2"
      role="status"
      :aria-label="$t('common.loading')"
      data-testid="channel-skeleton"
    >
      <div
        v-for="i in 4"
        :key="i"
        class="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4"
      >
        <Skeleton class="w-32 text-14" />
        <Skeleton shape="rect" class="h-9 w-full" />
      </div>
    </div>
    <div v-else-if="list.loaded.value" class="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
      <SmtpCard
        :channels="of('email')"
        :can-manage="canManage"
        :first-channel="first"
        @changed="list.load"
      />
      <TelegramCard
        :channels="of('telegram')"
        :can-manage="canManage"
        :first-channel="first"
        @changed="list.load"
      />
      <TypeCard
        type="slack"
        :channels="of('slack')"
        :can-manage="canManage"
        :first-channel="first"
        @changed="list.load"
      />
      <TypeCard
        type="webhook"
        :channels="of('webhook')"
        :can-manage="canManage"
        :first-channel="first"
        @changed="list.load"
      />
    </div>
  </section>
</template>
