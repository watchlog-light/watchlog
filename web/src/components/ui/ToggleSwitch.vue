<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// An on/off switch with its label (a checkbox underneath, so keyboard and screen
// readers treat it as one).
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="sw">
    <input v-model="model" type="checkbox" />
    <slot />
  </label>
</template>

<style scoped>
.sw {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.sw input {
  position: relative;
  width: 30px;
  height: 18px;
  margin: 0;
  flex: none;
  border-radius: 999px;
  background: var(--surface-3);
  appearance: none;
  cursor: pointer;
}
.sw input::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-subtle);
  content: '';
  transition: left 0.15s;
}
.sw input:checked {
  background: var(--primary);
}
.sw input:checked::after {
  left: 15px;
  background: var(--on-primary);
}
.sw input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .sw input::after {
    transition: none;
  }
}
</style>
