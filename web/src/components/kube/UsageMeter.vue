<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { share } from '@/lib/kube';
import { formatValue, type Unit } from '@/lib/units';

// Usage and requests against allocatable (SPEC §4.1): a filled bar for usage and a tick
// for requests, with both numbers written out.
const props = defineProps<{
  usage: number | null;
  requests: number;
  allocatable: number | null;
  unit: Unit;
  compact?: boolean;
}>();
const { t } = useI18n();
const used = computed(() => share(props.usage, props.allocatable));
const requested = computed(() => share(props.requests, props.allocatable));
const pct = (v: number | null) => `${Math.min(100, Math.max(0, (v ?? 0) * 100))}%`;
const label = computed(() =>
  t('kube.usage.aria', {
    used: formatValue(used.value, 'ratio'),
    requested: formatValue(requested.value, 'ratio'),
  }),
);
</script>

<template>
  <div class="flex flex-col gap-1" :aria-label="label" role="img">
    <div class="flex flex-wrap items-baseline justify-between gap-x-2 font-mono text-13 tabular">
      <span class="text-text">{{ formatValue(used, 'ratio') }}</span>
      <span v-if="!compact" class="text-12 whitespace-nowrap text-text-muted">
        {{ formatValue(usage, unit) }} / {{ formatValue(allocatable, unit) }}
      </span>
    </div>
    <div class="relative h-1.5 rounded-full bg-surface-3">
      <div
        :class="[
          'absolute inset-y-0 left-0 rounded-full',
          (used ?? 0) >= 0.9 ? 'bg-critical' : (used ?? 0) >= 0.75 ? 'bg-warning' : 'bg-ok',
        ]"
        :style="{ width: pct(used) }"
      />
      <div
        v-if="requested !== null"
        class="absolute -inset-y-0.5 w-0.5 rounded-full bg-text-muted"
        :style="{ left: pct(requested) }"
        data-testid="requests-tick"
      />
    </div>
    <span class="text-12 text-text-muted">
      {{ $t('kube.usage.requests', { v: formatValue(requested, 'ratio') }) }}
    </span>
  </div>
</template>
