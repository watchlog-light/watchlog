<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// A label over a value, with an optional line of detail (same metrics as SkeletonStatTile).
defineProps<{ label: string; value: string; sub?: string }>();
</script>

<template>
  <div class="rounded-card border border-border bg-surface-1 px-4 py-3">
    <dt class="text-12 text-text-subtle">{{ label }}</dt>
    <dd class="font-mono text-20 text-text tabular">{{ value }}</dd>
    <dd v-if="sub || $slots.default" class="mt-0.5 text-12 text-text-muted">
      <slot>{{ sub }}</slot>
    </dd>
  </div>
</template>
