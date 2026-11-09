// SPDX-License-Identifier: AGPL-3.0-only
// `watchlog`, the command inside the backend container (ADR-140):
//
//   watchlog admin reset-password [--email <address>] [--url <public URL>]
//
// prints a single-use password reset link, valid for one hour, for a locked-out Owner
// (no --email) or any user. Whoever can run a command in the backend container already
// controls the install, so printing the link there is safe. Every use is audited.
import { loadConfig } from './config.js';
import { createDb, describeDbError } from './db/index.js';
import { SettingsService } from './modules/settings/service.js';
import { audit, CLI_ACTOR, createResetLink } from './modules/users/service.js';

const USAGE = `Usage:
  watchlog admin reset-password [--email <address>] [--url <public URL>]

Prints a single-use password reset link, valid for one hour. Without --email it resets the
Owner. The link uses the Public URL setting; if it isn't set, pass --url https://…`;

class UsageError extends Error {}

function parse(argv: string[]) {
  const [group, command, ...rest] = argv;
  if (group !== 'admin' || command !== 'reset-password') throw new UsageError(USAGE);
  const opts: { email?: string; url?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const [flag, inline] = a.includes('=') ? a.split(/=(.*)/, 2) : [a, undefined];
    const value = inline ?? rest[++i];
    if (!value) throw new UsageError(`${flag} needs a value\n\n${USAGE}`);
    if (flag === '--email') opts.email = value.trim().toLowerCase();
    else if (flag === '--url') opts.url = value.trim();
    else throw new UsageError(`Unknown option ${flag}\n\n${USAGE}`);
  }
  if (opts.url && !/^https?:\/\/[^\s/]+/.test(opts.url)) {
    throw new UsageError('--url must be http(s)://host[:port]');
  }
  return opts;
}

export async function resetPassword(
  db: ReturnType<typeof createDb>,
  settings: SettingsService,
  opts: { email?: string; url?: string },
): Promise<string> {
  let q = db
    .selectFrom('users as u')
    .innerJoin('memberships as m', 'm.user_id', 'u.id')
    .select(['u.id', 'u.email', 'm.org_id', 'm.role']);
  q = opts.email ? q.where('u.email', '=', opts.email) : q.where('m.role', '=', 'owner');
  const user = await q.executeTakeFirst();
  if (!user) {
    throw new UsageError(
      opts.email
        ? `No user with the email ${opts.email}.`
        : 'There is no Owner yet: finish setup first.',
    );
  }
  const base = (opts.url ?? (await settings.publicUrl()).value)?.replace(/\/+$/, '');
  if (!base) {
    throw new UsageError(
      'The Public URL setting is empty: pass --url https://your-watchlog-address',
    );
  }
  const { token } = await createResetLink(db, { userId: user.id, via: 'cli', createdBy: null });
  await audit(db, {
    orgId: user.org_id,
    action: 'reset_link_created',
    actor: CLI_ACTOR,
    subjectEmail: user.email,
  });
  return [
    `Reset link for ${user.email} (works once, valid for 1 hour):`,
    `${base}/reset/${token}`,
  ].join('\n');
}

async function main(argv: string[]) {
  let db: ReturnType<typeof createDb> | undefined;
  try {
    const opts = parse(argv);
    const config = loadConfig();
    db = createDb(config.databaseUrl);
    console.log(await resetPassword(db, new SettingsService(db, config), opts));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exitCode = 2;
    } else {
      console.error(`watchlog: ${describeDbError(err, process.env.DATABASE_URL ?? '')}`);
      process.exitCode = 1;
    }
  } finally {
    await db?.destroy();
  }
}

// Run as a command (dist/cli.js), not when imported by the tests.
if (process.argv[1] && /cli\.[jt]s$/.test(process.argv[1])) await main(process.argv.slice(2));
else if (process.env.WATCHLOG_CLI === '1') await main(process.argv.slice(2));
