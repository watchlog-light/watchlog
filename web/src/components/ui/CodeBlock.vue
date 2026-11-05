<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Check, Copy } from '@lucide/vue';
import { ref } from 'vue';

const props = defineProps<{ code: string; label: string }>();
const state = ref<'idle' | 'copied' | 'failed'>('idle');
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.code);
    state.value = 'copied';
  } catch {
    state.value = 'failed';
  }
  clearTimeout(timer);
  timer = setTimeout(() => (state.value = 'idle'), 2000);
}
</script>

<template>
  <div class="overflow-hidden rounded-control border border-border bg-bg">
    <div class="flex items-center justify-between border-b border-border px-3 py-1.5">
      <span class="text-12 font-medium text-text-muted">{{ label }}</span>
      <button
        type="button"
        data-testid="copy"
        class="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-12 text-text-muted transition-colors hover:bg-surface-2 hover:text-text"
        @click="copy"
      >
        <Check v-if="state === 'copied'" class="size-3.5 text-ok" aria-hidden="true" />
        <Copy v-else class="size-3.5" aria-hidden="true" />
        <span aria-live="polite">
          {{
            state === 'copied'
              ? $t('common.copied')
              : state === 'failed'
                ? $t('common.copyFailed')
                : $t('common.copy')
          }}
        </span>
      </button>
    </div>
    <pre
      class="overflow-x-auto px-3 py-2.5 font-mono text-13 leading-relaxed text-text"
    ><code>{{ code }}</code></pre>
  </div>
</template>
