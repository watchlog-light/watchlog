// SPDX-License-Identifier: AGPL-3.0-only
// The marketing site's one configuration file (deploy/site/DEPLOY.md). At launch, set
// `repoPublic: true` and deploy again.

/** A build-time flag; the environment variable only exists to test a launch build. */
const flag = (name: string, value: boolean): boolean => {
  const env = typeof process === 'undefined' ? undefined : process.env[name];
  return env === undefined ? value : env === 'true';
};

export const site = {
  /** Canonical origin: links, the sitemap and Open Graph tags use it. */
  url: 'https://watchlog.io',
  repoUrl: 'https://github.com/watchlog-light/watchlog',
  version: '0.1.0',
  /**
   * While false the site has no GitHub or star buttons and no install commands, only
   * "Open-source release coming soon", and links nothing in the (private) repository.
   */
  repoPublic: flag('WATCHLOG_SITE_REPO_PUBLIC', false),
  /** The Cloud waitlist form; rendered disabled while false. */
  cloudWaitlist: flag('WATCHLOG_SITE_CLOUD_WAITLIST', true),
  /** Where the waitlist form posts: the waitlist service behind nginx, same origin. */
  waitlistAction: '/api/waitlist' as string,
  /** Named on the legal pages. Replace with the legal entity (launch.md 1.4). */
  operator: 'WatchLog',
  /** The address the legal pages give for privacy and legal questions (launch.md 1.5). */
  contactEmail: 'hello@watchlog.io',
  /** Shown on the legal pages; change it whenever their text changes. */
  legalUpdated: '2026-11-05',
} as const;

export const siteMeta = {
  name: 'WatchLog',
  title: 'WatchLog — open-source monitoring for Kubernetes and Docker',
  description:
    'Install one agent and see every node, pod, container and the network between them in under five minutes. Open source (AGPL-3.0).',
  headline: 'See everything in your Kubernetes cluster',
  headlineAccent: 'in 5 minutes.',
  subheadline:
    'Open-source monitoring with one agent. Nodes, pods, containers and the network between your services. No PromQL, no dashboards to build. Docker hosts work too.',
} as const;

/** The repository's base URL, or null while it is private: nothing may link to it. */
export const repoLink = (path = ''): string | null =>
  site.repoPublic ? `${site.repoUrl}${path}` : null;

/** The pages under /docs, in order (docs/site/<slug>.md); security.md is /security. */
export const DOC_PAGES = ['install', 'configuration', 'faq'] as const;

/**
 * Every page, for the sitemap and the output checks. Page URLs end in a slash: each is
 * <path>/index.html, and nginx redirects the bare path to it.
 */
export const PAGES = [
  '/',
  '/docs/',
  ...DOC_PAGES.map((s) => `/docs/${s}/`),
  '/security/',
  '/legal/privacy/',
  '/legal/terms/',
] as const;

/** Pages the waitlist service redirects to (not in the sitemap). */
export const WAITLIST_PAGES = [
  'check-inbox',
  'confirmed',
  'link-expired',
  'unsubscribed',
  'error',
] as const;
