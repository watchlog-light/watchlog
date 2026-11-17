// SPDX-License-Identifier: AGPL-3.0-only
// One way to refresh a page or panel on an interval (ADR-206), every edition: the next tick
// is planned once the last one finished (never two at once), each interval is spread by
// ±20 % so tabs opened together don't poll in step, nothing runs while the tab is hidden,
// and a tick missed while hidden runs as soon as the tab is visible again.
import { getCurrentScope, onScopeDispose } from 'vue';

export const POLL_JITTER = 0.2;

/** An interval spread by ±20 %. */
export const jittered = (ms: number, rand = Math.random) =>
  Math.round(ms * (1 - POLL_JITTER + 2 * POLL_JITTER * rand()));

export function usePolling(tick: () => unknown, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let missed = false;

  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  function plan() {
    clearTimeout(timer);
    if (running) timer = setTimeout(() => void run(), jittered(ms));
  }

  async function run() {
    if (!running) return;
    if (hidden()) {
      missed = true; // planned again when the tab is visible
      return;
    }
    try {
      await tick();
    } catch {
      // The tick shows its own errors; polling goes on.
    } finally {
      plan();
    }
  }

  function onVisibility() {
    if (!running || hidden() || !missed) return;
    missed = false;
    clearTimeout(timer);
    void run();
  }

  /** Starts polling: the first tick after one interval (the page loads once by itself). */
  function start() {
    if (running) return;
    running = true;
    missed = false;
    document.addEventListener('visibilitychange', onVisibility);
    plan();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  if (getCurrentScope()) onScopeDispose(stop);
  return { start, stop };
}
