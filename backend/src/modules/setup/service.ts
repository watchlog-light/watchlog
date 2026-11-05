// SPDX-License-Identifier: AGPL-3.0-only
// Community first-run setup: one-time code or env bootstrap (ADR-032), default org (ADR-035).
import { sql } from 'kysely';
import { randomInt } from 'node:crypto';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { hashPassword } from '../../lib/passwords.js';
import { safeEqual } from '../../lib/tokens.js';

// Crockford base32 without ambiguous characters (no I, L, O, U).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export interface AdminInput {
  email: string;
  name: string;
  password: string;
}

export async function hasUsers(db: Database): Promise<boolean> {
  const row = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  return row !== undefined;
}

/** Creates the default org, the admin user and an owner membership in one transaction. */
export async function createAdmin(db: Database, input: AdminInput): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction().execute(async (trx) => {
    // Serialise concurrent setup attempts; the second one sees the first user.
    await sql`SELECT pg_advisory_xact_lock(hashtext('watchlog:setup'))`.execute(trx);
    const existing = await trx.selectFrom('users').select('id').limit(1).executeTakeFirst();
    if (existing) throw new SetupAlreadyCompleteError();

    const orgId = newId();
    const userId = newId();
    await trx
      .insertInto('orgs')
      .values({ id: orgId, name: 'Default', slug: 'default', plan: 'community' })
      .execute();
    await trx
      .insertInto('users')
      .values({ id: userId, email: input.email, name: input.name, password_hash: passwordHash })
      .execute();
    await trx
      .insertInto('memberships')
      .values({ id: newId(), org_id: orgId, user_id: userId, role: 'owner' })
      .execute();
    return userId;
  });
}

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super('Setup is already complete');
  }
}

export interface SetupLogger {
  info(obj: object, msg: string): void;
  warn(msg: string): void;
}

/** Holds the one-time setup code while no user exists. */
export class SetupState {
  private code: string | null = null;
  private complete = false;

  constructor(private readonly generateCode: () => string = generateSetupCode) {}

  /** Called once at startup: env bootstrap, or print a setup code. */
  async initialize(
    db: Database,
    bootstrap: { email?: string; password?: string },
    log: SetupLogger,
  ): Promise<void> {
    if (await hasUsers(db)) {
      this.markComplete();
      return;
    }
    if (bootstrap.email && bootstrap.password) {
      await createAdmin(db, {
        email: bootstrap.email.trim().toLowerCase(),
        name: 'Admin',
        password: bootstrap.password,
      });
      this.markComplete();
      log.info({ email: bootstrap.email }, 'created admin user from WATCHLOG_ADMIN_EMAIL');
      return;
    }
    this.code = this.generateCode();
    log.warn(
      `WatchLog first-run setup: open the web UI and enter setup code ${this.code} to create the admin account.`,
    );
  }

  async isRequired(db: Database): Promise<boolean> {
    if (this.complete) return false;
    if (await hasUsers(db)) {
      this.markComplete();
      return false;
    }
    return true;
  }

  verifyCode(input: string): boolean {
    return this.code !== null && safeEqual(normalizeCode(input), normalizeCode(this.code));
  }

  markComplete(): void {
    this.complete = true;
    this.code = null;
  }
}
