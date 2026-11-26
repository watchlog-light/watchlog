<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// "Find endpoints for me" (1.0.0, ADR-236): the collectors try the ports WatchLog already
// knows (a pod's declared ports, a server's listening ports) on /metrics and say which answer
// with metrics. Each can be added with one click. Since 1.0.3 it says what it tried, and the
// page may hand it the search it ran quietly on opening (`initial`).
import type { OwnFound } from '@watchlog/api-types';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@/api/client';
import { ownMetricsApi, type NewSource } from '@/api/own-metrics';
import BaseButton from '@/components/ui/BaseButton.vue';
import { portsText } from '@/lib/own-add';

const props = defineProps<{ cluster: string; kube?: boolean; initial?: OwnFound | null }>();
/** `none`: a finished search found nothing (the page offers the ways forward). */
const emit = defineEmits<{ changed: []; none: [nothing: boolean] }>();
const { t } = useI18n();

type Found = OwnFound['found'][number];
const state = ref<OwnFound | null>(props.initial ?? null);
watch(
  () => props.initial,
  (v) => {
    if (v && !searching.value) state.value = v;
  },
);
const searching = ref(false);
const error = ref('');
const added = ref(new Set<string>());
let timer: ReturnType<typeof setTimeout> | undefined;
let tries = 0;
onBeforeUnmount(() => clearTimeout(timer));

const keyOf = (f: Found) =>
  f.add.kind === 'pod'
    ? `${f.add.namespace}/${f.add.workloadKind}/${f.add.workload}:${f.add.port}`
    : `${f.add.server} ${f.add.address}`;
const factsOf = (f: Found) =>
  [t('ownMetrics.find.series', { n: f.series }, f.series), f.names.slice(0, 3).join(', ')]
    .filter(Boolean)
    .join(' · ');
const nameOf = (f: Found) =>
  f.add.kind === 'pod'
    ? `${f.add.namespace}/${f.add.workload} :${f.add.port}`
    : `${f.add.server} ${f.add.address.replace(/^localhost/, '')}`;

async function look() {
  try {
    state.value = await ownMetricsApi.found(props.cluster);
  } catch {
    // The search ended or the server restarted: what is shown stays.
    searching.value = false;
    return;
  }
  // The collectors answer within their next configuration poll; asked for a minute at most.
  if (state.value.done || ++tries >= 20) searching.value = false;
  else timer = setTimeout(() => void look(), 3000);
}

async function start() {
  error.value = '';
  searching.value = true;
  tries = 0;
  clearTimeout(timer);
  try {
    state.value = await ownMetricsApi.find(props.cluster);
    if (state.value.asked === 0) searching.value = false;
    else timer = setTimeout(() => void look(), 2000);
  } catch (err) {
    searching.value = false;
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.find.failed');
  }
}

// What was tried, in words: "Tried /metrics on 6 listening ports: 80, 3000, …".
const more = (n: number) => t('ownMetrics.find.more', { n });
const tried = computed(() => {
  const s = state.value;
  if (!s || s.tried.ports.length === 0) return '';
  const n = s.tried.ports.length;
  const ports = portsText(s.tried.ports, more);
  return props.kube
    ? t(
        'ownMetrics.find.triedKube',
        {
          n,
          ports,
          workloads: t('ownMetrics.find.workloads', { n: s.tried.workloads }, s.tried.workloads),
        },
        n,
      )
    : t('ownMetrics.find.triedServer', { n, ports }, n);
});
const finished = computed(() => !!state.value && !searching.value);
watch(
  [finished, () => state.value?.found.length ?? 0],
  ([done, n]) => emit('none', done && n === 0),
  { immediate: true },
);

const adding = ref('');
async function add(f: Found) {
  adding.value = keyOf(f);
  error.value = '';
  const body: NewSource =
    f.add.kind === 'pod'
      ? {
          namespace: f.add.namespace,
          workloadKind: f.add.workloadKind,
          workload: f.add.workload,
          port: f.add.port,
        }
      : { server: f.add.server, address: f.add.address };
  try {
    await ownMetricsApi.addSource(props.cluster, body);
    added.value = new Set([...added.value, keyOf(f)]);
    emit('changed');
  } catch (err) {
    error.value = (err instanceof ApiError && err.problem?.detail) || t('ownMetrics.find.failed');
  } finally {
    adding.value = '';
  }
}
</script>

<template>
  <div data-testid="own-find">
    <div class="flex flex-wrap items-center gap-3">
      <BaseButton
        variant="secondary"
        :loading="searching"
        data-testid="own-find-start"
        @click="start"
      >
        {{ $t('ownMetrics.find.button') }}
      </BaseButton>
      <span class="text-13 text-text-muted">{{ $t('ownMetrics.find.about') }}</span>
    </div>
    <p v-if="error" class="mt-2 text-13 text-critical-text" role="alert">{{ error }}</p>
    <template v-if="state">
      <p
        class="mt-3 text-13 leading-relaxed text-text-muted"
        role="status"
        data-testid="own-find-state"
      >
        <template v-if="state.asked === 0">{{ $t('ownMetrics.find.nothingToTry') }}</template>
        <template v-else-if="searching">{{
          $t('ownMetrics.find.searching', { n: state.asked }, state.asked)
        }}</template>
        <template v-else-if="state.found.length === 0"
          >{{ tried }}
          {{ $t(state.done ? 'ownMetrics.find.none' : 'ownMetrics.find.noAnswer') }}</template
        >
        <template v-else>{{
          $t(
            'ownMetrics.find.found',
            { n: state.found.length, asked: state.asked },
            state.found.length,
          )
        }}</template>
      </p>
      <p
        v-if="!searching && (state.tried.skipped.length || state.tried.scraped)"
        class="mt-1 text-12 leading-relaxed text-text-subtle"
        data-testid="own-find-skipped"
      >
        <template v-if="state.tried.skipped.length">{{
          $t('ownMetrics.find.skipped', { ports: portsText(state.tried.skipped, more) })
        }}</template>
        <template v-if="state.tried.scraped">
          {{
            $t('ownMetrics.find.scraped', { n: state.tried.scraped }, state.tried.scraped)
          }}</template
        >
      </p>
      <ul
        v-if="state.found.length"
        class="mt-2 divide-y divide-border rounded-card border border-border"
      >
        <li
          v-for="f in state.found"
          :key="keyOf(f)"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
          data-testid="own-found"
        >
          <span class="min-w-0 flex-1">
            <span class="block font-mono text-13 break-all text-text">{{ nameOf(f) }}</span>
            <span class="block truncate text-12 text-text-muted">{{ factsOf(f) }}</span>
          </span>
          <span v-if="added.has(keyOf(f))" class="text-13 text-ok-text">{{
            $t('ownMetrics.find.added')
          }}</span>
          <BaseButton
            v-else
            variant="secondary"
            :loading="adding === keyOf(f)"
            data-testid="own-found-add"
            @click="add(f)"
          >
            {{ $t('ownMetrics.find.add') }}
          </BaseButton>
        </li>
      </ul>
    </template>
  </div>
</template>
