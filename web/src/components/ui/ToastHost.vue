<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Info, TriangleAlert, X } from '@lucide/vue';
import { storeToRefs } from 'pinia';
import { useToastStore } from '@/stores/toast';

// One live region for the whole app (SPEC §11.3 Toast): bottom right on desktops,
// full width above the bottom edge on phones.
const store = useToastStore();
const { toasts } = storeToRefs(store);
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-stretch gap-2 md:inset-x-auto md:right-6 md:bottom-6 md:w-96"
    role="status"
    aria-live="polite"
    data-testid="toasts"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="pointer-events-auto flex items-start gap-3 rounded-card border border-border-strong bg-surface-2 py-3 pr-2 pl-4 shadow-xl"
      data-testid="toast"
    >
      <TriangleAlert
        v-if="toast.tone === 'warning'"
        class="mt-0.5 size-4 shrink-0 text-warning"
        aria-hidden="true"
      />
      <Info v-else class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      <p class="min-w-0 flex-1 py-px text-13 leading-relaxed text-text">{{ toast.message }}</p>
      <button
        type="button"
        class="-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-3 hover:text-text max-lg:-my-2.5 max-lg:size-11"
        :aria-label="$t('common.close')"
        @click="store.dismiss(toast.id)"
      >
        <X class="size-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
