<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { SEVERITY_TEXT, SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';
import { formatValue } from '@/lib/units';
import { whenAndAgo } from '@/lib/format';
import PanelLink from './PanelLink.vue';

// The workloads that connected to the service in the last 24 hours (1.1.0), from the agents'
// network flows: where each runs, connections opened, bytes each way now, its role when the
// traffic clearly says so ("Mostly publishes"), and how it ended when it did.
defineProps<{ panel: PanelOf<'clients'> }>();
type Row = PanelOf<'clients'>['rows'][number];
const stateText = (r: Row) => {
  const v = { ...(r.state.values ?? {}) };
  if (typeof v.at === 'number') v.at = whenAndAgo(v.at);
  return { key: `integrations.rabbitmq.panels.client.${r.state.key}`, values: v };
};
const where = (r: Row) => ({
  key: `integrations.rabbitmq.panels.client.${r.where.key}`,
  values: r.where.values ?? {},
});
</script>

<template>
  <div class="-mx-4 overflow-x-auto">
    <table class="w-full min-w-[50rem] text-13">
      <thead>
        <tr
          class="border-b border-border text-left text-11 font-medium tracking-wider text-text-muted uppercase"
        >
          <th scope="col" class="px-4 py-2 font-medium">
            {{ $t('integrations.rabbitmq.panels.client.workload') }}
          </th>
          <th scope="col" class="px-4 py-2 font-medium">
            {{ $t('integrations.rabbitmq.panels.client.where') }}
          </th>
          <th scope="col" class="px-4 py-2 text-right font-medium">
            {{ $t('integrations.rabbitmq.panels.client.connections') }}
          </th>
          <th scope="col" class="px-4 py-2 text-right font-medium">
            {{ $t('integrations.rabbitmq.panels.client.sends') }}
          </th>
          <th scope="col" class="px-4 py-2 text-right font-medium">
            {{ $t('integrations.rabbitmq.panels.client.receives') }}
          </th>
          <th scope="col" class="px-4 py-2 font-medium">
            {{ $t('integrations.rabbitmq.panels.client.mostly') }}
          </th>
          <th scope="col" class="px-4 py-2 font-medium">
            {{ $t('integrations.rabbitmq.panels.client.state') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in panel.rows"
          :key="r.name"
          class="border-t border-border first:border-t-0"
          data-testid="client-row"
          :data-client="r.name"
        >
          <td class="max-w-[16rem] px-4 py-2">
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="size-2 shrink-0 rounded-full"
                :style="{ background: `var(${SEVERITY_TOKEN[r.severity ?? 'ok']})` }"
                aria-hidden="true"
              />
              <span class="truncate font-mono" :title="r.name">
                <PanelLink v-if="r.link" :link="r.link">{{ r.name }}</PanelLink>
                <template v-else>{{ r.name }}</template>
              </span>
            </div>
          </td>
          <td class="px-4 py-2 text-text-muted">{{ $t(where(r).key, where(r).values) }}</td>
          <td class="px-4 py-2 text-right text-text-muted tabular-nums">{{ r.connections }}</td>
          <td class="px-4 py-2 text-right text-text-muted tabular-nums">
            {{ r.sends === null ? '–' : formatValue(r.sends, 'bytes_per_second') }}
          </td>
          <td class="px-4 py-2 text-right text-text-muted tabular-nums">
            {{ r.receives === null ? '–' : formatValue(r.receives, 'bytes_per_second') }}
          </td>
          <td class="px-4 py-2">
            <span
              v-if="r.mostly"
              class="inline-flex rounded-full px-2.5 py-0.5 text-12 font-medium"
              :class="r.mostly === 'publishes' ? 'bg-info/15 text-text' : 'bg-ok/15 text-ok-text'"
              :data-testid="`mostly-${r.mostly}`"
              >{{ $t(`integrations.rabbitmq.panels.client.mostly_${r.mostly}`) }}</span
            >
            <span v-else class="text-text-subtle">–</span>
          </td>
          <td class="px-4 py-2" :class="r.severity ? SEVERITY_TEXT[r.severity] : 'text-text-muted'">
            {{ $t(stateText(r).key, stateText(r).values) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
