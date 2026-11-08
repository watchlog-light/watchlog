// SPDX-License-Identifier: AGPL-3.0-only
import { onBeforeUnmount, ref } from 'vue';

/** Copies text to the clipboard; `state` says "copied" or "failed" for 2 seconds. */
export function useCopy() {
  const state = ref<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      state.value = 'copied';
    } catch {
      state.value = 'failed';
    }
    clearTimeout(timer);
    timer = setTimeout(() => (state.value = 'idle'), 2000);
  }
  onBeforeUnmount(() => clearTimeout(timer));
  return { state, copy };
}
