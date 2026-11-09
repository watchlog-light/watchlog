<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { formatValue } from '@/lib/units';
import { SEVERITY_TEXT, type PanelOf } from '@/lib/panels';

// Stat tiles: a label, the number, a short line under it. A warning or critical value
// is coloured and its border too; the label says what it is (never colour alone).
defineProps<{ panel: PanelOf<'stat'> }>();
const shown = (t: PanelOf<'stat'>['tiles'][number]) =>
  typeof t.value === 'number' && t.unit ? formatValue(t.value, t.unit) : (t.value ?? '–');
</script>

<template>
  <div class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2.5">
    <div
      v-for="t in panel.tiles"
      :key="t.id"
      :class="[
        'flex flex-col gap-1 rounded-[10px] border bg-bg p-3',
        t.severity === 'critical'
          ? 'border-critical/50'
          : t.severity === 'warning'
            ? 'border-warning/50'
            : 'border-border',
      ]"
      :data-tile="t.id"
    >
      <span class="text-11 font-medium tracking-wider text-text-muted uppercase">{{
        $t(t.labelKey)
      }}</span>
      <span :class="['text-22 font-semibold tabular-nums', SEVERITY_TEXT[t.severity ?? 'ok']]">{{
        shown(t)
      }}</span>
      <span v-if="t.sub" class="text-12 text-text-muted">{{
        $t(t.sub.key, t.sub.values ?? {})
      }}</span>
    </div>
  </div>
</template>
