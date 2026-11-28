<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ArrowDown, ArrowRight } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { formatRate, formatValue } from '@/lib/units';
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';
import { whenAndAgo } from '@/lib/format';
import PanelLink from './PanelLink.vue';

// RabbitMQ's message flow (1.1.0, ADR-243; the design R1 in 1.1.1): who publishes, where it is
// routed, where it waits, who takes it, with the rate between each above its arrow. Each card's
// number at 26 px with its unit beside it, up to three rows whose names wrap rather than being
// cut, equal heights; the card where messages stop has the red border. Side by side from
// 1024 px, one under the other below.
defineProps<{ panel: PanelOf<'flow'> }>();
const { t } = useI18n();
type Column = PanelOf<'flow'>['columns'][number];

/** The number alone and its unit beside it: "1,240" and "msg/s", "19,870" and "ready". */
function big(c: Column): { n: string; unit: string } {
  if (c.value === null || c.value === undefined) return { n: '–', unit: '' };
  if (c.unit === 'per_second') {
    const n = formatRate(c.value).replace(/\/s$/, '');
    return {
      n: Number(n).toLocaleString('en', { maximumFractionDigits: 2 }),
      unit: t('integrations.rabbitmq.panels.flow.msgPerSecond'),
    };
  }
  if (c.unit === 'count')
    return {
      n: Math.round(c.value).toLocaleString('en'),
      unit: c.valueKey ? t(c.valueKey) : '',
    };
  return { n: formatValue(c.value, c.unit), unit: c.valueKey ? t(c.valueKey) : '' };
}
const textOf = (k: { key: string; values?: Record<string, unknown> }) => {
  const v = { ...(k.values ?? {}) };
  if (typeof v.at === 'number') v.at = whenAndAgo(v.at);
  return { key: k.key, values: v };
};
const title = (c: Column) =>
  typeof c.title.values?.n === 'number'
    ? t(c.title.key, c.title.values, c.title.values.n)
    : t(c.title.key, c.title.values ?? {});
</script>

<template>
  <ol class="flex flex-col items-stretch gap-2 lg:flex-row lg:gap-0" data-testid="flow">
    <template v-for="(c, i) in panel.columns" :key="c.id">
      <li
        class="flex min-w-0 flex-1 flex-col gap-2 rounded-card border bg-surface-2 p-3.5"
        :class="c.severity === 'critical' ? 'border-critical/50' : 'border-border'"
        :data-testid="`flow-${c.id}`"
      >
        <span class="text-12 text-text-muted">{{ title(c) }}</span>
        <span class="flex flex-wrap items-baseline gap-x-1.5" data-testid="flow-value">
          <span
            class="text-26 leading-tight font-bold tabular-nums"
            :class="c.severity ? SEVERITY_TEXT[c.severity] : 'text-text'"
            >{{ big(c).n }}</span
          >
          <span v-if="big(c).unit" class="text-13 text-text-muted">{{ big(c).unit }}</span>
        </span>
        <ul class="flex flex-col gap-1 text-13">
          <li
            v-for="(r, j) in c.rows"
            :key="j"
            class="flex flex-wrap items-baseline justify-between gap-x-2"
            data-testid="flow-row"
          >
            <!-- The name keeps its words whole; a long value moves under it instead. -->
            <span
              class="break-words"
              :class="[
                r.nameKey ? 'text-text-muted' : 'font-mono',
                r.severity ? SEVERITY_TEXT[r.severity] : r.nameKey ? '' : 'text-text',
              ]"
            >
              <PanelLink v-if="r.link" :link="r.link">{{ r.name }}</PanelLink>
              <template v-else-if="r.nameKey && r.text">{{
                $t(textOf(r.text).key, textOf(r.text).values)
              }}</template>
              <template v-else>{{ r.nameKey ? $t(r.nameKey) : r.name }}</template>
            </span>
            <span
              class="ml-auto text-12 tabular-nums"
              :class="r.severity ? SEVERITY_TEXT[r.severity] : 'text-text-muted'"
              >{{
                r.text && !r.nameKey
                  ? $t(textOf(r.text).key, textOf(r.text).values)
                  : formatValue(r.value, r.unit)
              }}</span
            >
          </li>
        </ul>
      </li>
      <li
        v-if="i < panel.columns.length - 1"
        class="flex shrink-0 items-center justify-center gap-1.5 text-12 text-text-subtle lg:w-20 lg:flex-col lg:gap-0.5"
        aria-hidden="true"
      >
        <span v-if="c.nextText" class="tabular-nums">{{
          $t(c.nextText.key, c.nextText.values ?? {})
        }}</span>
        <span v-else-if="c.next !== undefined && c.next !== null" class="tabular-nums">{{
          formatRate(c.next)
        }}</span>
        <ArrowRight class="hidden size-4 lg:block" />
        <ArrowDown class="size-4 lg:hidden" />
      </li>
    </template>
  </ol>
</template>
