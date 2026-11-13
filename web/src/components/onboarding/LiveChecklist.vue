<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, LoaderCircle, TriangleAlert } from '@lucide/vue';
import type { OnboardingStatus, OnboardingStep } from '@watchlog/api-types';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeBlock from '@/components/ui/CodeBlock.vue';

// The live connection checklist (ADR-176, SPEC §10.2 step 4), drawn from the onboarding
// status: each step ticks when its data is there, in plain words; the first step still
// waiting spins. A clock counts from when the page opened. Used by the Cloud wizard and
// by Settings › Clusters after "Add cluster" (Community too).
const props = defineProps<{
  status: OnboardingStatus | null;
  kind: 'kubernetes' | 'docker';
  /** The clock's start (ms); defaults to when the checklist appeared. */
  since?: number;
  /** Hide the heading (the page has its own). */
  bare?: boolean;
}>();
const { t } = useI18n();

const start = props.since ?? Date.now();
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(tick));
const clock = computed(() => {
  const s = Math.max(0, Math.floor((now.value - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

const ORDER = computed<OnboardingStep['id'][]>(() =>
  props.kind === 'kubernetes'
    ? ['agent', 'clusterAgent', 'metrics', 'ebpf', 'map']
    : ['agent', 'metrics', 'ebpf', 'map'],
);
const steps = computed(() => {
  const by = new Map((props.status?.steps ?? []).map((s) => [s.id, s]));
  const list = ORDER.value.map(
    (id) => by.get(id) ?? ({ id, state: 'waiting', since: null } as OnboardingStep),
  );
  const active = list.find((s) => s.state === 'waiting')?.id;
  return list.map((s) => ({ ...s, active: s.id === active }));
});

const unit = computed(() => (props.kind === 'docker' ? 'hosts' : 'nodes'));
function detail(s: OnboardingStep & { active: boolean }): string {
  const n = (v: number | undefined) => v ?? 0;
  if (s.state === 'waiting') {
    if (s.id === 'map' && !s.active) return t('onboarding.check.map.later');
    return s.active ? t(`onboarding.check.${s.id}.waiting`) : '';
  }
  switch (s.id) {
    case 'agent':
      return t(`onboarding.check.agent.done.${unit.value}`, { n: n(s.nodes) }, n(s.nodes));
    case 'clusterAgent':
      return t('onboarding.check.clusterAgent.done');
    case 'metrics':
      return t(
        `onboarding.check.metrics.done.${unit.value}`,
        { nodes: n(s.nodes), containers: n(s.containers) },
        n(s.containers),
      );
    case 'ebpf':
      if (s.state === 'done')
        return t(`onboarding.check.ebpf.done.${unit.value}`, { n: n(s.enabled) }, n(s.enabled));
      return s.reason
        ? t('onboarding.check.ebpf.offWhy', { node: s.node ?? '', reason: s.reason })
        : t('onboarding.check.ebpf.off', { node: s.node ?? '' });
    case 'map':
      return s.state === 'done'
        ? t(
            'onboarding.check.map.done',
            { services: n(s.services), connections: n(s.connections) },
            n(s.connections),
          )
        : t('onboarding.check.map.off');
  }
  return '';
}
const ebpf = computed(() => steps.value.find((s) => s.id === 'ebpf' && s.state === 'off'));
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="live-checklist" :aria-busy="!status?.complete">
    <div v-if="!bare" class="flex items-center justify-between gap-3">
      <h2 class="text-16 font-semibold text-text">{{ $t('onboarding.check.title') }}</h2>
      <span class="font-mono text-13 text-text-muted tabular" data-testid="checklist-clock">{{
        clock
      }}</span>
    </div>
    <ol class="flex flex-col gap-3.5" aria-live="polite">
      <li
        v-for="s in steps"
        :key="s.id"
        class="flex items-start gap-3"
        :data-testid="`check-${s.id}`"
        :data-state="s.state"
      >
        <span
          v-if="s.state === 'done'"
          class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary"
          aria-hidden="true"
          ><Check class="size-3.5" :stroke-width="3"
        /></span>
        <TriangleAlert
          v-else-if="s.state === 'off'"
          class="size-5.5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <LoaderCircle
          v-else-if="s.active"
          class="size-5.5 shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
        <span
          v-else
          class="size-5.5 shrink-0 rounded-full border-2 border-border"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span
            :class="[
              'text-14',
              s.state !== 'waiting' || s.active ? 'font-medium text-text' : 'text-text-muted',
            ]"
          >
            {{ $t(`onboarding.check.${s.id}.label`) }}
            <span class="sr-only">{{ $t(`onboarding.check.state.${s.state}`) }}</span>
          </span>
          <span v-if="detail(s)" class="text-13 break-words text-text-muted">{{ detail(s) }}</span>
        </div>
      </li>
    </ol>
    <CodeBlock
      v-if="ebpf?.fix"
      :label="$t('onboarding.check.ebpf.fix')"
      :code="ebpf.fix"
      data-testid="ebpf-fix"
    />
  </section>
</template>
