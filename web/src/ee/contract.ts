// SPDX-License-Identifier: AGPL-3.0-only
// What an Enterprise web module (ee/web/<module>/index.ts, ADR-232) gives the dashboard: its
// routes and its sidebar items, under the licence feature that turns it on. The core loads
// them with import.meta.glob (src/ee/index.ts), which yields nothing when ee/ is deleted.
import type { Component } from 'vue';
import type { RouteRecordRaw } from 'vue-router';

export interface EeNavItem {
  /** The route's name. */
  name: string;
  titleKey: string;
  icon: Component;
  /** The sidebar group it joins (ADR-230). */
  group: 'running' | 'investigate';
}

export interface EeWebModule {
  name: string;
  /** The licence feature that turns it on: "network". */
  feature: string;
  routes: RouteRecordRaw[];
  nav?: EeNavItem[];
}
