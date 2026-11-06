<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import type { Alert, CreateSilenceRequest } from '@watchlog/api-types';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { ref } from 'vue';
import { api } from '@/api/client';
import { silenceMatchersFor } from '@/lib/alerts';

// "Silence ▾" (alerts redesign item 7): silence an alert's rule and scope for a
// chosen time in one step, or open the form for a comment.
const props = defineProps<{ alert: Alert }>();
const emit = defineEmits<{ silenced: []; custom: [] }>();
const DURATIONS = [60, 240, 1440, 10080] as const;
const busy = ref(false);

async function silence(minutes: number) {
  busy.value = true;
  try {
    await api('/silences', {
      method: 'POST',
      body: {
        matchers: silenceMatchersFor(props.alert) as CreateSilenceRequest['matchers'],
        durationMinutes: minutes,
        comment: '',
      } satisfies CreateSilenceRequest,
    });
    emit('silenced');
  } finally {
    busy.value = false;
  }
}
const item =
  'flex cursor-pointer items-center rounded-control px-2 py-1.5 text-13 text-text outline-none data-[highlighted]:bg-surface-3 max-lg:min-h-11';
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger
      :disabled="busy"
      class="inline-flex h-7 items-center gap-1 rounded-control border border-border-strong bg-surface-2 px-2.5 text-12 text-text hover:bg-surface-3 disabled:opacity-60 max-lg:h-11 max-lg:px-3.5 max-lg:text-13"
      data-testid="silence-menu"
    >
      {{ $t('alerts.silence.action') }}
      <ChevronDown class="size-3.5 text-text-subtle" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="end"
        :side-offset="4"
        class="z-50 min-w-40 rounded-card border border-border bg-surface-2 p-1 shadow-lg"
      >
        <DropdownMenuItem
          v-for="d in DURATIONS"
          :key="d"
          :class="item"
          :data-testid="`silence-for-${d}`"
          @select="silence(d)"
        >
          {{ $t('alerts.silence.forDuration', { d: $t(`alerts.silence.durations.${d}`) }) }}
        </DropdownMenuItem>
        <DropdownMenuSeparator class="my-1 h-px bg-border" />
        <DropdownMenuItem :class="item" data-testid="silence-custom" @select="emit('custom')">
          {{ $t('alerts.silence.withComment') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
