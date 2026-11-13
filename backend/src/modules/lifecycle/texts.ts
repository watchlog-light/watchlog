// SPDX-License-Identifier: AGPL-3.0-only
// The lifecycle emails' texts (ADR-179, SPEC §10.4): plain text from the founder, short,
// and every claim true of the product as it ships (alerts every 30 s, the default rules,
// the likely cause, the service map, MCP, the install page's checks after 2 minutes, the
// Free limits). Each ends with how to stop them; the beta notice is a service notice.

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

const day = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

function footer(c: LifecycleContext): string[] {
  return c.unsubscribeUrl
    ? [
        '',
        '--',
        'You get at most one of these emails a day, only while you are getting started.',
        `Stop them with one click: ${c.unsubscribeUrl}`,
      ]
    : [];
}

export function lifecycleEmail(
  kind: LifecycleKind,
  c: LifecycleContext,
): { subject: string; text: string } {
  const sign = ['', c.signature];
  switch (kind) {
    case 'welcome':
      return {
        subject: 'Welcome to WatchLog',
        text: [
          `Hi ${c.name},`,
          '',
          `Thanks for signing up. ${c.orgName} is ready.`,
          '',
          'Next: install the agent with the one command on the install page (Helm, kubectl or',
          'Docker). Most clusters show their first metrics within a minute of the agent starting.',
          `${c.site}/onboarding`,
          '',
          'If anything is unclear or broken, reply to this email. I read every reply.',
          ...sign,
          ...footer(c),
        ].join('\n'),
      };
    case 'no_data':
      return {
        subject: 'Need help installing WatchLog?',
        text: [
          `Hi ${c.name},`,
          '',
          `${c.orgName} hasn't received data from an agent yet.`,
          '',
          'The install page checks the connection live. After two minutes without a heartbeat it',
          'shows the commands to run and the usual causes: outbound HTTPS blocked, a wrong token,',
          'PodSecurity blocking the agent, a kernel without BTF.',
          c.clusterId ? `${c.site}/onboarding?id=${c.clusterId}` : `${c.site}/onboarding`,
          '',
          'Stuck? Reply with what you see and I will help you get it running.',
          ...sign,
          ...footer(c),
        ].join('\n'),
      };
    case 'first_alert':
      return {
        subject: 'Your first WatchLog alert, explained',
        text: [
          `Hi ${c.name},`,
          '',
          `WatchLog just sent the first alert for ${c.orgName}. How to read it:`,
          '',
          '- The first lines say what is wrong, the value against its threshold, where, and since when.',
          '- "Likely cause:" appears when WatchLog found one cause clearly more likely than the others.',
          "  The alert's page shows the evidence, and the other possible causes.",
          '- You get another message when it resolves, and reminders while it keeps firing.',
          '',
          "Too noisy? Each rule's threshold, duration and channels can be changed on the Alerts page,",
          'and a silence mutes an alert for a while.',
          `${c.site}/alerts`,
          ...sign,
          ...footer(c),
        ].join('\n'),
      };
    case 'day3_tips':
      return {
        subject: 'Three things to try in WatchLog',
        text: [
          `Hi ${c.name},`,
          '',
          `${c.orgName} has been sending data for a few days. Three things worth a look:`,
          '',
          '1. The service map: who talks to whom and which connections fail (eBPF, no code changes).',
          '2. Applications: monitor PostgreSQL, Redis, MySQL, MongoDB, RabbitMQ, Kafka, NGINX or Traefik',
          '   that WatchLog found running in your cluster or on your hosts.',
          '3. MCP: ask Claude or Cursor about your infrastructure with a read-only API token.',
          '',
          `${c.site}/`,
          '',
          'What is missing for you? A one-line reply helps more than you think.',
          ...sign,
          ...footer(c),
        ].join('\n'),
      };
    case 'near_limit':
      return {
        subject: `${c.orgName} is close to the Free node limit`,
        text: [
          `Hi ${c.name},`,
          '',
          `${c.orgName} has ${c.nodes ?? 0} nodes sending data. Cloud Free includes ${c.nodeLimit ?? 5}.`,
          '',
          'A node beyond the limit is refused and its data is not stored; the nodes already sending',
          'keep sending. Pro has no node limit and is free during the beta:',
          `${c.site}/settings?tab=billing`,
          ...sign,
          ...footer(c),
        ].join('\n'),
      };
    case 'beta_notice':
      return {
        subject: 'WatchLog Pro: billing starts in 14 days',
        text: [
          `Hi ${c.name},`,
          '',
          `${c.orgName} is on Pro, free during the beta. Billing for Pro starts on ${c.billingStartsAt ? day(c.billingStartsAt) : 'the date in Settings › Plan & billing'}.`,
          '',
          'Before then, choose what happens:',
          '- keep Pro: add a payment method in Settings › Plan & billing;',
          '- or do nothing: the org moves to Free. Your data stays until its retention ends.',
          `${c.site}/settings?tab=billing`,
          '',
          'Questions about the price or your usage? Reply to this email.',
          ...sign,
        ].join('\n'),
      };
  }
}
