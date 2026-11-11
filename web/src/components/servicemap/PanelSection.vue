<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { useId } from 'vue';

// A collapsible section of the service map's right panel (the edge's HTTP, Connections
// and Latency charts; a node's callers and callees). Closed, its content isn't rendered,
// so a chart loads only when opened.
defineProps<{ title: string; testid?: string }>();
const open = defineModel<boolean>('open', { default: false });
const id = useId();
</script>

<template>
  <section class="border-t border-border pt-1" :data-testid="testid">
    <h3>
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded-[6px] py-1.5 text-left text-13 font-semibold text-text hover:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary max-lg:min-h-11"
        :aria-expanded="open"
        :aria-controls="id"
        :data-testid="testid ? `${testid}-toggle` : undefined"
        @click="open = !open"
      >
        <ChevronRight
          class="size-4 flex-none text-text-subtle transition-transform"
          :class="open ? 'rotate-90' : ''"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1">{{ title }}</span>
        <slot name="aside" />
      </button>
    </h3>
    <div v-if="open" :id="id" class="flex flex-col gap-2 pt-1 pb-1">
      <slot />
    </div>
  </section>
</template>
