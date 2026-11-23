// SPDX-License-Identifier: AGPL-3.0-only
// The notices (ADR-220): an API token about to expire, a plan limit reached, a support
// session opened, an org's deletion and inactivity, What changed ready, and the self-hosted
// "Send test email". Transactional: no unsubscribe; each footer says why it came and where
// to change it. Prices and limits come from the plan config, never typed here.
import type { EmailSpec } from '../../lib/mail.js';
import { PLAN_DEFAULTS, type CloudPlan } from '../entitlements/plans.js';
import { proPriceLine } from '../lifecycle/texts.js';
import { at, day, hhmm, when } from './format.js';

export function tokenExpiryEmail(t: {
  tokenName: string;
  prefix: string;
  expiresAt: Date;
  site?: string | null;
}): EmailSpec {
  const date = day(t.expiresAt);
  const url = at(t.site, '/settings?tab=tokens');
  return {
    kind: 'info',
    subject: `Your WatchLog API token “${t.tokenName}” expires on ${date}`,
    preheader: 'Make a new one before then, or what uses it stops reading from WatchLog.',
    title: `Your API token “${t.tokenName}” expires on ${date}`,
    intro: [
      'After that, the scripts and AI assistants that use it can no longer read from WatchLog.',
    ],
    facts: [
      { label: 'Token', value: t.tokenName },
      { label: 'Starts with', value: `${t.prefix}…` },
      { label: 'Expires', value: when(t.expiresAt) },
    ],
    list: {
      ordered: true,
      items: [
        'Make a new token in Settings › API tokens.',
        'Put it where this one is used.',
        'Revoke this one.',
      ],
    },
    button: url ? { label: 'Open API tokens', url } : null,
    note: ['This is the only reminder for this token.'],
    footer: {
      why: 'You got this because this API token is yours.',
      manage: 'Your tokens are in Settings › API tokens.',
    },
  };
}

export type LimitKind = 'nodes' | 'clusters' | 'users';

export function limitEmail(m: {
  kind: LimitKind;
  count: number;
  limit: number | null;
  plan: CloudPlan;
  orgName: string;
  site?: string | null;
}): EmailSpec {
  const plan = m.plan === 'free' ? 'Cloud Free' : m.plan === 'pro' ? 'Cloud Pro' : 'your plan';
  const free = PLAN_DEFAULTS.free;
  const limit =
    m.limit ??
    (m.kind === 'nodes' ? free.nodes : m.kind === 'clusters' ? free.clusters : free.users);
  const noun = m.kind === 'nodes' ? 'node' : m.kind === 'clusters' ? 'cluster' : 'user';
  const title =
    m.kind === 'nodes'
      ? `${m.orgName} is over its node limit`
      : m.kind === 'clusters'
        ? `${m.orgName} reached its cluster limit`
        : `${m.orgName} reached its user limit`;
  const what =
    m.kind === 'nodes'
      ? `${m.count === 1 ? 'A new node' : `${m.count} new nodes`} tried to send data to ${m.orgName} today, but ${plan} allows ${limit} nodes. Their data is not stored; the nodes that were already sending keep sending.`
      : m.kind === 'clusters'
        ? `Someone in ${m.orgName} tried to add a cluster or server fleet today, but ${plan} allows ${limit}.`
        : `Someone in ${m.orgName} tried to invite a teammate today, but ${plan} allows ${limit} ${limit === 1 ? 'user' : 'users'}.`;
  const url = at(m.site, '/settings?tab=billing');
  return {
    kind: 'billing',
    subject: title,
    preheader:
      m.plan === 'free'
        ? `Pro lifts the ${noun} limit. ${proPriceLine()}`
        : 'Your plan and its limits.',
    header: m.orgName,
    badge: 'Plan limit',
    title,
    intro: [what],
    facts: [
      { label: 'Plan', value: plan },
      { label: 'Limit', value: `${limit} ${noun}${limit === 1 ? '' : 's'}` },
    ],
    after: m.plan === 'free' ? [`Pro lifts the limit. It is ${proPriceLine()}`] : [],
    button: url ? { label: m.plan === 'free' ? 'See Pro' : 'See your plan', url } : null,
    note: ['You get at most one email like this per limit and day.'],
    footer: { why: `You got this because you are an Owner of ${m.orgName}.` },
  };
}

export function supportStartedEmail(p: {
  orgName: string;
  staffEmail: string;
  reason: string;
  expiresAt: Date;
  site?: string | null;
}): EmailSpec {
  const url = at(p.site, '/settings?tab=security');
  return {
    kind: 'info',
    subject: `WatchLog staff opened a support session in ${p.orgName}`,
    preheader: `Read-only, until ${hhmm(p.expiresAt)} at the latest.`,
    header: p.orgName,
    badge: 'Support session',
    title: 'WatchLog staff opened a support session',
    intro: [
      `${p.staffEmail} at WatchLog opened a read-only support session in ${p.orgName}. Nothing can be changed in it, and it lasts at most an hour.`,
    ],
    facts: [
      { label: 'Who', value: p.staffEmail },
      { label: 'Why', value: p.reason },
      { label: 'Until', value: `${when(p.expiresAt)} at the latest` },
    ],
    button: url ? { label: 'See every session', url } : null,
    note: ['Didn’t expect this? Reply to this email.'],
    footer: {
      why: `You got this because you are an Owner of ${p.orgName}.`,
      manage: 'Settings › Security lists every support session and what it opened.',
    },
  };
}

export const dataNotices = {
  deletionRequested: (org: string, due: Date, by: string, site: string): EmailSpec => ({
    kind: 'warning',
    subject: `${org} will be deleted on ${day(due)}`,
    preheader: 'An Owner can undo it until then. Download what you want to keep.',
    header: org,
    badge: 'Deletion scheduled',
    title: `${org} will be deleted on ${day(due)}`,
    intro: [
      `${by} asked to delete the WatchLog organization ${org}. Its agents’ data is no longer stored.`,
      `On ${day(due)} its clusters, alert rules, channels, members and metrics are deleted for good. An Owner can undo it until then.`,
    ],
    button: { label: 'Undo, or download your data', url: at(site, '/settings?tab=data')! },
    note: ['Download what you want to keep before that day.'],
    footer: { why: `You got this because you are an Owner of ${org}.` },
  }),
  inactiveWarning: (org: string, suspendsAt: Date, site: string): EmailSpec => ({
    kind: 'warning',
    subject: `${org} has sent no data for 30 days`,
    preheader: `It will be suspended on ${day(suspendsAt)} unless an agent sends data.`,
    header: org,
    title: `${org} has sent no data for 30 days`,
    intro: [
      `No agent has sent data to the WatchLog organization ${org} for 30 days.`,
      `On ${day(suspendsAt)} it will be suspended: agents’ data won’t be stored. Your data and settings stay, and you can still sign in, export them or delete the organization.`,
    ],
    button: { label: 'Open WatchLog', url: at(site, '/')! },
    note: [
      'To keep it active, start an agent before then. If you don’t need it any more, you can delete it in Settings › Data.',
    ],
    footer: { why: `You got this because you are an Owner of ${org}.` },
  }),
  inactiveSuspended: (org: string, site: string): EmailSpec => ({
    kind: 'warning',
    subject: `${org} is suspended after 37 days without data`,
    preheader: 'Your data stays. You can still sign in.',
    header: org,
    badge: 'Suspended',
    title: `${org} is suspended`,
    intro: [
      `The WatchLog organization ${org} received no data for 37 days, so it is suspended: agents’ data isn’t stored.`,
      'You can still sign in. An Owner can reactivate it, export its data or delete it.',
    ],
    button: { label: 'Open Settings › Data', url: at(site, '/settings?tab=data')! },
    footer: { why: `You got this because you are an Owner of ${org}.` },
  }),
};

/**
 * "What changed is ready" (ADR-216): the one email a member asked for on the learning page,
 * for one cluster or fleet. Sent once; the cluster's name is the user's own data.
 */
export function whatChangedReadyEmail(c: {
  site: string;
  cluster: { id: string; name: string; kind: string };
  /** Who signs it: the lifecycle sender's name (it comes from that address). */
  signature?: string;
}): EmailSpec {
  const later =
    c.cluster.kind === 'server'
      ? 'A server, service or container that joins later takes 7 days of its own.'
      : 'A workload or node that joins later takes 7 days of its own.';
  return {
    kind: 'info',
    subject: `What changed is ready for ${c.cluster.name}`,
    preheader: 'WatchLog has learned its usual week. Unusual hours now show, and can alert.',
    header: c.cluster.name,
    title: `What changed is ready for ${c.cluster.name}`,
    intro: [
      `WatchLog has finished learning the usual week of ${c.cluster.name}. What changed now lists whatever leaves its usual range for the hour, in the order it happened, with the probable cause underneath, and “Unusual for this hour” alerts can fire.`,
      `It keeps learning every week. ${later}`,
    ],
    button: {
      label: 'Open What changed',
      url: at(c.site, `/what-changed?cluster=${encodeURIComponent(c.cluster.id)}`)!,
    },
    signature: c.signature ?? null,
    footer: {
      why: 'You got this because you asked for it on the What changed page. It is sent once.',
    },
  };
}

/** Settings › Alert channels › Email, "Send test email" (self-hosted). */
export function settingsTestEmail(): EmailSpec {
  return {
    kind: 'info',
    subject: 'WatchLog test email',
    preheader: 'Your email server works. Alerts and invites will be sent this way.',
    title: 'Email works',
    intro: [
      'This is a test from WatchLog. Alert emails, invites and password resets will be sent this way.',
    ],
    footer: {
      why: 'You got this because someone pressed “Send test email” in Settings › Alert channels.',
    },
  };
}

/** A self-hosted Enterprise licence ends in 30 days or fewer (ADR-232): one email per key. */
export function licenseExpiringEmail(l: {
  customer: string;
  expiresAt: Date;
  graceEndsAt: Date;
  units: number;
  site?: string | null;
}): EmailSpec {
  const date = day(l.expiresAt);
  const url = at(l.site, '/settings?tab=license');
  return {
    kind: 'info',
    subject: `Your WatchLog licence ends on ${date}`,
    preheader: 'Ask us for a new key before then; nothing is deleted either way.',
    title: `Your WatchLog Enterprise licence ends on ${date}`,
    intro: [
      `The licence for ${l.customer} ends on ${date}. Licensed features keep working for 14 more days, until ${day(l.graceEndsAt)}, then turn off.`,
      'Monitoring, alerts and everything in Community keep working, and nothing is deleted: a new key turns the licensed features back on with their data.',
    ],
    facts: [
      { label: 'Licensed to', value: l.customer },
      { label: 'Ends', value: when(l.expiresAt) },
      { label: 'Features stop', value: when(l.graceEndsAt) },
      { label: 'Units', value: String(l.units) },
    ],
    list: {
      ordered: true,
      items: [
        'Write to us for a new key (reply to your licence email, or use the contact page).',
        'Paste it in Settings › License, or set WATCHLOG_LICENSE where WatchLog runs.',
      ],
    },
    button: url ? { label: 'Open Settings › License', url } : null,
    note: ['This is the only reminder for this key.'],
    footer: {
      why: 'You got this because you are an Owner of this WatchLog installation.',
      manage: 'The licence is in Settings › License.',
    },
  };
}
