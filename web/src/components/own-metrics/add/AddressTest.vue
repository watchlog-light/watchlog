<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// What "Test" found (1.0.3): the address read once by its collector, said in plain words:
// how many series and a few names, or why it gives no metrics; and, when a cap would cut it,
// how many series would be kept.
import type { OwnAddressTest, OwnMetricsSummary } from '@watchlog/api-types';
import { CircleAlert, CircleCheck, LoaderCircle } from '@lucide/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { testOutcomeKey } from '@/lib/own-add';

const props = defineProps<{
  test: OwnAddressTest | null;
  running: boolean;
  address: string;
  summary: OwnMetricsSummary;
  error?: string;
}>();
const { t } = useI18n();
const ok = computed(() => props.test?.outcome === 'answered');
const words = computed(() => {
  const x = props.test;
  if (!x?.outcome) return '';
  const key = testOutcomeKey(x);
  if (key === 'answered') {
    const n = x.series ?? 0;
    return t(
      'ownMetrics.add.test.outcome.answered',
      { n: n.toLocaleString('en-US'), names: (x.names ?? []).slice(0, 2).join(', ') },
      n,
    );
  }
  return t(`ownMetrics.add.test.outcome.${key}`, { detail: x.detail ?? '' });
});
const kept = computed(() => {
  const x = props.test;
  if (!x || x.kept === undefined || !x.cap) return '';
  return t(`ownMetrics.add.test.kept.${x.cap}`, {
    kept: x.kept.toLocaleString('en-US'),
    max: props.summary.limits.seriesPerSource.toLocaleString('en-US'),
  });
});
</script>

<template>
  <p
    v-if="running"
    class="flex items-start gap-2 text-13 text-text-muted"
    role="status"
    data-testid="own-test-running"
  >
    <LoaderCircle class="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
    {{ $t('ownMetrics.add.test.running', { address }) }}
  </p>
  <p
    v-else-if="test?.outcome"
    :class="['flex items-start gap-2 text-14', ok ? 'text-ok-text' : 'text-warning-text']"
    role="status"
    data-testid="own-test-result"
    :data-outcome="test.outcome"
  >
    <component
      :is="ok ? CircleCheck : CircleAlert"
      class="mt-0.5 size-4 shrink-0"
      aria-hidden="true"
    />
    <span class="min-w-0 break-words"
      >{{ words }} <span v-if="kept" data-testid="own-test-kept">{{ kept }}</span></span
    >
  </p>
  <p v-else-if="error" class="text-13 text-critical-text" role="alert" data-testid="own-test-error">
    {{ error }}
  </p>
</template>
