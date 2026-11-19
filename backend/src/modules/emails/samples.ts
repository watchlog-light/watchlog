// SPDX-License-Identifier: AGPL-3.0-only
// Every email WatchLog's backend sends, with sample data (ADR-220): the snapshots in
// test/emails.test.ts and `pnpm --filter @watchlog/backend emails:preview` render these. The
// data is made up; names and addresses are example.com and example.org only.
import type { Edition } from '../../config.js';
import type { EmailSpec } from '../../lib/mail.js';
import type { MessagePayload } from '../alerts/outbox.js';
import { renderMessage, testPayload } from '../alerts/render.js';
import { lifecycleEmail, type LifecycleKind } from '../lifecycle/texts.js';
import {
  existingAccountEmail,
  inviteEmail,
  mfaLockedEmail,
  resetEmail,
  verifyEmail,
} from './account.js';
import { alertEmail } from './alerts.js';
import {
  dataNotices,
  limitEmail,
  settingsTestEmail,
  supportStartedEmail,
  tokenExpiryEmail,
  whatChangedReadyEmail,
} from './notices.js';

export const SAMPLE_SITE = 'https://cloud.watchlog.example';
const SELF_SITE = 'https://watchlog.acme.example';
const AT = '2026-11-19T14:17:00.000Z';

export interface Sample {
  /** The file name and the test's name: "alert-firing". */
  name: string;
  /** What sends it, for the preview's index. */
  from: string;
  edition: Edition;
  spec: EmailSpec;
  /** Lifecycle emails: the one-click unsubscribe. */
  unsubscribeUrl?: string;
}

const crashloop = (over: Partial<MessagePayload> = {}): MessagePayload => ({
  version: 1,
  kind: 'firing',
  severity: 'critical',
  rule: { id: 'r1', key: 'k8s.pod.crashloop', name: 'Pod CrashLoopBackOff' },
  cluster: { id: 'c1', name: 'acme-prod', kind: 'kubernetes' },
  items: [
    {
      alertId: 'a1',
      severity: 'critical',
      labels: {
        namespace: 'shop',
        pod: 'api-7d9f-x2k4',
        workload: 'api',
        workload_kind: 'Deployment',
      },
      details: { reason: 'Error', exitCode: 1, restarts: 6 },
      startedAt: '2026-11-19T14:02:00.000Z',
      firedAt: '2026-11-19T14:03:00.000Z',
      resolvedAt: null,
      likelyCause: {
        rule: 'release',
        code: 'release',
        facts: {},
        since: '2026-11-19T14:01:00.000Z',
        headline: { code: 'release', facts: {} },
        subject: 'workload:shop/Deployment/api',
        text: 'api exits about 20 s after every start. It began one minute after its image changed to 2026-11-19-1401.',
        chain: [],
      },
      whatChanged: 'shop/api: memory 1.2 GiB, usually 300–400 MiB, since 14:01 UTC',
    },
  ],
  total: 1,
  at: AT,
  ...over,
});

const pm2 = (kind: MessagePayload['kind']): MessagePayload => ({
  version: 1,
  kind,
  severity: 'critical',
  rule: { id: 'r2', key: 'server.process.crashloop', name: 'Process group crash-looping' },
  cluster: { id: 'c2', name: 'acme-servers', kind: 'server' },
  items: [
    {
      alertId: 'a2',
      severity: 'critical',
      labels: { node: 'app-1', group: 'api', unit: 'pm2-deploy.service' },
      details: { value: 6 },
      startedAt: '2026-11-19T14:02:00.000Z',
      firedAt: '2026-11-19T14:02:00.000Z',
      resolvedAt: kind === 'resolved' ? '2026-11-19T14:31:00.000Z' : null,
    },
  ],
  total: 1,
  at: kind === 'resolved' ? '2026-11-19T14:31:00.000Z' : AT,
});

function alert(p: MessagePayload, site: string) {
  const m = renderMessage(p, site);
  return alertEmail(p, m, { whatChanged: m.single ? (p.items[0]?.whatChanged ?? null) : null });
}

const LIFE: LifecycleKind[] = [
  'welcome',
  'no_data',
  'first_alert',
  'day3_tips',
  'near_limit',
  'beta_notice',
];

export function samples(): Sample[] {
  const lifeCtx = {
    site: SAMPLE_SITE,
    orgName: 'acme',
    name: 'Sara',
    signature: 'Mohammad, WatchLog',
    unsubscribeUrl: `${SAMPLE_SITE}/api/v1/lifecycle/unsubscribe?token=sample`,
    clusterId: 'c1',
    nodes: 4,
    nodeLimit: 5,
    billingStartsAt: new Date('2026-12-03T00:00:00Z'),
  };
  const batch = crashloop({
    total: 7,
    items: [0, 1, 2, 3, 4].map((i) => ({
      ...crashloop().items[0]!,
      alertId: `b${i}`,
      likelyCause: undefined,
      whatChanged: undefined,
      labels: {
        namespace: 'shop',
        pod: `worker-${i}`,
        workload: `worker-${i}`,
        workload_kind: 'Deployment',
      },
    })),
  });
  const resolvedK8s = crashloop({
    kind: 'resolved',
    at: '2026-11-19T14:31:00.000Z',
    items: [
      { ...crashloop().items[0]!, resolvedAt: '2026-11-19T14:31:00.000Z', whatChanged: undefined },
    ],
  });
  return [
    {
      name: 'verify-email',
      from: 'sign-up (Cloud)',
      edition: 'cloud',
      spec: verifyEmail({ code: '482913', link: `${SAMPLE_SITE}/verify-email/sample-token` }),
    },
    {
      name: 'existing-account',
      from: 'sign-up with a known address (Cloud)',
      edition: 'cloud',
      spec: existingAccountEmail({ site: SAMPLE_SITE }),
    },
    {
      name: 'mfa-locked',
      from: 'wrong 2FA codes (Cloud)',
      edition: 'cloud',
      spec: mfaLockedEmail({ site: SAMPLE_SITE, until: new Date('2026-11-19T14:32:00Z') }),
    },
    {
      name: 'reset-password',
      from: 'Forgot your password?',
      edition: 'cloud',
      spec: resetEmail({
        link: `${SAMPLE_SITE}/reset/sample-token`,
        device: 'Chrome on macOS',
        asked: new Date(AT),
      }),
    },
    {
      name: 'reset-password-by-admin',
      from: 'Settings › Users, reset link (Community)',
      edition: 'community',
      spec: resetEmail({ link: `${SELF_SITE}/reset/sample-token`, by: 'Sara Karimi' }),
    },
    {
      name: 'invite',
      from: 'Settings › Users, invite (Cloud)',
      edition: 'cloud',
      spec: inviteEmail({
        inviter: 'Sara Karimi',
        inviterEmail: 'sara@acme.example',
        org: 'acme',
        role: 'viewer',
        link: `${SAMPLE_SITE}/invite/sample-token`,
        expires: new Date('2026-11-26T14:00:00Z'),
      }),
    },
    {
      name: 'invite-community',
      from: 'Settings › Users, invite (Community)',
      edition: 'community',
      spec: inviteEmail({
        inviter: 'Sara Karimi',
        inviterEmail: 'sara@acme.example',
        org: null,
        site: SELF_SITE,
        role: 'admin',
        link: `${SELF_SITE}/invite/sample-token`,
        expires: new Date('2026-11-26T14:00:00Z'),
      }),
    },
    {
      name: 'alert-firing',
      from: 'alert channel: firing',
      edition: 'cloud',
      spec: alert(crashloop(), SAMPLE_SITE),
    },
    {
      name: 'alert-firing-server',
      from: 'alert channel: firing (server)',
      edition: 'community',
      spec: alert(pm2('firing'), SELF_SITE),
    },
    {
      name: 'alert-warning',
      from: 'alert channel: warning',
      edition: 'cloud',
      spec: alert(
        crashloop({
          severity: 'warning',
          items: [
            {
              ...crashloop().items[0]!,
              severity: 'warning',
              likelyCause: undefined,
              whatChanged: undefined,
            },
          ],
        }),
        SAMPLE_SITE,
      ),
    },
    {
      name: 'alert-still-firing',
      from: 'alert channel: reminder',
      edition: 'cloud',
      spec: alert(crashloop({ kind: 'renotify', at: '2026-11-19T16:03:00.000Z' }), SAMPLE_SITE),
    },
    {
      name: 'alert-escalated',
      from: 'alert channel: escalated',
      edition: 'cloud',
      spec: alert(crashloop({ kind: 'escalated' }), SAMPLE_SITE),
    },
    {
      name: 'alert-flapping',
      from: 'alert channel: flapping',
      edition: 'cloud',
      spec: alert(crashloop({ kind: 'flapping', severity: 'warning' }), SAMPLE_SITE),
    },
    {
      name: 'alert-resolved',
      from: 'alert channel: resolved',
      edition: 'cloud',
      spec: alert(resolvedK8s, SAMPLE_SITE),
    },
    {
      name: 'alert-resolved-server',
      from: 'alert channel: resolved (server)',
      edition: 'community',
      spec: alert(pm2('resolved'), SELF_SITE),
    },
    {
      name: 'alert-batch',
      from: 'alert channel: several alerts of one rule',
      edition: 'cloud',
      spec: alert(batch, SAMPLE_SITE),
    },
    {
      name: 'alert-test',
      from: 'alert channel: Send test',
      edition: 'community',
      spec: alert(testPayload(), SELF_SITE),
    },
    {
      name: 'smtp-test',
      from: 'Settings › Alert channels, Send test email (self-hosted)',
      edition: 'community',
      spec: settingsTestEmail(),
    },
    {
      name: 'token-expiry',
      from: 'API token reminder',
      edition: 'community',
      spec: tokenExpiryEmail({
        tokenName: 'Claude Code · laptop',
        prefix: 'wl_pat_7Kq2',
        expiresAt: new Date('2026-11-26T09:30:00Z'),
        site: SELF_SITE,
      }),
    },
    {
      name: 'limit-nodes',
      from: 'plan limit (Cloud)',
      edition: 'cloud',
      spec: limitEmail({
        kind: 'nodes',
        count: 1,
        limit: null,
        plan: 'free',
        orgName: 'acme',
        site: SAMPLE_SITE,
      }),
    },
    {
      name: 'limit-users-pro',
      from: 'plan limit, paid org (Cloud)',
      edition: 'cloud',
      spec: limitEmail({
        kind: 'users',
        count: 1,
        limit: 10,
        plan: 'pro',
        orgName: 'acme',
        site: SAMPLE_SITE,
      }),
    },
    {
      name: 'support-session',
      from: 'support session (Cloud)',
      edition: 'cloud',
      spec: supportStartedEmail({
        orgName: 'acme',
        staffEmail: 'support@watchlog.example',
        reason: 'Customer asked why the service map is empty',
        expiresAt: new Date('2026-11-19T15:17:00Z'),
        site: SAMPLE_SITE,
      }),
    },
    {
      name: 'deletion-requested',
      from: 'org deletion (Cloud)',
      edition: 'cloud',
      spec: dataNotices.deletionRequested(
        'acme',
        new Date('2026-11-26T14:00:00Z'),
        'Sara Karimi',
        SAMPLE_SITE,
      ),
    },
    {
      name: 'inactive-warning',
      from: 'inactive Free org (Cloud)',
      edition: 'cloud',
      spec: dataNotices.inactiveWarning('acme', new Date('2026-11-26T14:00:00Z'), SAMPLE_SITE),
    },
    {
      name: 'inactive-suspended',
      from: 'inactive Free org suspended (Cloud)',
      edition: 'cloud',
      spec: dataNotices.inactiveSuspended('acme', SAMPLE_SITE),
    },
    {
      name: 'what-changed-ready',
      from: 'What changed is ready (Cloud)',
      edition: 'cloud',
      spec: whatChangedReadyEmail({
        site: SAMPLE_SITE,
        cluster: { id: 'c1', name: 'acme-prod', kind: 'kubernetes' },
        signature: 'Mohammad, WatchLog',
      }),
    },
    ...LIFE.map((k) => ({
      name: `lifecycle-${k.replace(/_/g, '-')}`,
      from: `lifecycle: ${k} (Cloud)`,
      edition: 'cloud' as const,
      spec: lifecycleEmail(
        k,
        k === 'beta_notice' ? { ...lifeCtx, unsubscribeUrl: undefined } : lifeCtx,
      ),
      ...(k === 'beta_notice' ? {} : { unsubscribeUrl: lifeCtx.unsubscribeUrl }),
    })),
  ];
}
