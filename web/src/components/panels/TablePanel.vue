<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';

// Rows from the service (slow queries, queues, upstreams): text from the service is data,
// shown in mono and truncated with its full value on hover; a row with a severity is
// coloured in its first cell and marked for screen readers.
defineProps<{ panel: PanelOf<'table'> }>();
</script>

<template>
  <div class="-mx-4 overflow-x-auto">
    <table class="w-full min-w-[28rem] text-13">
      <thead>
        <tr
          class="border-b border-border text-left text-11 font-medium tracking-wider text-text-muted uppercase"
        >
          <th v-for="c in panel.columns" :key="c" scope="col" class="px-4 py-2 font-medium">
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
              'max-w-[24rem] truncate px-4 py-2',
              j === 0 ? 'font-mono' : 'text-text-muted tabular-nums',
              j === 0 && r.severity ? SEVERITY_TEXT[r.severity] : '',
            ]"
            :title="cell === null ? undefined : String(cell)"
          >
            <span v-if="j === 0 && r.severity && r.severity !== 'ok'" class="sr-only"
              >{{ $t(`integrations.severity.${r.severity}`) }}:
            </span>
            {{ cell ?? '–' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
