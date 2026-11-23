// SPDX-License-Identifier: AGPL-3.0-only
// The licence's upkeep in the alert-worker (ADR-232), self-hosted only, while a key is set:
//   - each install's hourly units (usage_hourly, as Cloud records them for its bill), which
//     the licence's count and the 30-day over-limit rule read;
//   - 30 days before the key ends, one email to every Owner, through the email server of the
//     email alert channels. A key is claimed in license_notices first, so a restart or a
//     second worker never sends it twice; without an email server it waits; a failed send is
//     retried on the next run.
import type { Database } from '../../db/index.js';
import type { Edition } from '../../config.js';
import { deliver, render } from '../../lib/mail.js';
import { transport } from '../alerts/channels.js';
import { licenseExpiringEmail } from '../emails/notices.js';
import { recordUsage } from '../entitlements/usage.js';
import type { AlertingSettings } from '../settings/service.js';
import type { LicenseReader } from './service.js';

export const LICENSE_JOBS_EVERY_MS = 5 * 60_000;

export interface LicenseJobDeps {
  db: Database;
  license: LicenseReader & { configured(): Promise<boolean> };
  settings: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  log: { debug(o: object, m: string): void; warn(o: object, m: string): void };
  edition?: Edition;
}

export async function runLicenseJobs(
  deps: LicenseJobDeps,
  nowMs: number,
): Promise<{ usage: number; emailed: number }> {
  if (!(await deps.license.configured())) return { usage: 0, emailed: 0 };
  const usage = await recordUsage({ systemDb: deps.db, db: deps.db }, nowMs);
  const emailed = await sendExpiringEmail(deps);
  return { usage, emailed };
}

/** The one email before the end: to every Owner, once per key. Returns the emails sent. */
export async function sendExpiringEmail(deps: LicenseJobDeps): Promise<number> {
  const check = (await deps.license.current()).check;
  const p = check?.payload;
  if (!p || check.state !== 'expiring') return 0;
  const owners = await deps.db
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select('u.email')
    .distinct()
    .where('m.role', '=', 'owner')
    .execute();
  if (!owners.length) return 0;
  const settings = await deps.settings();
  if (!settings.smtp) {
    deps.log.debug({}, 'the licence reminder waits for an email server');
    return 0;
  }
  const claimed = await deps.db
    .insertInto('license_notices')
    .values({ license_id: p.id, kind: 'expiring' })
    .onConflict((oc) => oc.doNothing())
    .returning('license_id')
    .executeTakeFirst();
  if (!claimed) return 0;
  const email = render(
    licenseExpiringEmail({
      customer: p.customer,
      expiresAt: new Date(p.expiresAt),
      graceEndsAt: new Date(check.graceEndsAt!),
      units: p.units,
      site: settings.publicUrl,
    }),
    deps.edition ?? 'community',
  );
  try {
    await deliver(transport(settings.smtp.transport), settings.smtp, {
      to: owners.map((o) => o.email),
      email,
    });
  } catch (err) {
    deps.log.warn(
      { err: (err as Error).message.slice(0, 200) },
      'the licence reminder was not sent; retrying on the next run',
    );
    await deps.db
      .deleteFrom('license_notices')
      .where('license_id', '=', p.id)
      .where('kind', '=', 'expiring')
      .execute();
    return 0;
  }
  return owners.length;
}
