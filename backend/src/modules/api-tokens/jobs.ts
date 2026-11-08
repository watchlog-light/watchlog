// SPDX-License-Identifier: AGPL-3.0-only
// Hourly API token upkeep in the alert-worker (ADR-125), beside alert delivery:
//   - an expired token gets its `expired` event once, and its last address is cut to the
//     network;
//   - 30 days after a token expired or was revoked, it is deleted with its history;
//   - 7 days before a token expires, its owner gets one email through the email server of
//     the email alert channels. Without one the reminder waits; a failed send is retried
//     the next hour.
// Every step is idempotent and safe with several workers.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { transport } from '../alerts/channels.js';
import type { AlertingSettings } from '../settings/service.js';
import { DEAD_TOKEN_KEPT_MS, EXPIRES_SOON_MS, shortIp } from './tokens.js';

export const TOKEN_JOBS_EVERY_MS = 3_600_000;

export interface TokenJobLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TokenJobDeps {
  db: Database;
  /** The email server and the public address, as alert messages use them. */
  settings: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  log: TokenJobLogger;
}

export interface TokenJobReport {
  expired: number;
  deleted: number;
  reminded: number;
  failed: number;
}

/** Runs the three steps; one that fails is logged and does not stop the others. */
export async function runApiTokenJobs(deps: TokenJobDeps, nowMs: number): Promise<TokenJobReport> {
  const now = new Date(nowMs);
  const report: TokenJobReport = { expired: 0, deleted: 0, reminded: 0, failed: 0 };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      deps.log.warn({ step: name, err: (err as Error).message }, 'API token upkeep failed');
    }
  };
  await step('expire', async () => {
    report.expired = await markExpiredTokens(deps.db, now);
  });
  await step('delete', async () => {
    report.deleted = await deleteOldTokens(deps.db, now);
  });
  await step('remind', async () => {
    const r = await sendExpiryReminders(deps, now);
    report.reminded = r.sent;
    report.failed = r.failed;
  });
  if (report.expired || report.deleted || report.reminded || report.failed) {
    deps.log.info({ ...report }, 'API token upkeep');
  }
  return report;
}

/** Records `expired` once per expired, unrevoked token and cuts its last address. */
export async function markExpiredTokens(db: Database, now: Date): Promise<number> {
  const due = await db
    .selectFrom('api_tokens as t')
    .select(['t.id', 't.expires_at'])
    .where('t.expires_at', '<=', now)
    .where('t.revoked_at', 'is', null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('api_token_events as e')
            .select('e.id')
            .whereRef('e.token_id', '=', 't.id')
            .where('e.kind', '=', 'expired'),
        ),
      ),
    )
    .execute();
  let marked = 0;
  for (const t of due) {
    await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('api_token_events')
        .values({ id: newId(), token_id: t.id, at: t.expires_at!, kind: 'expired' })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) return;
      await trx
        .updateTable('api_tokens')
        .set({ last_used_ip: shortIp('last_used_ip') })
        .where('id', '=', t.id)
        .execute();
      marked++;
    });
  }
  return marked;
}

/** Deletes tokens (and their history) 30 days after they expired or were revoked. */
export async function deleteOldTokens(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - DEAD_TOKEN_KEPT_MS);
  const res = await db
    .deleteFrom('api_tokens')
    .where((eb) => eb.or([eb('revoked_at', '<', cutoff), eb('expires_at', '<', cutoff)]))
    .executeTakeFirst();
  return Number(res.numDeletedRows);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function reminderEmail(t: {
  tokenName: string;
  prefix: string;
  expiresAt: Date;
  userName: string;
  publicUrl?: string;
}): { subject: string; text: string } {
  const date = DATE_FORMAT.format(t.expiresAt);
  const where = t.publicUrl
    ? `Settings → API tokens (${t.publicUrl.replace(/\/+$/, '')}/settings)`
    : 'Settings → API tokens';
  return {
    subject: `Your WatchLog API token "${t.tokenName}" expires on ${date}`,
    text: [
      `Hello ${t.userName},`,
      '',
      `Your WatchLog API token "${t.tokenName}" (${t.prefix}…) expires on ${date} at ${TIME_FORMAT.format(t.expiresAt)} UTC.`,
      'After that, the scripts and AI assistants that use it can no longer read from WatchLog.',
      '',
      'To keep them working:',
      `1. Sign in to WatchLog and open ${where}.`,
      '2. Create a new token and put it where this one is used.',
      '3. Revoke this token.',
      '',
      'This is the only reminder for this token.',
      '',
      '— WatchLog',
    ].join('\n'),
  };
}

/**
 * One email per token that expires within 7 days, to its owner. A token is claimed by
 * setting reminded_at first, so two workers never send the same reminder; a failed send
 * clears it again for the next run.
 */
export async function sendExpiryReminders(
  deps: TokenJobDeps,
  now: Date,
): Promise<{ sent: number; failed: number }> {
  const { db, log } = deps;
  const due = await db
    .selectFrom('api_tokens as t')
    .innerJoin('users as u', 'u.id', 't.user_id')
    .select(['t.id', 't.name', 't.prefix', 't.expires_at', 'u.email', 'u.name as user_name'])
    .where('t.revoked_at', 'is', null)
    .where('t.reminded_at', 'is', null)
    .where('t.expires_at', '>', now)
    .where('t.expires_at', '<=', new Date(now.getTime() + EXPIRES_SOON_MS))
    .execute();
  if (due.length === 0) return { sent: 0, failed: 0 };
  const settings = await deps.settings();
  if (!settings.smtp) {
    log.debug({ tokens: due.length }, 'API token expiry reminders wait for an email server');
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const t of due) {
    const claimed = await db
      .updateTable('api_tokens')
      .set({ reminded_at: now })
      .where('id', '=', t.id)
      .where('reminded_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) continue;
    const mail = reminderEmail({
      tokenName: t.name,
      prefix: t.prefix,
      expiresAt: t.expires_at!,
      userName: t.user_name,
      publicUrl: settings.publicUrl,
    });
    try {
      await transport(settings.smtp.transport).sendMail({
        from: settings.smtp.from,
        to: t.email,
        subject: mail.subject,
        text: mail.text,
      });
    } catch (err) {
      failed++;
      log.warn(
        { tokenPrefix: t.prefix, err: (err as Error).message.slice(0, 200) },
        'API token expiry reminder not sent; retrying in an hour',
      );
      await db
        .updateTable('api_tokens')
        .set({ reminded_at: null })
        .where('id', '=', t.id)
        .execute();
      continue;
    }
    sent++;
    await db
      .insertInto('api_token_events')
      .values({
        id: newId(),
        token_id: t.id,
        at: now,
        kind: 'reminder_sent',
        detail: JSON.stringify({ expiresAt: t.expires_at!.toISOString() }),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  return { sent, failed };
}
