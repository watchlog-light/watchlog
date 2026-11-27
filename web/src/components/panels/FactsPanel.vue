<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { PanelOf } from '@/lib/panels';
import { formatValue } from '@/lib/units';

// Facts as label and value (1.1.0, a queue's page).
defineProps<{ panel: PanelOf<'facts'> }>();
</script>

<template>
  <dl class="flex flex-col divide-y divide-border text-13">
    <div
      v-for="f in panel.rows"
      :key="f.labelKey"
      class="flex items-baseline justify-between gap-3 py-2"
    >
      <dt class="text-text-muted">{{ $t(f.labelKey) }}</dt>
      <dd class="min-w-0 truncate text-right font-mono text-text tabular-nums">
        {{
          f.text
            ? $t(f.text.key, f.text.values ?? {})
            : f.unit && typeof f.value === 'number'
              ? formatValue(f.value, f.unit)
              : (f.value ?? '–')
        }}
      </dd>
    </div>
  </dl>
</template>
