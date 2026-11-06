<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// The heatmap's key: CPU bands, over request (Docker: limit) and failing.
defineProps<{ docker?: boolean }>();
</script>

<template>
  <ul class="flex flex-wrap gap-x-3 gap-y-1 text-12 text-text-muted" data-testid="heat-legend">
    <li><i class="h-low" />{{ $t('heat.legend.low') }}</li>
    <li><i class="h-mid" />{{ $t('heat.legend.mid') }}</li>
    <li><i class="h-high" />{{ $t('heat.legend.high') }}</li>
    <li><i class="h-over" />{{ $t(docker ? 'heat.legend.overLimit' : 'heat.legend.over') }}</li>
    <li><i class="h-fail" aria-hidden="true">✕</i>{{ $t('heat.legend.fail') }}</li>
  </ul>
</template>

<style scoped>
li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
i {
  display: inline-flex;
  width: 10px;
  height: 10px;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  font-size: 7px;
  font-style: normal;
  font-weight: 700;
}
.h-fail {
  background: var(--critical);
  color: var(--text);
}
.h-over {
  background: var(--warning);
}
.h-high {
  background: color-mix(in srgb, var(--ok) 85%, transparent);
}
.h-mid {
  background: color-mix(in srgb, var(--ok) 50%, transparent);
}
.h-low {
  background: color-mix(in srgb, var(--ok) 20%, transparent);
}
</style>
