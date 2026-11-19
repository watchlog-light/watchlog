// SPDX-License-Identifier: AGPL-3.0-only
// The lifecycle emails (ADR-179, SPEC §10.4; drawn with the shared template since ADR-220):
// from the founder, short, and every claim true of the product as it ships (the default
// rules, the likely cause, the service map, MCP, the install page's checks after 2 minutes,
// the Free limits). Each carries its unsubscribe link and List-Unsubscribe; the beta notice
// is a service notice without them. Pro's price comes from the plans config (ADR-215).
import type { EmailSpec } from '../../lib/mail.js';
import { day } from '../emails/format.js';
import { PRO_PRICE } from '../entitlements/plans.js';

const usd = (n: number) =>
  new Intl.NumberFormat('en', {
    style: 'currency',
    currency: PRO_PRICE.currency,
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
/** "$3 per node (or server) a month, $15 minimum (the first 5 nodes); or $30 per node a year." */
export const proPriceLine = (): string =>
  `${usd(PRO_PRICE.perNodeMonth)} per node (or server) a month, ${usd(PRO_PRICE.minimumMonth)} minimum (the first ${Math.ceil(PRO_PRICE.minimumMonth / PRO_PRICE.perNodeMonth)} nodes); or ${usd(PRO_PRICE.annualPerNode)} per node a year.`;

export type LifecycleKind =
  'welcome' | 'no_data' | 'first_alert' | 'day3_tips' | 'near_limit' | 'beta_notice';

export interface LifecycleContext {
  /** The dashboard's address, without a trailing slash. */
  site: string;
  orgName: string;
  /** The first name or the address's local part. */
  name: string;
  /** Who signs it: the founder's name from WATCHLOG_LIFECYCLE_FROM, or "WatchLog". */
  signature: string;
  /** The one-click unsubscribe link (absent on the beta notice). */
  unsubscribeUrl?: string;
  /** no_data: the org's first cluster, if one was made (the install page's checks). */
  clusterId?: string | null;
  /** near_limit: nodes sending now, and the plan's limit. */
  nodes?: number;
  nodeLimit?: number;
  /** beta_notice: when billing starts. */
  billingStartsAt?: Date;
}

const STOP = 'You get at most one of these emails a day, only while you are getting started.';

function footer(c: LifecycleContext, why: string): EmailSpec['footer'] {
  return { why, manage: c.unsubscribeUrl ? STOP : null, unsubscribeUrl: c.unsubscribeUrl ?? null };
}

export function lifecycleEmail(kind: LifecycleKind, c: LifecycleContext): EmailSpec {
  const sign = c.signature;
  const why = `You got this because you signed up for WatchLog Cloud and own ${c.orgName}.`;
  switch (kind) {
    case 'welcome':
      return {
        kind: 'info',
        subject: 'Welcome to WatchLog',
        preheader: 'One command to install, and your first metrics within a minute.',
        header: c.orgName,
        title: `Welcome, ${c.name}`,
        intro: [
          `Thanks for signing up. ${c.orgName} is ready.`,
          'Next, install the agent with the one command on the install page: Helm or kubectl for Kubernetes, or one command for a Linux server. Most show their first metrics within a minute of the agent starting.',
        ],
        button: { label: 'Open the install page', url: `${c.site}/onboarding` },
        note: ['If anything is unclear or broken, reply to this email. I read every reply.'],
        signature: sign,
        footer: footer(c, why),
      };
    case 'no_data':
      return {
        kind: 'info',
        subject: 'Need help installing WatchLog?',
        preheader: 'The install page checks the connection live and lists the usual causes.',
        header: c.orgName,
        title: 'No data yet',
        intro: [
          `${c.orgName} hasn’t received data from an agent yet.`,
          'The install page checks the connection live. After two minutes without a heartbeat it shows the commands to run and the usual causes: outbound HTTPS blocked, a wrong token, PodSecurity blocking the agent, a kernel without BTF.',
        ],
        button: {
          label: 'Open the install page',
          url: c.clusterId
            ? `${c.site}/onboarding?id=${encodeURIComponent(c.clusterId)}`
            : `${c.site}/onboarding`,
        },
        note: ['Stuck? Reply with what you see and I will help you get it running.'],
        signature: sign,
        footer: footer(c, why),
      };
    case 'first_alert':
      return {
        kind: 'info',
        subject: 'Your first WatchLog alert, explained',
        preheader: 'What its lines mean, and how to make alerts quieter.',
        header: c.orgName,
        title: 'Your first alert, explained',
        intro: [`WatchLog just sent the first alert for ${c.orgName}. How to read it:`],
        list: {
          items: [
            'Its facts say where, since when, which rule, and the value against its limit.',
            '“Likely cause” appears when WatchLog found one cause clearly more likely than the others. The alert’s page shows the evidence and the other possible causes.',
            'You get another email when it resolves, and reminders while it keeps firing.',
          ],
        },
        after: [
          'Too noisy? Each rule’s threshold, duration and channels can be changed on the Alerts page, and a silence mutes an alert for a while.',
        ],
        button: { label: 'Open Alerts', url: `${c.site}/alerts` },
        signature: sign,
        footer: footer(c, why),
      };
    case 'day3_tips':
      return {
        kind: 'info',
        subject: 'Three things to try in WatchLog',
        preheader: 'The service map, your databases and queues, and asking your AI assistant.',
        header: c.orgName,
        title: 'Three things to try',
        intro: [`${c.orgName} has been sending data for a few days. Three things worth a look:`],
        list: {
          ordered: true,
          items: [
            'The service map: who talks to whom and which connections fail, from eBPF, with no code changes.',
            'Applications: monitor PostgreSQL, Redis, MySQL, MongoDB, RabbitMQ, Kafka, NGINX or Traefik that WatchLog found running in your cluster or on your servers.',
            'MCP: ask Claude or Cursor about your infrastructure with a read-only API token.',
          ],
        },
        button: { label: 'Open WatchLog', url: `${c.site}/` },
        note: ['What is missing for you? A one-line reply helps more than you think.'],
        signature: sign,
        footer: footer(c, why),
      };
    case 'near_limit':
      return {
        kind: 'billing',
        subject: `${c.orgName} is close to the Free node limit`,
        preheader: `${c.nodes ?? 0} nodes are sending. Cloud Free includes ${c.nodeLimit ?? 5}.`,
        header: c.orgName,
        title: `${c.orgName} is close to the Free node limit`,
        intro: [
          `${c.orgName} has ${c.nodes ?? 0} nodes sending data. Cloud Free includes ${c.nodeLimit ?? 5}.`,
          'A node beyond the limit is refused and its data is not stored; the nodes already sending keep sending. Pro has no node limit.',
        ],
        facts: [
          { label: 'Sending now', value: `${c.nodes ?? 0} nodes` },
          { label: 'Free includes', value: `${c.nodeLimit ?? 5} nodes` },
          { label: 'Pro', value: proPriceLine() },
        ],
        button: { label: 'See the plans', url: `${c.site}/settings?tab=billing` },
        signature: sign,
        footer: footer(c, why),
      };
    case 'beta_notice':
      return {
        kind: 'billing',
        subject: 'WatchLog Pro: billing starts in 14 days',
        preheader: 'Add a payment method to keep Pro, or do nothing and move to Free.',
        header: c.orgName,
        badge: 'Action needed',
        title: 'Billing for Pro starts in 14 days',
        intro: [
          `${c.orgName} is on Pro, free during the beta. Billing for Pro starts on ${c.billingStartsAt ? day(c.billingStartsAt) : 'the date in Settings › Plan & billing'}.`,
        ],
        list: {
          items: [
            `Keep Pro: add a payment method in Settings › Plan & billing. Pro is ${proPriceLine()}`,
            'Or do nothing: the organization moves to Free. Your data stays until its retention ends.',
          ],
        },
        button: { label: 'Open Plan & billing', url: `${c.site}/settings?tab=billing` },
        note: ['Questions about the price or your usage? Reply to this email.'],
        signature: sign,
        footer: {
          why: `You got this because you are an Owner of ${c.orgName}. Billing notices can’t be turned off while a plan is active.`,
        },
      };
  }
}
