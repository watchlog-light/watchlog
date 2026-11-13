// SPDX-License-Identifier: AGPL-3.0-only
// Links to the documentation (docs/site in the repository).
const DOCS = 'https://github.com/watchlog-light/watchlog/blob/main/docs/site';

export const LINKS = {
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
  kubeletTls: `${DOCS}/faq.md#nodes-say-the-kubelet-certificate-is-not-verified-how-do-i-fix-it`,
} as const;
