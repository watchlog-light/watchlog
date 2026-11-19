// SPDX-License-Identifier: AGPL-3.0-only
// Short messages that appear over every page and go away by themselves (SPEC §11.3 Toast).
import { defineStore } from 'pinia';
import { ref } from 'vue';

/** One thing the reader can do about what the toast says: "Undo". */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'warning';
  action?: ToastAction;
}

/** How long a toast stays, in milliseconds. */
export const TOAST_MS = 6000;
/** One with something to press stays longer: time to read it and reach the button. */
export const TOAST_ACTION_MS = 10_000;
const MAX_TOASTS = 3;

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);
  let next = 1;

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  /** Shows a message; the same message twice in a row shows once. */
  function show(message: string, tone: Toast['tone'] = 'info', action?: ToastAction) {
    const same = toasts.value.find((t) => t.message === message);
    if (same) dismiss(same.id);
    const toast: Toast = { id: next++, message, tone, ...(action ? { action } : {}) };
    toasts.value = [...toasts.value, toast].slice(-MAX_TOASTS);
    setTimeout(() => dismiss(toast.id), action ? TOAST_ACTION_MS : TOAST_MS);
    return toast.id;
  }

  /** The toast's button: the toast goes, then its action runs, once. */
  function act(id: number) {
    const toast = toasts.value.find((t) => t.id === id);
    if (!toast?.action) return;
    dismiss(id);
    void toast.action.run();
  }

  return { toasts, show, dismiss, act };
});
