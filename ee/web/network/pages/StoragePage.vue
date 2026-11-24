<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { networkApi, type Storage } from '../api';
import NetworkTabs from '../components/NetworkTabs.vue';
import NasCard from '../components/storage/NasCard.vue';
import RecorderCard from '../components/storage/RecorderCard.vue';
import SessionsTable from '../components/storage/SessionsTable.vue';
import UpsCard from '../components/storage/UpsCard.vue';
import AttentionList from '../components/wireless/AttentionList.vue';

// Network → Storage (ADR-234): are the cameras being recorded (one card per recorder), the NAS
// they write to, the iSCSI sessions between them, and the UPSes with the hosts they power. Each
// part only where the network has such devices. Refreshed every 30 s.
const data = ref<Storage | null>(null);
const failed = ref(false);
async function load() {
  try {
    data.value = await networkApi.storage();
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 30_000);
});
onUnmounted(() => clearInterval(timer));

const empty = computed(
  () =>
    !!data.value &&
    !data.value.recorders.length &&
    !data.value.nases.length &&
    !data.value.sessions.length &&
    !data.value.upses.length,
);
const notRecording = computed(
  () => data.value?.recorders.filter((r) => r.recording === false).length ?? 0,
);
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,460px),1fr))] gap-4';
</script>

<template>
  <div class="flex flex-col gap-5 p-6 max-md:p-4" data-testid="network-storage">
    <NetworkTabs />
    <ErrorState v-if="failed && !data" :message="$t('net.loadError')" @retry="load" />
    <template v-else-if="!data">
      <Skeleton shape="rect" class="h-64 rounded-card" />
      <Skeleton shape="rect" class="h-48 rounded-card" />
    </template>
    <section
      v-else-if="empty"
      class="rounded-card border border-border bg-surface-1 px-6 py-8 text-center"
      data-testid="storage-empty"
    >
      <h2 class="text-16 font-semibold text-text">{{ $t('netStorage.empty.title') }}</h2>
      <p class="mt-1 text-14 text-text-muted">{{ $t('netStorage.empty.body') }}</p>
      <RouterLink
        :to="{ name: 'network-add' }"
        class="mt-4 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-14 font-semibold text-on-primary hover:bg-primary-hover max-md:h-11"
        >{{ $t('net.addDevices') }}</RouterLink
      >
    </section>
    <template v-else>
      <AttentionList
        v-if="data.attention.length"
        :items="data.attention"
        :title="$t('netStorage.attention')"
      />

      <section
        v-if="data.recorders.length"
        class="flex flex-col gap-3"
        aria-labelledby="storage-rec-h"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="storage-rec-h" class="text-16 font-semibold text-text">
            {{ $t('netStorage.recording.title') }}
          </h2>
          <span
            class="text-13 font-semibold"
            :class="notRecording ? 'text-critical-text' : 'text-text-muted'"
            >{{
              notRecording
                ? $t('netStorage.recording.someNot', { n: notRecording }, notRecording)
                : $t('netStorage.recording.question')
            }}</span
          >
        </div>
        <div :class="grid">
          <RecorderCard v-for="r in data.recorders" :key="r.id" :r="r" />
        </div>
      </section>

      <section v-if="data.nases.length" class="flex flex-col gap-3" aria-labelledby="storage-nas-h">
        <h2 id="storage-nas-h" class="text-16 font-semibold text-text">
          {{ $t('netStorage.nas.title') }}
        </h2>
        <div :class="grid">
          <NasCard v-for="n in data.nases" :key="n.id" :nas="n" />
        </div>
      </section>

      <SessionsTable v-if="data.sessions.length" :sessions="data.sessions" />

      <section v-if="data.upses.length" class="flex flex-col gap-3" aria-labelledby="storage-ups-h">
        <h2 id="storage-ups-h" class="text-16 font-semibold text-text">
          {{ $t('netStorage.ups.title') }}
        </h2>
        <div :class="grid">
          <UpsCard v-for="u in data.upses" :key="u.id" :ups="u" @changed="load" />
        </div>
      </section>
    </template>
  </div>
</template>
