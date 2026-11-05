<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// Base skeleton block. A "line" is exactly one line box of the surrounding text size
// (1lh), so a skeleton line inside `text-13` is as tall as a real 13 px line and
// nothing shifts when the text arrives. Size circles and rects with classes.
withDefaults(defineProps<{ shape?: 'line' | 'circle' | 'rect' }>(), { shape: 'line' });
</script>

<template>
  <span v-if="shape === 'line'" class="block h-[1lh] py-[0.25lh]" aria-hidden="true">
    <span class="skeleton block h-full rounded-sm" />
  </span>
  <span
    v-else
    :class="['skeleton block', shape === 'circle' ? 'rounded-full' : 'rounded-control']"
    aria-hidden="true"
  />
</template>

<style scoped>
.skeleton {
  background-color: var(--surface-2);
  background-image: linear-gradient(
    90deg,
    var(--surface-2) 0%,
    var(--surface-3) 50%,
    var(--surface-2) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}

@keyframes shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
    background-image: none;
  }
}
</style>
