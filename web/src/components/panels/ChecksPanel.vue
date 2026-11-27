<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { computed } from 'vue';
import type { PanelOf } from '@/lib/panels';
import PanelLink from './PanelLink.vue';

// Is the broker itself fine (1.1.0): each check passes, warns or fails, with its value; a
// failed one links to where it is explained or fixed. Only checks the metrics can answer.
const props = defineProps<{ panel: PanelOf<'checks'> }>();
const passed = computed(() => props.panel.items.filter((i) => i.state === 'pass').length);
const DOT = { pass: 'var(--ok)', warn: 'var(--warning)', fail: 'var(--critical)' } as const;
</script>

<template>
  <div class="flex flex-col gap-2.5">
    <p class="text-13 text-text-muted" data-testid="checks-summary">
      {{ $t('integrations.rabbitmq.panels.checks.summary', { n: passed, m: panel.items.length }) }}
    </p>
    <ul class="flex flex-col divide-y divide-border">
      <li
        v-for="c in panel.items"
        :key="c.id"
        class="flex items-center gap-2.5 py-2 text-13"
        :data-testid="`check-${c.id}`"
        :data-state="c.state"
      >
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: DOT[c.state] }"
          aria-hidden="true"
        />
        <span class="sr-only"
          >{{ $t(`integrations.rabbitmq.panels.checks.state.${c.state}`) }}:
        </span>
        <span class="min-w-0 flex-1 text-text">
          <PanelLink v-if="c.link && c.state !== 'pass'" :link="c.link">{{
            $t(c.labelKey)
          }}</PanelLink>
          <template v-else>{{ $t(c.labelKey) }}</template>
        </span>
        <span
          class="shrink-0 text-right tabular-nums"
          :class="
            c.state === 'fail'
              ? 'text-critical-text'
              : c.state === 'warn'
                ? 'text-warning-text'
                : 'text-text-muted'
          "
          >{{ $t(c.value.key, c.value.values ?? {}) }}</span
        >
      </li>
    </ul>
  </div>
</template>
