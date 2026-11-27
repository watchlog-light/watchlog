<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowRight } from '@lucide/vue';
import { formatValue, formatRate } from '@/lib/units';
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';
import { whenAndAgo } from '@/lib/format';
import PanelLink from './PanelLink.vue';

// RabbitMQ's message flow (1.1.0, ADR-243): who publishes, where it is routed, where it
// waits, who takes it, with the rate between each. Side by side from 1024 px, one under the
// other below.
defineProps<{ panel: PanelOf<'flow'> }>();
const textOf = (k: { key: string; values?: Record<string, unknown> }) => {
  const v = { ...(k.values ?? {}) };
  if (typeof v.at === 'number') v.at = whenAndAgo(v.at);
  return { key: k.key, values: v };
};
</script>

<template>
  <ol
    class="flex flex-col items-stretch gap-2 lg:flex-row lg:items-stretch lg:gap-0"
    data-testid="flow"
  >
    <template v-for="(c, i) in panel.columns" :key="c.id">
      <li
        class="flex min-w-0 flex-1 flex-col gap-1.5 rounded-control border bg-surface-2 p-3.5"
        :class="c.severity === 'critical' ? 'border-critical/50' : 'border-border'"
        :data-testid="`flow-${c.id}`"
      >
        <span class="text-12 text-text-muted">{{ $t(c.title.key, c.title.values ?? {}) }}</span>
        <span class="flex items-baseline gap-1.5">
          <span
            class="text-22 font-semibold tabular-nums"
            :class="c.severity ? SEVERITY_TEXT[c.severity] : 'text-text'"
            >{{ formatValue(c.value, c.unit) }}</span
          >
          <span v-if="c.valueKey" class="text-12 text-text-muted">{{ $t(c.valueKey) }}</span>
        </span>
        <ul class="flex flex-col gap-1 text-13">
          <li
            v-for="(r, j) in c.rows"
            :key="j"
            class="flex min-w-0 items-baseline justify-between gap-2"
          >
            <span
              class="truncate"
              :class="[
                r.nameKey ? 'text-text-muted' : 'font-mono',
                r.severity ? SEVERITY_TEXT[r.severity] : r.nameKey ? '' : 'text-text',
              ]"
              :title="r.name || undefined"
            >
              <PanelLink v-if="r.link" :link="r.link">{{ r.name }}</PanelLink>
              <template v-else>{{ r.nameKey ? $t(r.nameKey) : r.name }}</template>
            </span>
            <span
              class="shrink-0 tabular-nums"
              :class="r.severity ? SEVERITY_TEXT[r.severity] : 'text-text-muted'"
              >{{
                r.text
                  ? $t(textOf(r.text).key, textOf(r.text).values)
                  : formatValue(r.value, r.unit)
              }}</span
            >
          </li>
        </ul>
      </li>
      <li
        v-if="i < panel.columns.length - 1"
        class="flex shrink-0 items-center justify-center gap-1.5 text-12 text-text-subtle lg:w-20 lg:flex-col"
        aria-hidden="true"
      >
        <ArrowRight class="hidden size-4 lg:block" />
        <ArrowDown class="size-4 lg:hidden" />
        <span v-if="c.next !== undefined && c.next !== null" class="tabular-nums">{{
          formatRate(c.next)
        }}</span>
      </li>
    </template>
  </ol>
</template>
