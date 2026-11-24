<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import type { UpsCard } from '../../api';
import { runtimeMinutes, upsTone, type Tone } from '../../lib/storage';
import FeedsEditor from './FeedsEditor.vue';

// One UPS (ADR-234): on mains or on battery, charge, runtime, load, volts, temperature, a battery
// to replace, and the servers and nodes it powers. Owners and Admins set those; when it goes on
// battery, the event shows in their Events.
const props = defineProps<{ ups: UpsCard }>();
const emit = defineEmits<{ changed: [] }>();
const auth = useAuthStore();
const editing = ref(false);

const PILL: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok-text',
  warning: 'bg-warning/15 text-warning-text',
  critical: 'bg-critical/15 text-critical-text',
  neutral: 'bg-surface-3 text-text-muted',
};
const STATUS_KEY: Record<string, string> = {
  online: 'online',
  'on-battery': 'onBattery',
  bypass: 'bypass',
  off: 'off',
};
const status = computed(() => {
  const s = props.ups.ups?.status;
  return (s && STATUS_KEY[s]) || 'unknown';
});
const tone = computed(() => upsTone(props.ups.ups?.status));

const facts = computed(() => {
  const u = props.ups.ups;
  if (!u) return [];
  const mins = runtimeMinutes(u.runtimeS);
  return [
    {
      key: 'charge',
      v: u.chargePercent == null ? null : `${Math.round(u.chargePercent)}%`,
      warn: u.chargePercent != null && u.chargePercent < 50,
    },
    {
      key: 'runtime',
      v: mins == null ? null : mins,
      warn: mins != null && mins < 10,
      minutes: true,
    },
    {
      key: 'load',
      v: u.loadPercent == null ? null : `${Math.round(u.loadPercent)}%`,
      warn: u.loadPercent != null && u.loadPercent >= 80,
    },
    { key: 'input', v: u.inputVolts == null ? null : `${Math.round(u.inputVolts)} V`, warn: false },
    {
      key: 'output',
      v: u.outputVolts == null ? null : `${Math.round(u.outputVolts)} V`,
      warn: false,
    },
    {
      key: 'temp',
      v: u.celsius == null ? null : `${Math.round(u.celsius)} °C`,
      warn: u.celsius != null && u.celsius >= 40,
    },
  ].filter((f) => f.v != null);
});

function hostLink(f: UpsCard['feeds'][number]): RouteLocationRaw {
  return f.kind === 'kubernetes'
    ? { name: 'node', params: { name: f.node }, query: { cluster: f.clusterId } }
    : { name: 'server', params: { server: f.node }, query: { cluster: f.clusterId } };
}
const placeWord = (kind: string) => (kind === 'kubernetes' ? 'kubernetes' : 'server');

function saved() {
  editing.value = false;
  emit('changed');
}
</script>

<template>
  <article
    class="flex min-w-0 flex-col gap-4 rounded-card border bg-surface-1 p-4"
    :class="tone === 'critical' ? 'border-critical/60' : 'border-border'"
    data-testid="ups-card"
    :data-status="status"
  >
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col">
        <RouterLink
          :to="{ name: 'network-device', params: { id: ups.id } }"
          class="inline-flex items-center font-mono text-16 text-text hover:underline max-md:min-h-11 max-md:min-w-11"
          >{{ ups.name }}</RouterLink
        >
        <span class="text-12 text-text-muted">{{
          [ups.vendor, ups.model, ups.address].filter(Boolean).join(' · ')
        }}</span>
      </div>
      <span
        class="inline-flex h-8 items-center rounded-full px-3 text-14 font-semibold"
        :class="PILL[tone]"
        >{{ $t(`netStorage.ups.status.${status}`) }}</span
      >
    </header>

    <p
      v-if="ups.ups?.replaceBattery"
      class="rounded-control border border-warning/50 bg-warning/10 px-3 py-2 text-13 text-warning-text"
      role="alert"
      data-testid="ups-replace-battery"
    >
      {{ $t('netStorage.ups.replaceBattery') }}
    </p>

    <dl v-if="facts.length" class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
      <div v-for="f in facts" :key="f.key" class="flex flex-col gap-0.5">
        <dt class="text-12 text-text-muted">{{ $t(`netStorage.ups.${f.key}`) }}</dt>
        <dd class="font-mono text-16 tabular" :class="f.warn ? 'text-warning-text' : 'text-text'">
          {{ f.minutes ? $t('netStorage.ups.minutes', { n: f.v }) : f.v }}
        </dd>
      </div>
    </dl>
    <p v-else class="text-13 text-text-muted">{{ $t('netStorage.ups.noReadings') }}</p>

    <div class="flex flex-col gap-2 border-t border-border pt-3" data-testid="ups-feeds">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-13 font-semibold text-text">{{ $t('netStorage.ups.feeds') }}</h3>
        <button
          v-if="auth.canManage && !editing"
          type="button"
          class="inline-flex h-8 items-center rounded-control px-2 text-13 font-semibold text-link hover:bg-surface-2 max-md:h-11 max-md:min-w-11"
          data-testid="ups-feeds-edit"
          @click="editing = true"
        >
          {{ $t('netStorage.ups.feedsEdit') }}
        </button>
      </div>
      <FeedsEditor
        v-if="editing"
        :ups-id="ups.id"
        :feeds="ups.feeds"
        @saved="saved"
        @cancel="editing = false"
      />
      <template v-else>
        <ul v-if="ups.feeds.length" class="flex flex-wrap gap-x-4 gap-y-1 text-13">
          <li v-for="f in ups.feeds" :key="`${f.clusterId}/${f.node}`" data-testid="ups-feed">
            <RouterLink
              :to="hostLink(f)"
              class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11 max-md:min-w-11"
              >{{ f.node }}</RouterLink
            >
            <span class="text-text-muted">
              · {{ f.cluster || f.clusterId }} ({{
                $t(`netStorage.ups.place.${placeWord(f.kind)}`)
              }})</span
            >
          </li>
        </ul>
        <p v-else class="text-13 text-text-muted">{{ $t('netStorage.ups.feedsEmpty') }}</p>
      </template>
      <p class="text-12 text-text-subtle">{{ $t('netStorage.ups.feedsHint') }}</p>
    </div>
  </article>
</template>
