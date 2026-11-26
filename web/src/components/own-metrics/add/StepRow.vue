<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
// One numbered step of a way in (1.0.3): its number, its title, what to do.
defineProps<{ n: number; title: string }>();
</script>

<template>
  <section class="flex gap-3.5 border-t border-border py-4 first:border-t-0 first:pt-0">
    <span
      class="flex size-[26px] shrink-0 items-center justify-center rounded-full border border-ok/50 bg-ok/10 text-13 font-semibold text-ok-text"
      aria-hidden="true"
      >{{ n }}</span
    >
    <div class="min-w-0 flex-1">
      <h3 class="text-14 font-semibold text-text">
        <span class="sr-only">{{ n }}. </span>{{ title }}
      </h3>
      <div class="mt-2"><slot /></div>
    </div>
  </section>
</template>
