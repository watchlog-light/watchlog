<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { BellOff, Check, Clock, PauseCircle, Repeat, X } from '@lucide/vue';
import type { Alert } from '@watchlog/api-types';
import { computed } from 'vue';
import TonePill from '@/components/kube/TonePill.vue';
import { alertScope, deliveryTone, severityTone } from '@/lib/alerts';
import { since } from '@/lib/time';
import SilenceMenu from './SilenceMenu.vue';

// One alert (alerts redesign item 7): severity, what is wrong, where, why, how long,
// whether each channel got it, and Silence / Open.
const props = defineProps<{ alert: Alert; canSilence: boolean }>();
const emit = defineEmits<{ silenced: []; custom: [alert: Alert] }>();
const scope = computed(() => alertScope(props.alert));
const ICON = { ok: Check, critical: X, neutral: Clock } as const;
const TONE = { ok: 'text-ok', critical: 'text-critical', neutral: 'text-text-muted' } as const;
</script>

<template>
  <li
    class="grid grid-cols-1 gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
    data-testid="alert-row"
  >
    <div>
      <TonePill
        :tone="alert.state === 'pending' ? 'neutral' : severityTone(alert.severity)"
        :label="
          alert.state === 'pending'
            ? $t('alerts.state.pending')
            : $t(`alerts.severity.${alert.severity}`)
        "
      />
    </div>
    <div class="min-w-0">
      <RouterLink
        :to="{ name: 'alert', params: { id: alert.id } }"
        class="font-medium text-text hover:underline"
        data-testid="alert-title"
      >
        {{ alert.title }}
      </RouterLink>
      <p class="truncate text-13 text-text-muted" data-testid="alert-where">
        {{ $t(`alerts.scopeKind.${scope.kind}`, scope.kind) }}
        <code class="font-mono text-12 text-text">{{ scope.name }}</code>
        <template v-if="scope.extra"> · {{ scope.extra }}</template>
        <template v-if="alert.podCount > 1">
          · {{ $t('alerts.pods', { n: alert.podCount }) }}</template
        >
      </p>
      <p
        v-if="alert.why"
        class="mt-1 font-mono text-12 break-words text-text-subtle"
        data-testid="alert-why"
      >
        {{ alert.why }}
      </p>
      <p
        v-if="alert.silenced || alert.flapping || alert.held"
        class="mt-1 flex flex-wrap gap-3 text-12 text-text-muted"
      >
        <span v-if="alert.silenced" class="inline-flex items-center gap-1" data-testid="silenced">
          <BellOff class="size-3.5" aria-hidden="true" />{{ $t('alerts.silenced') }}
        </span>
        <span v-if="alert.flapping" class="inline-flex items-center gap-1">
          <Repeat class="size-3.5" aria-hidden="true" />{{ $t('alerts.flapping') }}
        </span>
        <span v-if="alert.held" class="inline-flex items-center gap-1" data-testid="held">
          <PauseCircle class="size-3.5" aria-hidden="true" />{{ $t('alerts.heldMark') }}
        </span>
      </p>
    </div>
    <div class="flex flex-col items-start gap-1.5 sm:items-end sm:text-right">
      <span class="font-mono text-12 text-text-muted tabular">{{ since(alert.startedAt) }}</span>
      <ul
        v-if="alert.deliveries.length"
        class="flex flex-wrap gap-2 text-12"
        data-testid="deliveries"
      >
        <li
          v-for="d in alert.deliveries"
          :key="d.channelId"
          :class="['inline-flex items-center gap-1', TONE[deliveryTone(d.status)]]"
          :title="d.error ?? $t(`alerts.delivery.${d.status}`)"
        >
          <component :is="ICON[deliveryTone(d.status)]" class="size-3.5" aria-hidden="true" />
          {{ d.name }}
          <span class="sr-only"
            >{{ $t(`alerts.delivery.${d.status}`) }}{{ d.error ? `: ${d.error}` : '' }}</span
          >
        </li>
      </ul>
      <div class="flex items-center gap-1.5">
        <SilenceMenu
          v-if="canSilence && !alert.silenced && alert.state !== 'resolved'"
          :alert="alert"
          @silenced="emit('silenced')"
          @custom="emit('custom', alert)"
        />
        <RouterLink
          :to="{ name: 'alert', params: { id: alert.id } }"
          class="inline-flex h-7 items-center rounded-control px-2.5 text-12 text-text-muted hover:bg-surface-2 hover:text-text"
        >
          {{ $t('alerts.open') }}
        </RouterLink>
      </div>
    </div>
  </li>
</template>
