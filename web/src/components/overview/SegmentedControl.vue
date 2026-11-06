<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts" generic="V extends string">
// A small segmented control (CPU | Memory | Network) with aria-pressed buttons.
defineProps<{ options: { value: V; label: string }[]; label: string }>();
const model = defineModel<V>({ required: true });
</script>

<template>
  <div
    class="inline-flex gap-0.5 rounded-[7px] border border-border bg-surface-2 p-0.5"
    role="group"
    :aria-label="label"
  >
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="rounded-[5px] px-2.5 py-0.5 text-12 max-lg:min-h-11 max-lg:min-w-11 max-lg:px-3.5"
      :class="model === o.value ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
      :aria-pressed="model === o.value"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>
