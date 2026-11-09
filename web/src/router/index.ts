// SPDX-License-Identifier: AGPL-3.0-only
import type { Component } from 'vue';
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from 'vue-router';
import {
  Bell,
  Boxes,
  Container,
  Database,
  LayoutDashboard,
  Network,
  ScrollText,
  Server,
  Settings,
} from '@lucide/vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** i18n key of the page title. */
    titleKey?: string;
    /** Reachable without a session (sign-in and first-run setup). */
    public?: boolean;
    /** The page draws time-series charts: the top bar shows the time-range picker. */
    charts?: boolean;
    /** The page exists for this kind of cluster only; the other kind goes to Overview. */
    kind?: ClusterKind;
  }
}

export type ClusterKind = 'kubernetes' | 'docker';

export interface NavItem {
  name: string;
  path: string;
  titleKey: string;
  icon: Component;
  /** Shown for this kind of cluster only. */
  kind?: ClusterKind;
}

export const NAV_ITEMS: NavItem[] = [
  { name: 'overview', path: '/', titleKey: 'nav.overview', icon: LayoutDashboard },
  { name: 'nodes', path: '/nodes', titleKey: 'nav.nodes', icon: Server, kind: 'kubernetes' },
  { name: 'hosts', path: '/hosts', titleKey: 'nav.hosts', icon: Server, kind: 'docker' },
  {
    name: 'workloads',
    path: '/workloads',
    titleKey: 'nav.workloads',
    icon: Boxes,
    kind: 'kubernetes',
  },
  {
    name: 'containers',
    path: '/containers',
    titleKey: 'nav.containers',
    icon: Container,
    kind: 'docker',
  },
  // Services next to the workloads (SPEC §4.12), for both kinds of cluster.
  {
    name: 'applications',
    path: '/applications',
    titleKey: 'nav.applications',
    icon: Database,
  },
  { name: 'events', path: '/events', titleKey: 'nav.events', icon: ScrollText },
  { name: 'service-map', path: '/service-map', titleKey: 'nav.serviceMap', icon: Network },
  { name: 'alerts', path: '/alerts', titleKey: 'nav.alerts', icon: Bell },
  { name: 'settings', path: '/settings', titleKey: 'nav.settings', icon: Settings },
];

/** The navigation for the selected cluster's kind. */
export const navFor = (kind: ClusterKind | null | undefined) =>
  NAV_ITEMS.filter((i) => !i.kind || i.kind === (kind ?? 'kubernetes'));

const RANGED = new Set([
  'overview',
  'nodes',
  'hosts',
  'workloads',
  'containers',
  'events',
  'service-map',
]);

const views: Record<string, () => Promise<Component>> = {
  overview: () => import('@/views/OverviewPage.vue'),
  nodes: () => import('@/views/NodesPage.vue'),
  workloads: () => import('@/views/WorkloadsPage.vue'),
  events: () => import('@/views/EventsPage.vue'),
  hosts: () => import('@/views/HostsPage.vue'),
  containers: () => import('@/views/ContainersPage.vue'),
  applications: () => import('@/views/ApplicationsPage.vue'),
  'service-map': () => import('@/views/ServiceMapPage.vue'),
  alerts: () => import('@/views/AlertsPage.vue'),
  settings: () => import('@/views/SettingsPage.vue'),
};

export const routes: RouteRecordRaw[] = [
  {
    name: 'setup',
    path: '/setup',
    component: () => import('@/views/SetupPage.vue'),
    meta: { titleKey: 'auth.setup.title', public: true },
  },
  {
    name: 'login',
    path: '/login',
    component: () => import('@/views/LoginPage.vue'),
    meta: { titleKey: 'auth.login.title', public: true },
  },
  // Read-only demo (ADR-122): opens a demo session at once (the sign-in page has a button).
  {
    name: 'demo',
    path: '/demo',
    component: () => import('@/views/LoginPage.vue'),
    meta: { titleKey: 'auth.demo.title', public: true },
  },
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      ...NAV_ITEMS.map((item) => ({
        name: item.name,
        path: item.path.slice(1),
        component: views[item.name]!,
        // Pages that draw series over a range show the time-range picker.
        meta: {
          titleKey: item.titleKey,
          ...(RANGED.has(item.name) ? { charts: true } : {}),
          ...(item.kind ? { kind: item.kind } : {}),
        },
      })),
      {
        name: 'node',
        path: 'nodes/:name',
        component: () => import('@/views/NodeDetailPage.vue'),
        meta: { titleKey: 'nav.nodes', charts: true, kind: 'kubernetes' },
      },
      {
        name: 'pod',
        path: 'pods/:namespace/:name',
        component: () => import('@/views/PodDetailPage.vue'),
        meta: { titleKey: 'nav.workloads', charts: true, kind: 'kubernetes' },
      },
      {
        name: 'docker-host',
        path: 'hosts/:host',
        component: () => import('@/views/DockerHostPage.vue'),
        meta: { titleKey: 'nav.hosts', charts: true, kind: 'docker' },
      },
      {
        name: 'docker-container',
        path: 'containers/:host/:name',
        component: () => import('@/views/DockerContainerPage.vue'),
        meta: { titleKey: 'nav.containers', charts: true, kind: 'docker' },
      },
      // The standalone Docker page before the Hosts and Containers pages: old links.
      {
        name: 'docker',
        path: 'docker',
        redirect: (to) => ({ name: 'containers', query: to.query }),
      },
      {
        path: 'docker/hosts/:host',
        redirect: (to) => ({ name: 'docker-host', params: to.params, query: to.query }),
      },
      {
        path: 'docker/hosts/:host/containers/:name',
        redirect: (to) => ({ name: 'docker-container', params: to.params, query: to.query }),
      },
      {
        name: 'alert',
        path: 'alerts/:id',
        component: () => import('@/views/AlertDetailPage.vue'),
        meta: { titleKey: 'nav.alerts', charts: true },
      },
      {
        name: 'cluster-settings',
        path: 'settings/clusters/:id',
        component: () => import('@/views/ClusterSettingsPage.vue'),
        meta: { titleKey: 'clusters.detailTitle' },
      },
      {
        name: 'api-token',
        path: 'settings/api-tokens/:id',
        component: () => import('@/views/ApiTokenPage.vue'),
        meta: { titleKey: 'apiTokens.detailTitle' },
      },
      {
        name: 'not-found',
        path: ':pathMatch(.*)*',
        component: () => import('@/views/NotFoundPage.vue'),
        meta: { titleKey: 'empty.notFound.title' },
      },
    ],
  },
];

/** Signed-in state the guard needs; implemented by the auth store. */
export interface AuthState {
  readonly user: unknown;
  readonly setupRequired: boolean;
  ensureLoaded(): Promise<void>;
}

/**
 * Sends visitors to first-run setup while it is required, to sign-in when they
 * have no session, and away from sign-in/setup once they are signed in.
 */
export function installAuthGuard(router: Router, auth: () => AuthState): void {
  router.beforeEach(async (to) => {
    const state = auth();
    try {
      await state.ensureLoaded();
    } catch {
      // Backend unreachable: let the sign-in page show the error.
      return to.name === 'login' ? true : { name: 'login', query: { redirect: to.fullPath } };
    }
    if (state.setupRequired) return to.name === 'setup' ? true : { name: 'setup' };
    if (to.name === 'setup') return state.user ? { path: '/' } : { name: 'login' };
    if (to.meta.public) return state.user ? { path: '/' } : true;
    if (!state.user) {
      return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    }
    return true;
  });
}

/** The selected cluster as the cluster guard needs it; implemented by the clusters store. */
export interface ClusterState {
  readonly selectedId: string | null;
  readonly selected: { kind: string } | null;
  ensure(): Promise<unknown>;
  select(id: string): boolean;
}

/**
 * Keeps one selected cluster across every page (it never changes by itself): a link's
 * `?cluster=` selects that cluster; a URL without it gets the current one; a page of
 * the other kind (Nodes for a Docker fleet, Hosts for a Kubernetes cluster) goes to
 * Overview.
 */
export function installClusterGuard(router: Router, clusters: () => ClusterState): void {
  router.beforeEach(async (to) => {
    if (to.meta.public || to.name === 'not-found') return true;
    const c = clusters();
    try {
      await c.ensure();
    } catch {
      return true; // The pages show their own load errors.
    }
    const asked = typeof to.query.cluster === 'string' ? to.query.cluster : null;
    if (asked && asked !== c.selectedId) c.select(asked);
    const id = c.selectedId;
    if (!id) return true;
    if (to.meta.kind && c.selected && to.meta.kind !== c.selected.kind)
      return { name: 'overview', query: { cluster: id }, replace: true };
    if (to.query.cluster !== id)
      return { ...to, query: { ...to.query, cluster: id }, replace: true };
    return true;
  });
}

export function createAppRouter(auth: () => AuthState, clusters: () => ClusterState): Router {
  const router = createRouter({ history: createWebHistory(), routes });
  installAuthGuard(router, auth);
  installClusterGuard(router, clusters);
  return router;
}
