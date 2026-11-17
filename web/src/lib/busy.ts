// SPDX-License-Identifier: AGPL-3.0-only
// "Busy, retrying…" (ADR-206): a 429 or a 503 that clears by itself is never an error. Each
// loader that met one keeps its data, retries with backoff, and holds one busy mark while it
// waits; the top bar shows one note while any mark is held.
import { computed, ref } from 'vue';

const marks = ref(0);
/** Whether any request is waiting out a busy answer. */
export const anyBusy = computed(() => marks.value > 0);

/** Takes a busy mark; the returned function gives it back, once. */
export function holdBusy(): () => void {
  marks.value++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    marks.value--;
  };
}

/** The first wait, then doubling up to the cap. */
export const BUSY_BASE_MS = 2_000;
export const BUSY_MAX_MS = 30_000;

/**
 * How long to wait before the next try: 2, 4, 8, 16, then 30 s, never sooner than the
 * server's Retry-After, and spread by up to 20 % so visitors don't come back in step.
 */
export function busyDelay(attempt: number, retryAfterS?: number, rand = Math.random): number {
  const backoff = Math.min(BUSY_MAX_MS, BUSY_BASE_MS * 2 ** attempt);
  const base = Math.max(backoff, (retryAfterS ?? 0) * 1000);
  return Math.round(base * (1 + 0.2 * rand()));
}
