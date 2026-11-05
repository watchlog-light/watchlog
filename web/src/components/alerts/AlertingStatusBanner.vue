<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { CircleX } from '@lucide/vue';
import { onBeforeUnmount, onMounted } from 'vue';
import { formatDateTime } from '@/lib/format';
import { useAlertingStore } from '@/stores/alerting';

// ADR-088: when no alert-worker completed a cycle within 2 minutes, alerting fails
// silently unless every page says so.
const alerting = useAlertingStore();
let stop: (() => void) | undefined;
onMounted(() => (stop = alerting.watch()));
onBeforeUnmount(() => stop?.());
</script>

<template>
  <div
    v-if="alerting.status && !alerting.status.running"
    role="alert"
    class="flex items-start gap-3 border-b border-critical bg-surface-1 px-6 py-3"
    data-testid="alerting-down"
  >
    <CircleX class="mt-0.5 size-5 shrink-0 text-critical" aria-hidden="true" />
    <div class="min-w-0">
      <p class="text-14 font-semibold text-text">{{ $t('alerts.down.title') }}</p>
      <p class="text-13 text-text-muted">
        {{ $t('alerts.down.description') }}
        <template v-if="alerting.status.lastCycleAt">
          {{ $t('alerts.down.lastCycle', { at: formatDateTime(alerting.status.lastCycleAt) }) }}
        </template>
      </p>
    </div>
  </div>
</template>
