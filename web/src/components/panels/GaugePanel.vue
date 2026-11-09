<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { formatValue } from '@/lib/units';
import { gaugeLevel, SEVERITY_TOKEN, type PanelOf } from '@/lib/panels';

// Capacity: how full something is against its limit (memory against maxmemory, connections
// against max_connections, a disk). The number and its limit are text; the bar turns
// warning and critical as it fills, and says so in words for screen readers.
defineProps<{ panel: PanelOf<'gauge'> }>();
</script>

<template>
  <ul class="flex flex-col gap-3.5">
    <li v-for="(g, i) in panel.items" :key="i" class="flex flex-col gap-1.5" data-testid="gauge">
      <div class="flex flex-wrap items-baseline justify-between gap-2 text-13">
        <span class="truncate text-text" :class="{ 'font-mono': !!g.label }">{{
          g.labelKey ? $t(g.labelKey) : g.label
        }}</span>
        <span class="text-text-muted tabular-nums">
          {{
            $t('integrations.panel.ofLimit', {
              value: formatValue(g.value, g.unit),
              max: formatValue(g.max, g.unit),
            })
          }}
        </span>
      </div>
      <div
        class="h-2 overflow-hidden rounded-full bg-surface-3"
        role="meter"
        :aria-valuenow="g.value"
        :aria-valuemin="0"
        :aria-valuemax="g.max"
        :aria-valuetext="`${Math.round(gaugeLevel(g.value, g.max, g.warnAt).share * 100)}% · ${$t(`integrations.severity.${gaugeLevel(g.value, g.max, g.warnAt).severity}`)}`"
      >
        <span
          class="block h-full rounded-full"
          :style="{
            width: `${gaugeLevel(g.value, g.max, g.warnAt).share * 100}%`,
            background: `var(${SEVERITY_TOKEN[gaugeLevel(g.value, g.max, g.warnAt).severity]})`,
          }"
        />
      </div>
      <span v-if="g.note" class="text-12 text-text-muted">{{
        $t(g.note.key, g.note.values ?? {})
      }}</span>
    </li>
  </ul>
</template>
