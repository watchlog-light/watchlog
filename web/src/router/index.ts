// SPDX-License-Identifier: AGPL-3.0-only
import { takeCheckoutOrigin } from '@/lib/checkout-return';
import type { Component } from 'vue';
import type { Restriction } from '@/api/cloud';
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from 'vue-router';
import { eeNav, eeRoutes } from '@/ee';
import {
  Bell,
  Boxes,
  CalendarClock,
  Database,
  Globe,
  LayoutDashboard,
  Network,
  Radar,
  Router as RouterIcon,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
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
    /** Cloud only (ADR-175): Community sends it to sign-in, or home when signed in. */
    cloud?: boolean;
    /** Cloud: a public page that a signed-in user may open too (an invite, a verify link). */
    anyone?: boolean;
    /** Cloud: the page that lifts this gate; signed-in users without it go home. */
    gate?: Restriction;
    /** A full page outside the app shell that picks no cluster (the onboarding wizard). */
    bare?: boolean;
    /** The org's page, about every cluster and fleet: no `?cluster=` (ADR-226). */
    org?: boolean;
  }
}

export type ClusterKind = 'kubernetes' | 'server';

export interface NavItem {
  name: string;
  path: string;
  titleKey: string;
  icon: Component;
  /** Shown for this kind of cluster only. */
  kind?: ClusterKind;
  /** A Pro feature: Cloud's sidebar marks it with a "Pro" chip. */
  pro?: boolean;
  /**
   * A Pro and Enterprise feature by its licence name (ADR-233): marked "Pro" in every edition
   * where it isn't on (Cloud Free, Community without a key).
   */
  feature?: string;
  /**
   * The sidebar's group (0.13.0, ADR-230): the top (no label), "Running here",
   * "Investigate", and the end after a divider.
   */
  group: NavGroup;
}

export type NavGroup = 'top' | 'running' | 'investigate' | 'end';
export const NAV_GROUPS: NavGroup[] = ['top', 'running', 'investigate', 'end'];

export const NAV_ITEMS: NavItem[] = [
  { name: 'overview', path: '/', titleKey: 'nav.overview', icon: LayoutDashboard, group: 'top' },
  {
    name: 'nodes',
    path: '/nodes',
    titleKey: 'nav.nodes',
    icon: Server,
    kind: 'kubernetes',
    group: 'top',
  },
  // Server fleets (ADR-207): Servers and Workloads replace 0.8's Hosts and Containers.
  {
    name: 'servers',
    path: '/servers',
    titleKey: 'nav.servers',
    icon: Server,
    kind: 'server',
    group: 'top',
  },
  { name: 'workloads', path: '/workloads', titleKey: 'nav.workloads', icon: Boxes, group: 'top' },
  // Running here (0.13.0): services next to the workloads (SPEC §4.12), and the certificates
  // and scheduled jobs found with nothing to set up (ADR-224), each on its own page.
  {
    name: 'applications',
    path: '/applications',
    titleKey: 'nav.applications',
    icon: Database,
    group: 'running',
  },
  {
    name: 'certificates',
    path: '/certificates',
    titleKey: 'nav.certificates',
    icon: ShieldCheck,
    group: 'running',
  },
  {
    name: 'scheduled-jobs',
    path: '/scheduled-jobs',
    titleKey: 'nav.scheduledJobs',
    icon: CalendarClock,
    group: 'running',
  },
  // Network devices (ADR-233): the item is the core's, the pages ee/'s (a teaser without it).
  {
    name: 'network',
    path: '/network',
    titleKey: 'nav.network',
    icon: RouterIcon,
    feature: 'network',
    group: 'running',
  },
  // Investigate.
  {
    name: 'events',
    path: '/events',
    titleKey: 'nav.events',
    icon: ScrollText,
    group: 'investigate',
  },
  // What changed (ADR-199): Pro; Cloud Free and Community see a placeholder (ADR-195).
  {
    name: 'what-changed',
    path: '/what-changed',
    titleKey: 'nav.whatChanged',
    icon: Radar,
    pro: true,
    group: 'investigate',
  },
  {
    name: 'service-map',
    path: '/service-map',
    titleKey: 'nav.serviceMap',
    icon: Network,
    group: 'investigate',
  },
  // Egress watch (ADR-188): external destinations, for both kinds of cluster.
  { name: 'egress', path: '/egress', titleKey: 'nav.egress', icon: Globe, group: 'investigate' },
  { name: 'alerts', path: '/alerts', titleKey: 'nav.alerts', icon: Bell, group: 'end' },
  { name: 'settings', path: '/settings', titleKey: 'nav.settings', icon: Settings, group: 'end' },
];

/**
 * Enterprise modules' sidebar items (ee/web, ADR-232), each in its group after the core's;
 * none when ee/ isn't there. Unlicensed, their page is the core's teaser (EeGate).
 */
export const EE_NAV_ITEMS: NavItem[] = eeNav().map((n) => {
  const route = eeRoutes().find((r) => r.name === n.name);
  return {
    name: n.name,
    path: route?.path ?? `/${n.name}`,
    titleKey: n.titleKey,
    icon: n.icon,
    group: n.group,
  };
});

/** The navigation for the selected cluster's kind. */
export const navFor = (kind: ClusterKind | null | undefined) =>
  [...NAV_ITEMS, ...EE_NAV_ITEMS].filter((i) => !i.kind || i.kind === (kind ?? 'kubernetes'));

/** Applications' old tabs (0.10–0.12) and where they are now (0.13.0). */
export const OLD_APPLICATION_PATHS: [string, string][] = [
  ['applications/certificates', 'certificates'],
  ['applications/certificates/:certId', 'certificate'],
  ['applications/scheduled-jobs', 'scheduled-jobs'],
  ['applications/scheduled-jobs/:jobId', 'scheduled-job'],
];

const RANGED = new Set(['overview', 'nodes', 'workloads', 'events', 'service-map']);

const views: Record<string, () => Promise<Component>> = {
  overview: () => import('@/views/OverviewPage.vue'),
  nodes: () => import('@/views/NodesPage.vue'),
  workloads: () => import('@/views/WorkloadsSwitch.vue'),
  events: () => import('@/views/EventsPage.vue'),
  servers: () => import('@/views/ServersPage.vue'),
  applications: () => import('@/views/ApplicationsPage.vue'),
  certificates: () => import('@/views/CertificatesPage.vue'),
  'scheduled-jobs': () => import('@/views/ScheduledJobsPage.vue'),
  'service-map': () => import('@/views/ServiceMapPage.vue'),
  egress: () => import('@/views/EgressPage.vue'),
  'what-changed': () => import('@/views/WhatChangedPage.vue'),
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
  // Cloud (ADR-175): sign-up, the 2FA step, the verify link and the two gates. The backend's
  // OAuth callback names /signin, /signin/2fa and /settings/security.
  {
    name: 'signup',
    path: '/signup',
    component: () => import('@/views/SignupPage.vue'),
    meta: { titleKey: 'cloud.signup.title', public: true, cloud: true },
  },
  { path: '/signin', redirect: (to) => ({ name: 'login', query: to.query }) },
  {
    name: 'signin-2fa',
    path: '/signin/2fa',
    component: () => import('@/views/TwoFactorPage.vue'),
    meta: { titleKey: 'cloud.mfa.title', public: true, cloud: true },
  },
  {
    name: 'verify-email',
    path: '/verify-email/:token',
    component: () => import('@/views/VerifyEmailPage.vue'),
    meta: { titleKey: 'cloud.verify.title', public: true, anyone: true, cloud: true },
  },
  {
    name: 'verify-required',
    path: '/verify-email',
    component: () => import('@/views/VerifyRequiredPage.vue'),
    meta: { titleKey: 'cloud.gate.verifyTitle', cloud: true, gate: 'email-verification-required' },
  },
  {
    name: 'mfa-required',
    path: '/setup-2fa',
    component: () => import('@/views/MfaRequiredPage.vue'),
    meta: { titleKey: 'cloud.gate.mfaTitle', cloud: true, gate: 'mfa-setup-required' },
  },
  // Cloud onboarding (ADR-176): the wizard after sign-up, and for an org with no cluster.
  {
    name: 'onboarding',
    path: '/onboarding',
    component: () => import('@/views/OnboardingPage.vue'),
    meta: { titleKey: 'onboarding.title', cloud: true, bare: true },
  },
  // The links in invites and password resets (ADR-140): open without a session. In Cloud a
  // signed-in user opens the invite too, to join with one click (ADR-175).
  {
    name: 'accept-invite',
    path: '/invite/:token',
    component: () => import('@/views/AcceptInvitePage.vue'),
    meta: { titleKey: 'invite.title', public: true, anyone: true },
  },
  {
    name: 'reset-password',
    path: '/reset/:token',
    component: () => import('@/views/ResetPasswordPage.vue'),
    meta: { titleKey: 'reset.title', public: true },
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
      // Enterprise modules' pages (ee/web, ADR-232), behind their licence feature.
      ...eeRoutes(),
      // Without ee/ (or its network pages) /network and below are the core's teaser.
      ...(eeRoutes().some((r) => r.name === 'network')
        ? []
        : [
            {
              name: 'network',
              path: 'network/:rest(.*)*',
              component: () => import('@/views/NetworkTeaserPage.vue'),
              meta: { titleKey: 'nav.network' },
            },
          ]),
      ...NAV_ITEMS.filter((item) => item.name !== 'network').map((item) => ({
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
      // All clusters and fleets (ADR-226): Pro; Cloud Free and Community see the upgrade card.
      {
        name: 'all-clusters',
        path: 'all',
        component: () => import('@/views/AllClustersPage.vue'),
        meta: { titleKey: 'nav.allClusters', org: true },
      },
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
        name: 'server',
        path: 'servers/:server',
        component: () => import('@/views/ServerPage.vue'),
        meta: { titleKey: 'nav.servers', charts: true, kind: 'server' },
      },
      {
        name: 'server-workload',
        path: 'servers/:server/workloads/:workload',
        component: () => import('@/views/ServerWorkloadPage.vue'),
        // Its charts follow the top bar's time range (the pod and container pages' picker).
        meta: { titleKey: 'nav.servers', charts: true, kind: 'server' },
      },
      // The containers with their Compose projects (0.8's Containers page), from Workloads.
      {
        name: 'containers',
        path: 'containers',
        component: () => import('@/views/ContainersPage.vue'),
        meta: { titleKey: 'nav.containers', charts: true, kind: 'server' },
      },
      // 0.8's Hosts pages: old links and bookmarks.
      { name: 'hosts', path: 'hosts', redirect: (to) => ({ name: 'servers', query: to.query }) },
      {
        name: 'docker-host',
        path: 'hosts/:host',
        redirect: (to) => ({ name: 'server', params: { server: to.params.host }, query: to.query }),
      },
      {
        name: 'docker-container',
        path: 'containers/:host/:name',
        component: () => import('@/views/DockerContainerPage.vue'),
        meta: { titleKey: 'nav.containers', charts: true, kind: 'server' },
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
      // A certificate's and a job's page (0.13.0, their own pages since; ADR-230).
      {
        name: 'certificate',
        path: 'certificates/:certId',
        component: () => import('@/views/CertificatePage.vue'),
        meta: { titleKey: 'nav.certificates' },
      },
      {
        name: 'scheduled-job',
        path: 'scheduled-jobs/:jobId',
        component: () => import('@/views/ScheduledJobPage.vue'),
        meta: { titleKey: 'nav.scheduledJobs' },
      },
      // The 0.10–0.12 addresses under Applications: links in emails, alerts and bookmarks keep
      // working, with their query (the cluster, the filter). Static paths, so they win over
      // applications/:id.
      ...OLD_APPLICATION_PATHS.map(([from, name]) => ({
        path: from,
        redirect: (to: {
          params: Record<string, unknown>;
          query: Record<string, unknown>;
          hash: string;
        }) => ({ name, params: to.params, query: to.query, hash: to.hash }) as never,
      })),
      // A monitored service (SPEC §4.12); it has its own time range (ADR-135).
      {
        name: 'application',
        path: 'applications/:id',
        component: () => import('@/views/ApplicationPage.vue'),
        meta: { titleKey: 'nav.applications' },
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
      // Cloud: the OAuth callback's way back after linking GitHub or Google (ADR-175).
      {
        path: 'settings/security',
        redirect: (to) => ({ name: 'settings', query: { ...to.query, tab: 'security' } }),
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
  /** Cloud (ADR-175); absent or false in Community. */
  readonly isCloud?: boolean;
  /** Cloud: the gate the account must pass first. */
  readonly restriction?: Restriction | null;
  ensureLoaded(): Promise<void>;
}

/** The page that lifts each Cloud gate. */
export const GATE_ROUTE: Record<Restriction, string> = {
  'mfa-setup-required': 'mfa-required',
  'email-verification-required': 'verify-required',
};

/**
 * Sends visitors to first-run setup while it is required, to sign-in when they
 * have no session, and away from sign-in/setup once they are signed in. Cloud: its pages
 * exist only there, and a gated account sees only the page that lifts the gate.
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
    if (to.meta.cloud && !state.isCloud) return state.user ? { path: '/' } : { name: 'login' };
    if (to.name === 'setup') return state.user ? { path: '/' } : { name: 'login' };
    if (to.meta.public) {
      return state.user && !(to.meta.anyone && state.isCloud) ? { path: '/' } : true;
    }
    if (!state.user) {
      return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    }
    if (state.restriction) {
      const gate = GATE_ROUTE[state.restriction];
      return to.name === gate ? true : { name: gate };
    }
    if (to.meta.gate) return { path: '/' };
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
    if (to.meta.public || to.meta.gate || to.meta.bare || to.name === 'not-found') return true;
    const c = clusters();
    try {
      await c.ensure();
    } catch {
      return true; // The pages show their own load errors.
    }
    const asked = typeof to.query.cluster === 'string' ? to.query.cluster : null;
    if (asked && asked !== c.selectedId) c.select(asked);
    const id = c.selectedId;
    if (!id || to.meta.org) return true;
    if (to.meta.kind && c.selected && to.meta.kind !== c.selected.kind)
      return { name: 'overview', query: { cluster: id }, replace: true };
    if (to.query.cluster !== id)
      return { ...to, query: { ...to.query, cluster: id }, replace: true };
    return true;
  });
}

/**
 * Stripe Checkout returns to Settings › Plan & billing. When it was started on What changed's
 * upgrade page, the browser goes back there, where the page turns into the learning page as
 * soon as Pro is on (ADR-216). A Checkout started on Plan & billing stays there.
 */
export function installCheckoutReturn(router: Router): void {
  router.beforeEach((to) => {
    const c = to.query.checkout;
    if (to.name !== 'settings' || (c !== 'done' && c !== 'cancelled')) return true;
    const from = takeCheckoutOrigin();
    if (!from) return true;
    return {
      name: 'what-changed',
      query: { cluster: from.cluster, checkout: c },
      replace: true,
    };
  });
}

/** What the landing rule needs to know (ADR-226); implemented with the clusters' store. */
export interface LandingState {
  /** Whether "All clusters and fleets" exists here at all: Cloud or the demo. */
  readonly offered: boolean;
  /** The org's summary, or null without the page (Free) or on an error. */
  summary(): Promise<{ counts: { all: number } } | null>;
}

/** Public pages a sign-in comes from: arriving from one of them is landing. */
const SIGN_IN_PAGES = new Set(['login', 'signup', 'demo', 'signin-2fa', 'setup', 'verify-email']);

/**
 * Pro orgs with two or more clusters and fleets land on All clusters and fleets (ADR-226):
 * after signing in, or opening the app at its root, never when a link or the sidebar opens
 * Overview inside the app.
 */
export function installLandingRule(router: Router, landing: () => LandingState): void {
  router.beforeEach(async (to, from) => {
    if (to.name !== 'overview' || to.query.cluster) return true;
    const arriving = !from.name || SIGN_IN_PAGES.has(String(from.name));
    if (!arriving) return true;
    const l = landing();
    if (!l.offered) return true;
    const s = await l.summary().catch(() => null);
    return s && s.counts.all >= 2 ? { name: 'all-clusters', replace: true } : true;
  });
}

export function createAppRouter(
  auth: () => AuthState,
  clusters: () => ClusterState,
  landing?: () => LandingState,
): Router {
  const router = createRouter({ history: createWebHistory(), routes });
  installAuthGuard(router, auth);
  installCheckoutReturn(router);
  if (landing) installLandingRule(router, landing);
  installClusterGuard(router, clusters);
  return router;
}
