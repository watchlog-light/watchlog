// SPDX-License-Identifier: AGPL-3.0-only
// Links to the documentation (docs/site in the repository).
const DOCS = 'https://github.com/watchlog-light/watchlog/blob/main/docs/site';

export const LINKS = {
  /** The documentation's home on the site (the account menu's Documentation, 0.10.1). */
  docs: 'https://watchlog.io/docs/',
  /** The install guide on the site (the read-only demo's call to action, ADR-122). */
  install: 'https://watchlog.io/docs/install/',
  /** Connecting Claude Code, Claude Desktop and Cursor (docs/site/mcp.md, v0.2). */
  mcp: 'https://watchlog.io/docs/mcp/',
  /** Right-sizing hints (docs/site/right-sizing.md, v0.5, ADR-168). */
  rightSizing: 'https://watchlog.io/docs/right-sizing/',
  /** Probable cause and its rules (docs/site/probable-cause.md, v0.4). */
  probableCause: 'https://watchlog.io/docs/probable-cause/#the-rules',
  /** Cloud's Terms and Privacy policy on the site (Cloud slice 8 writes them, ADR-175). */
  terms: 'https://watchlog.io/terms',
  privacy: 'https://watchlog.io/privacy',
  /** The Cloud waitlist on the site, while Cloud opens in invite waves (ADR-173). */
  waitlist: 'https://watchlog.io/pricing/#cloud',
  /** WatchLog Cloud's sign-up: Community's "Try WatchLog Cloud" on the upgrade page (ADR-201). */
  cloudSignup: 'https://cloud.watchlog.io/signup',
  /** How certificates and scheduled jobs are found (docs/site/certificates-and-jobs.md, 0.13.0). */
  certsHow: 'https://watchlog.io/docs/certificates-and-jobs/#certificates',
  jobsHow: 'https://watchlog.io/docs/certificates-and-jobs/#scheduled-jobs',
  /** "Your first metric in two minutes" (docs/site/your-metrics.md, 1.0.3). */
  firstMetric: 'https://watchlog.io/docs/your-metrics/#your-first-metric-in-two-minutes',
  /** Updating a poller's collector on a server and in a cluster (docs/site/network.md, 1.0.4). */
  collectorUpdate: 'https://watchlog.io/docs/network/#updating-the-collector',
  kubeletTls: `${DOCS}/faq.md#nodes-say-the-kubelet-certificate-is-not-verified-how-do-i-fix-it`,
} as const;
