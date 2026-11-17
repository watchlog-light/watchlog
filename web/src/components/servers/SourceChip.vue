<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A workload's source (ADR-207): Service, Process or Container, each in its own chart colour
// with its name written out (never colour alone, SPEC §11.1).
defineProps<{ source: 'service' | 'process' | 'container'; label: string }>();
</script>

<template>
  <span
    class="chip inline-flex items-center rounded-control border px-1.5 py-px text-12 whitespace-nowrap"
    :class="`chip-${source}`"
    :data-source="source"
    >{{ label }}</span
  >
</template>

<style scoped>
.chip-service {
  color: var(--chart-2);
  border-color: color-mix(in srgb, var(--chart-2) 45%, transparent);
  background: color-mix(in srgb, var(--chart-2) 10%, transparent);
}
.chip-process {
  color: var(--chart-4);
  border-color: color-mix(in srgb, var(--chart-4) 45%, transparent);
  background: color-mix(in srgb, var(--chart-4) 10%, transparent);
}
.chip-container {
  color: var(--chart-5);
  border-color: color-mix(in srgb, var(--chart-5) 45%, transparent);
  background: color-mix(in srgb, var(--chart-5) 10%, transparent);
}
</style>
