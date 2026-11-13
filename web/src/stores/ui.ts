// SPDX-License-Identifier: AGPL-3.0-only
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export const TIME_RANGES = ['15m', '1h', '6h', '24h', '7d'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
/** The read-only demo answers at most the last 24 hours (ADR-122). */
export const DEMO_TIME_RANGES = TIME_RANGES.filter((r) => r !== '7d');

const SIDEBAR_KEY = 'watchlog.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Shell UI state. Time range and namespace are placeholders until Phase 1/2. */
export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(readCollapsed());
  const timeRange = ref<TimeRange>('1h');
  /** Below 1024 px the navigation is a drawer: whether it is open. */
  const navOpen = ref(false);
  /** The ⌘K command palette (ADR-169) is open. */
  const paletteOpen = ref(false);

  watch(sidebarCollapsed, (value) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(value));
    } catch {
      // Storage can be unavailable (private mode); the preference is optional.
    }
  });

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  return { sidebarCollapsed, timeRange, navOpen, paletteOpen, toggleSidebar };
});
