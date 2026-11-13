// SPDX-License-Identifier: AGPL-3.0-only
// The lifecycle emails (ADR-179), a task in the alert worker, Cloud only. It lists the
// candidates across orgs on the owner's connection (systemDb) and writes each email's record
// inside its org (withOrg on the request path's pool, under Row-Level Security).
//
// Rules:
//   - from WATCHLOG_LIFECYCLE_FROM through the email server the alert channels use; without
//     either (or the public address for the links) nothing is sent;
//   - to the Owners of an org, with a verified address, whose account is under 30 days old
//     (the getting-started window), about their first org; never after an unsubscribe;
//   - at most one a day per user, each kind once per user (lifecycle_emails' key), claimed
//     before sending so two workers can't both send it; a failed send releases the claim;
//   - the beta-to-billing notice only when billing asked for it (beta_notices), to every
//     Owner of an org still on the beta; a service notice, so neither the daily limit nor
//     the unsubscribe applies to it.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import { transport } from '../alerts/channels.js';
import { PLAN_DEFAULTS } from '../entitlements/plans.js';
import type { AlertingSettings } from '../settings/service.js';
import { lifecycleEmail, type LifecycleKind } from './texts.js';
import { unsubscribeUrl } from './unsubscribe.js';

export const LIFECYCLE_EVERY_MS = 10 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The getting-started window: lifecycle emails go to accounts younger than this. */
export const LIFECYCLE_WINDOW_MS = 30 * DAY;

export interface LifecycleDeps {
  systemDb: Database;
  /** The request path's pool (watchlog_app in Cloud): the records are written under RLS. */
  db: Database;
  secretKey: Buffer;
  /** WATCHLOG_LIFECYCLE_FROM. */
  from?: string;
  settings: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** What the job knows about one Owner and their org, to pick the email due. */
export interface Candidate {
  userCreatedAt: Date;
  sentKinds: LifecycleKind[];
  sentToday: boolean;
  hasData: boolean;
  /** When the org's first notification went out, if one did. */
  firstAlertAt: Date | null;
  plan: string;
  nodes: number;
  nodeLimit: number | null;
}

/**
 * The email due for a candidate now, or null. In order: welcome (first 2 days), the first
 * alert (within 3 days of it), no data after an hour (first week), near the Free node limit
 * (one node from it), the day-3 tips (days 3 to 10, with data).
 */
export function dueKind(c: Candidate, nowMs: number): LifecycleKind | null {
  if (c.sentToday) return null;
  const age = nowMs - c.userCreatedAt.getTime();
  const sent = new Set(c.sentKinds);
  const due: [LifecycleKind, boolean][] = [
    ['welcome', age < 2 * DAY],
    ['first_alert', !!c.firstAlertAt && nowMs - c.firstAlertAt.getTime() < 3 * DAY],
    ['no_data', !c.hasData && age >= HOUR && age < 7 * DAY],
    [
      'near_limit',
      c.plan === 'free' && c.nodeLimit !== null && c.nodeLimit > 1 && c.nodes >= c.nodeLimit - 1,
    ],
    ['day3_tips', c.hasData && age >= 3 * DAY && age < 10 * DAY],
  ];
  for (const [kind, when] of due) if (when && !sent.has(kind)) return kind;
  return null;
}

/** "Name <a@b>" → "Name"; a bare address → "WatchLog". */
export function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return m?.[1]?.trim() || 'WatchLog';
}

const firstName = (name: string, email: string) =>
  (name.trim().split(/\s+/)[0] || email.slice(0, email.indexOf('@'))).slice(0, 60);

/** Claims (user, kind) inside the org; false when it was already claimed or sent. */
async function claim(db: Database, orgId: string, userId: string, kind: LifecycleKind) {
  const row = await withOrg(orgId, () =>
    db
      .insertInto('lifecycle_emails')
      .values({ org_id: orgId, user_id: userId, kind })
      .onConflict((oc) => oc.doNothing())
      .returning('kind')
      .executeTakeFirst(),
  );
  return !!row;
}

async function release(db: Database, orgId: string, userId: string, kind: LifecycleKind) {
  await withOrg(orgId, () =>
    db
      .deleteFrom('lifecycle_emails')
      .where('user_id', '=', userId)
      .where('kind', '=', kind)
      .execute(),
  );
}

/** Sends the emails due; returns how many went out. */
export async function sendLifecycleEmails(deps: LifecycleDeps, nowMs: number): Promise<number> {
  if (!deps.from) return 0;
  const settings = await deps.settings();
  if (!settings.smtp || !settings.publicUrl) return 0;
  const site = settings.publicUrl.replace(/\/+$/, '');
  const smtp = settings.smtp;
  const signature = `${senderName(deps.from)}, WatchLog`;
  const { systemDb, db, log } = deps;
  const now = new Date(nowMs);
  let sent = 0;

  const send = async (
    to: { userId: string; email: string; name: string },
    orgId: string,
    kind: LifecycleKind,
    ctx: Parameters<typeof lifecycleEmail>[1],
  ) => {
    if (!(await claim(db, orgId, to.userId, kind))) return;
    const mail = lifecycleEmail(kind, ctx);
    try {
      await transport(smtp.transport).sendMail({
        from: deps.from,
        replyTo: deps.from,
        to: to.email,
        subject: mail.subject,
        text: mail.text,
        ...(ctx.unsubscribeUrl
          ? {
              headers: {
                'List-Unsubscribe': `<${ctx.unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              },
            }
          : {}),
      });
      sent++;
    } catch (err) {
      log.warn(
        { kind, userId: to.userId, err: (err as Error).message.slice(0, 200) },
        'lifecycle email not sent; retrying later',
      );
      await release(db, orgId, to.userId, kind);
    }
  };

  // ---- the getting-started emails: each Owner's first org, accounts under 30 days.
  const owners = await systemDb
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .innerJoin('orgs as o', 'o.id', 'm.org_id')
    .select([
      'u.id as user_id',
      'u.email',
      'u.name',
      'u.created_at',
      'o.id as org_id',
      'o.name as org_name',
    ])
    .where('m.role', '=', 'owner')
    .where('u.email_verified_at', 'is not', null)
    .where('u.disabled_at', 'is', null)
    .where('u.lifecycle_unsubscribed_at', 'is', null)
    .where('o.suspended_at', 'is', null)
    .where('u.created_at', '>', new Date(nowMs - LIFECYCLE_WINDOW_MS))
    .orderBy('u.id')
    .orderBy('m.created_at')
    .execute();
  const seen = new Set<string>();
  for (const o of owners) {
    if (seen.has(o.user_id)) continue; // the first org only
    seen.add(o.user_id);
    const [emails, clusters, alert, nodes, ent] = await Promise.all([
      systemDb
        .selectFrom('lifecycle_emails')
        .select(['kind', 'sent_at'])
        .where('user_id', '=', o.user_id)
        .execute(),
      systemDb
        .selectFrom('clusters')
        .select(['id', 'first_seen_at'])
        .where('org_id', '=', o.org_id)
        .orderBy('created_at')
        .execute(),
      systemDb
        .selectFrom('notifications')
        .select((eb) => eb.fn.min('sent_at').as('at'))
        .where('org_id', '=', o.org_id)
        .where('status', '=', 'sent')
        .executeTakeFirst(),
      systemDb
        .selectFrom('agent_instances')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('org_id', '=', o.org_id)
        .where('mode', 'in', ['node', 'docker'])
        .where('last_seen_at', '>', new Date(nowMs - DAY))
        .executeTakeFirst(),
      systemDb
        .selectFrom('entitlements')
        .select(['plan', 'nodes'])
        .where('org_id', '=', o.org_id)
        .executeTakeFirst(),
    ]);
    const kind = dueKind(
      {
        userCreatedAt: o.created_at,
        sentKinds: emails.map((e) => e.kind as LifecycleKind),
        sentToday: emails.some((e) => nowMs - e.sent_at.getTime() < DAY),
        hasData: clusters.some((c) => c.first_seen_at !== null),
        firstAlertAt: (alert?.at as Date | null | undefined) ?? null,
        plan: ent?.plan ?? 'free',
        nodes: nodes?.n ?? 0,
        nodeLimit: ent ? ent.nodes : PLAN_DEFAULTS.free.nodes,
      },
      nowMs,
    );
    if (!kind) continue;
    const to = { userId: o.user_id, email: o.email, name: firstName(o.name, o.email) };
    await send(to, o.org_id, kind, {
      site,
      orgName: o.org_name,
      name: to.name,
      signature,
      unsubscribeUrl: unsubscribeUrl(site, deps.secretKey, o.user_id),
      clusterId: clusters[0]?.id ?? null,
      nodes: nodes?.n ?? 0,
      nodeLimit: ent?.nodes ?? PLAN_DEFAULTS.free.nodes ?? undefined,
    });
  }

  // ---- the beta-to-billing notice: only when billing asked for it, to every Owner.
  const notices = await systemDb
    .selectFrom('beta_notices as b')
    .innerJoin('orgs as o', 'o.id', 'b.org_id')
    .innerJoin('entitlements as e', 'e.org_id', 'b.org_id')
    .innerJoin('memberships as m', 'm.org_id', 'b.org_id')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'b.org_id',
      'b.billing_starts_at',
      'o.name as org_name',
      'u.id as user_id',
      'u.email',
      'u.name',
    ])
    .where('m.role', '=', 'owner')
    .where('u.disabled_at', 'is', null)
    .where('e.source', '=', 'beta')
    .where('b.billing_starts_at', '>', now)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('lifecycle_emails as l')
            .select('l.kind')
            .whereRef('l.user_id', '=', 'u.id')
            .where('l.kind', '=', 'beta_notice'),
        ),
      ),
    )
    .execute();
  for (const n of notices) {
    const to = { userId: n.user_id, email: n.email, name: firstName(n.name, n.email) };
    await send(to, n.org_id, 'beta_notice', {
      site,
      orgName: n.org_name,
      name: to.name,
      signature,
      billingStartsAt: n.billing_starts_at,
    });
  }

  if (sent) log.info({ sent }, 'lifecycle emails sent');
  return sent;
}
