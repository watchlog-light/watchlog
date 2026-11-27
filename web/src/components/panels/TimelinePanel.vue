<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { formatWhen } from '@/lib/format';
import { SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';
import PanelLink from './PanelLink.vue';

// What happened around something, oldest first (1.1.0, a queue's page): each event's time
// in the reader's clock, what happened, and where WatchLog saw it.
defineProps<{ panel: PanelOf<'timeline'> }>();
const when = (at: number) => formatWhen(new Date(at * 1000).toISOString());
</script>

<template>
  <ol class="flex flex-col gap-2.5">
    <li
      v-for="(e, i) in panel.events"
      :key="i"
      class="grid grid-cols-[3.25rem_0.75rem_minmax(0,1fr)] items-start gap-2 text-13"
      data-testid="timeline-event"
    >
      <span class="text-text-muted tabular-nums">{{ when(e.at) }}</span>
      <span
        class="mt-1.5 size-2 rounded-full"
        :style="{ background: `var(${SEVERITY_TOKEN[e.severity ?? 'info']})` }"
        aria-hidden="true"
      />
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="text-text">
          <PanelLink v-if="e.link" :link="e.link">{{
            $t(e.text.key, e.text.values ?? {})
          }}</PanelLink>
          <template v-else>{{ $t(e.text.key, e.text.values ?? {}) }}</template>
        </span>
        <span class="text-12 text-text-subtle">{{ $t(e.sourceKey) }}</span>
      </span>
    </li>
  </ol>
</template>
