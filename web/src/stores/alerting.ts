// SPDX-License-Identifier: AGPL-3.0-only
// Whether alerting runs (ADR-088), polled for the banner shown on every page.
import type { AlertingStatus } from '@watchlog/api-types';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';

const POLL_MS = 30_000;

export const useAlertingStore = defineStore('alerting', () => {
  const status = ref<AlertingStatus | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let users = 0;

  async function load() {
    try {
      status.value = await api<AlertingStatus>('/alerting/status');
    } catch {
      // Keep the last answer: a failed poll says nothing about the worker.
    }
  }

  /** Starts polling while at least one component watches; returns the stop function. */
  function watch(): () => void {
    users++;
    if (users === 1) {
      void load();
      timer = setInterval(load, POLL_MS);
    }
    return () => {
      users--;
      if (users === 0) clearInterval(timer);
    };
  }

  return { status, load, watch };
});
