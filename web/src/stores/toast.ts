// SPDX-License-Identifier: AGPL-3.0-only
// Short messages that appear over every page and go away by themselves (SPEC §11.3 Toast).
import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'warning';
}

/** How long a toast stays, in milliseconds. */
export const TOAST_MS = 6000;
const MAX_TOASTS = 3;

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  let next = 1;

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  /** Shows a message; the same message twice in a row shows once. */
  function show(message: string, tone: Toast['tone'] = 'info') {
    const same = toasts.value.find((t) => t.message === message);
    if (same) dismiss(same.id);
    const toast = { id: next++, message, tone };
    toasts.value = [...toasts.value, toast].slice(-MAX_TOASTS);
    setTimeout(() => dismiss(toast.id), TOAST_MS);
    return toast.id;
  }

  return { toasts, show, dismiss };
});
