// SPDX-License-Identifier: AGPL-3.0-only
// One email to the Owners per limit and day (ADR-177), from the alert worker: a node
// refused with 402, a cluster or an invite refused with 409. The day's email is claimed
// with a row in plan_limit_emails first, so two workers never send it twice; a failed
// send removes the claim for the next run. Without an email server it waits, like the
// API token reminders (ADR-125). Across orgs: the owner's connection (systemDb). A Free org
// is offered Pro at its price from the plans config (ADR-215), never as free; an org that
// already pays is pointed to its plan page.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { transport } from '../alerts/channels.js';
import type { AlertingSettings } from '../settings/service.js';
import { deliver, render } from '../../lib/mail.js';
import { limitEmail } from '../emails/notices.js';
import { PLAN_DEFAULTS, type CloudPlan, type LimitKind } from './plans.js';

export const LIMIT_MAIL_EVERY_MS = 5 * 60_000;

export interface LimitMailDeps {
  systemDb: Database;
  settings: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** Sends the day's emails not sent yet. Returns how many went out. */
export async function sendLimitEmails(deps: LimitMailDeps, nowMs: number): Promise<number> {
  const { systemDb, log } = deps;
  const now = new Date(nowMs);
  const day = sql<Date>`(${now.toISOString()}::timestamptz at time zone 'UTC')::date`;
  const due = await systemDb
    .selectFrom('plan_limit_hits as h')
    .innerJoin('orgs as o', 'o.id', 'h.org_id')
    .leftJoin('entitlements as e', 'e.org_id', 'h.org_id')
    .select([
      'h.org_id',
      'h.kind',
      'o.name as org_name',
      'e.plan',
      'e.nodes',
      'e.clusters',
      'e.users',
      sql<number>`count(*)::int`.as('count'),
    ])
    .where('h.day', '=', day)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('plan_limit_emails as m')
            .select('m.org_id')
            .whereRef('m.org_id', '=', 'h.org_id')
            .whereRef('m.kind', '=', 'h.kind')
            .where('m.day', '=', day),
        ),
      ),
    )
    .groupBy(['h.org_id', 'h.kind', 'o.name', 'e.plan', 'e.nodes', 'e.clusters', 'e.users'])
    .execute();
  if (due.length === 0) return 0;
  const settings = await deps.settings();
  if (!settings.smtp) return 0;
  let sent = 0;
  for (const d of due) {
    const claimed = await systemDb
      .insertInto('plan_limit_emails')
      .values({ org_id: d.org_id, kind: d.kind, day })
      .onConflict((oc) => oc.doNothing())
      .returning('org_id')
      .executeTakeFirst();
    if (!claimed) continue;
    const owners = await systemDb
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('u.email')
      .where('m.org_id', '=', d.org_id)
      .where('m.role', '=', 'owner')
      .execute();
    const kind = d.kind as LimitKind;
    const plan = (d.plan ?? 'free') as CloudPlan;
    const limit = d.plan ? d[kind] : PLAN_DEFAULTS.free[kind];
    const email = render(
      limitEmail({
        kind,
        count: d.count,
        limit,
        plan,
        orgName: d.org_name,
        site: settings.publicUrl,
      }),
      'cloud',
    );
    try {
      for (const o of owners) {
        await deliver(transport(settings.smtp.transport), settings.smtp, { to: o.email, email });
      }
      sent++;
    } catch (err) {
      log.warn(
        { orgId: d.org_id, kind, err: (err as Error).message.slice(0, 200) },
        'plan limit email not sent; retrying later',
      );
      await systemDb
        .deleteFrom('plan_limit_emails')
        .where('org_id', '=', d.org_id)
        .where('kind', '=', d.kind)
        .where('day', '=', day)
        .execute();
    }
  }
  if (sent) log.info({ sent }, 'plan limit emails sent');
  return sent;
}
