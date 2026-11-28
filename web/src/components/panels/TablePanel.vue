<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';
import PanelLink from './PanelLink.vue';

// Rows from the service (slow queries, queues, upstreams): text from the service is data,
// shown in mono and truncated with its full value on hover; a row with a severity is
// coloured in its first cell and marked for screen readers.
const props = defineProps<{ panel: PanelOf<'table'> }>();
// A clock column (1.2) holds unix seconds: the viewer's time of day, with the day when it
// isn't today.
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
// Six columns or more (MySQL's connections by client) fit the design's column with less room
// between them.
const pad = props.panel.columns.length >= 6 ? 'px-2.5 first:pl-4 last:pr-4' : 'px-4';
function show(cell: string | number | null, j: number) {
  if (cell === null) return '–';
  if (typeof cell !== 'number' || !props.panel.clock?.includes(j)) return cell;
  const d = new Date(cell * 1000);
  return (d.toDateString() === new Date().toDateString() ? clockFmt : dayFmt).format(d);
}
</script>

<template>
  <div class="-mx-4 overflow-x-auto">
    <table class="w-full min-w-[28rem] text-13">
      <thead>
        <tr
          class="border-b border-border text-left text-11 font-medium tracking-wider text-text-muted uppercase"
        >
          <th
            v-for="c in panel.columns"
            :key="c"
            scope="col"
            :class="['py-2 font-medium whitespace-nowrap', pad]"
          >
            {{ $t(c) }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(r, i) in panel.rows"
          :key="i"
          class="border-t border-border first:border-t-0"
          data-testid="table-row"
        >
          <td
            v-for="(cell, j) in r.cells"
            :key="j"
            :class="[
              'max-w-[24rem] truncate py-2',
              pad,
              j === 0 ? 'font-mono' : 'text-text-muted tabular-nums',
              j === 0 && r.severity ? SEVERITY_TEXT[r.severity] : '',
            ]"
            :title="cell === null ? undefined : String(show(cell, j))"
          >
            <span v-if="j === 0 && r.severity && r.severity !== 'ok'" class="sr-only"
              >{{ $t(`integrations.severity.${r.severity}`) }}:
            </span>
            <PanelLink v-if="j === 0 && r.link" :link="r.link">{{ cell ?? '–' }}</PanelLink>
            <template v-else>{{ show(cell, j) }}</template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
