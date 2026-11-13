// SPDX-License-Identifier: AGPL-3.0-only
// Personal API tokens in PostgreSQL (ADR-125): create, list, revoke, verify on every
// request (no cache, so a revocation counts at the next request), and the last use.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { DEMO_USER_EMAIL } from '../demo/constants.js';
import { countMcpCalls, recentMcpCalls, type McpCallView } from '../mcp/calls.js';
import { sha256 } from '../../lib/tokens.js';
import type { CurrentUser, Plan, Role } from '../auth/sessions.js';
import {
  DEAD_TOKEN_KEPT_MS,
  generateApiToken,
  isApiTokenFormat,
  isDead,
  LAST_USED_EVERY_MS,
  MAX_ACTIVE_API_TOKENS,
  MAX_NEW_IP_EVENTS,
  shortIp,
  tokenStatus,
  type ApiTokenScope,
  type ApiTokenStatus,
} from './tokens.js';

/** The token a request was authenticated with. */
export interface RequestToken {
  id: string;
  name: string;
  prefix: string;
  scope: ApiTokenScope;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  /** The live demo's published token (ADR-130): limited per visitor, its use not kept. */
  public: boolean;
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scope: ApiTokenScope;
  createdAt: string;
  expiresAt: string | null;
  status: ApiTokenStatus;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  lastUsedCountry: string | null;
  usedRest: boolean;
  /** MCP tool calls in the last 30 days: 0 until the call log exists (v0.2 slice 4). */
  mcpCalls30d: number;
  revokedAt: string | null;
}

export type ApiTokenEventKind =
  'created' | 'first_use' | 'new_ip' | 'expired' | 'revoked' | 'reminder_sent' | 'staff_access';

export interface ApiTokenEventView {
  at: string;
  kind: ApiTokenEventKind;
  ip: string | null;
  country: string | null;
  /** created and reminder_sent: when the token expires (null: never). */
  expiresAt?: string | null;
  /** revoked: who revoked it (null when that user is gone). */
  by?: { id: string; name: string } | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function tokenRows(db: Database) {
  return db
    .selectFrom('api_tokens as t')
    .select([
      't.id',
      't.name',
      't.prefix',
      't.scope',
      't.created_at',
      't.expires_at',
      't.last_used_at',
      't.last_used_ip',
      shortIp('t.last_used_ip').as('last_used_ip_short'),
      't.last_used_country',
      't.used_rest_at',
      't.revoked_at',
      't.revoked_by',
    ]);
}
type TokenRow = Awaited<ReturnType<ReturnType<typeof tokenRows>['executeTakeFirstOrThrow']>>;

/** Tool calls per token in the last 30 days (the MCP call log, ADR-127). */
const mcpCallCounts = countMcpCalls;

export function toTokenView(row: TokenRow, now: Date, mcpCalls = 0): ApiTokenView {
  const status = tokenStatus(row, now);
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope as ApiTokenScope,
    createdAt: row.created_at.toISOString(),
    expiresAt: iso(row.expires_at),
    status,
    lastUsedAt: iso(row.last_used_at),
    // Of a token that can no longer be used, only the network is kept.
    lastUsedIp: isDead(status) ? row.last_used_ip_short : row.last_used_ip,
    lastUsedCountry: row.last_used_country,
    usedRest: row.used_rest_at !== null,
    mcpCalls30d: mcpCalls,
    revokedAt: iso(row.revoked_at),
  };
}

/** A token counts towards the limit until it is revoked or expired. */
function activeFor(db: Database, userId: string, now: Date) {
  return db
    .selectFrom('api_tokens')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]));
}

/** A user's tokens: the live ones, and the expired or revoked ones of the last 30 days. */
export async function listApiTokens(
  db: Database,
  userId: string,
  orgId: string,
  now: Date,
): Promise<ApiTokenView[]> {
  const keptSince = new Date(now.getTime() - DEAD_TOKEN_KEPT_MS);
  const rows = await tokenRows(db)
    .where('t.user_id', '=', userId)
    .where('t.org_id', '=', orgId)
    .where((eb) =>
      eb.or([
        eb('t.revoked_at', '>', keptSince),
        eb.and([
          eb('t.revoked_at', 'is', null),
          eb.or([eb('t.expires_at', 'is', null), eb('t.expires_at', '>', keptSince)]),
        ]),
      ]),
    )
    .orderBy('t.created_at', 'desc')
    .execute();
  const calls = await mcpCallCounts(
    db,
    rows.map((r) => r.id),
    now,
  );
  const views = rows.map((r) => toTokenView(r, now, calls.get(r.id) ?? 0));
  // Usable tokens first, newest first within each group.
  return [...views.filter((v) => !isDead(v.status)), ...views.filter((v) => isDead(v.status))];
}

async function findOwnRow(db: Database, userId: string, orgId: string, id: string) {
  return tokenRows(db)
    .where('t.id', '=', id)
    .where('t.user_id', '=', userId)
    .where('t.org_id', '=', orgId)
    .executeTakeFirst();
}

/** One of the user's tokens with its history, newest first; null if not theirs. */
export async function getApiToken(
  db: Database,
  userId: string,
  orgId: string,
  id: string,
  now: Date,
): Promise<{ token: ApiTokenView; history: ApiTokenEventView[]; activity: McpCallView[] } | null> {
  const row = await findOwnRow(db, userId, orgId, id);
  if (!row) return null;
  const calls = await mcpCallCounts(db, [row.id], now);
  const token = toTokenView(row, now, calls.get(row.id) ?? 0);
  const events = await db
    .selectFrom('api_token_events')
    .select(['at', 'kind', 'ip', shortIp('ip').as('ip_short'), 'country', 'detail'])
    .where('token_id', '=', row.id)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const revoker = row.revoked_by
    ? await db
        .selectFrom('users')
        .select(['id', 'name'])
        .where('id', '=', row.revoked_by)
        .executeTakeFirst()
    : undefined;
  const dead = isDead(token.status);
  const history = events.map((e): ApiTokenEventView => {
    const kind = e.kind as ApiTokenEventKind;
    const detail = (e.detail ?? {}) as { expiresAt?: string | null };
    return {
      at: e.at.toISOString(),
      kind,
      ip: dead ? e.ip_short : e.ip,
      country: e.country,
      ...(kind === 'created' || kind === 'reminder_sent'
        ? { expiresAt: detail.expiresAt ?? null }
        : {}),
      ...(kind === 'revoked'
        ? { by: revoker ? { id: revoker.id, name: revoker.name } : null }
        : {}),
    };
  });
  return { token, history, activity: await recentMcpCalls(db, row.id) };
}

/**
 * Creates a token for the user, or 'limit' when they have 10 active ones. The user's row
 * is locked meanwhile, so concurrent requests cannot pass the limit together.
 */
export async function createApiToken(
  db: Database,
  opts: { userId: string; orgId: string; name: string; expiresInDays: number | null; now: Date },
): Promise<{ value: string; token: ApiTokenView } | 'limit'> {
  const { now } = opts;
  const expiresAt =
    opts.expiresInDays === null ? null : new Date(now.getTime() + opts.expiresInDays * 86_400_000);
  return db.transaction().execute(async (trx) => {
    await trx.selectFrom('users').select('id').where('id', '=', opts.userId).forUpdate().execute();
    const { n } = await activeFor(trx, opts.userId, now).executeTakeFirstOrThrow();
    if (Number(n) >= MAX_ACTIVE_API_TOKENS) return 'limit' as const;
    const token = generateApiToken();
    const id = newId();
    await trx
      .insertInto('api_tokens')
      .values({
        id,
        org_id: opts.orgId,
        user_id: opts.userId,
        name: opts.name,
        token_hash: token.hash,
        prefix: token.prefix,
        scope: 'read',
        created_at: now,
        expires_at: expiresAt,
      })
      .execute();
    await trx
      .insertInto('api_token_events')
      .values({
        id: newId(),
        token_id: id,
        at: now,
        kind: 'created',
        detail: JSON.stringify({ scope: 'read', expiresAt: iso(expiresAt) }),
      })
      .execute();
    const row = await tokenRows(trx).where('t.id', '=', id).executeTakeFirstOrThrow();
    return { value: token.value, token: toTokenView(row, now) };
  });
}

/**
 * Revokes one of the user's tokens: idempotent, and a no-op for an expired token. Its last
 * address is cut to its network. Returns null if the token is not theirs.
 */
export async function revokeApiToken(
  db: Database,
  opts: { userId: string; orgId: string; id: string; now: Date },
): Promise<{ revoked: boolean; prefix: string } | null> {
  const row = await findOwnRow(db, opts.userId, opts.orgId, opts.id);
  if (!row) return null;
  if (isDead(tokenStatus(row, opts.now))) return { revoked: false, prefix: row.prefix };
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('api_tokens')
      .set({
        revoked_at: opts.now,
        revoked_by: opts.userId,
        last_used_ip: shortIp('last_used_ip'),
      })
      .where('id', '=', row.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) return { revoked: false, prefix: row.prefix };
    await trx
      .insertInto('api_token_events')
      .values({
        id: newId(),
        token_id: row.id,
        at: opts.now,
        kind: 'revoked',
        detail: JSON.stringify({ by: opts.userId }),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    return { revoked: true, prefix: row.prefix };
  });
}

/**
 * The user and token behind a bearer value, or null: unknown, revoked, expired, or its
 * user is no longer a member of the token's org. Checked on every request, without a cache.
 */
export async function verifyApiToken(
  db: Database,
  value: string,
  now: Date,
): Promise<{ token: RequestToken; user: CurrentUser } | null> {
  if (!isApiTokenFormat(value)) return null;
  const row = await db
    .selectFrom('api_tokens as t')
    .innerJoin('users as u', 'u.id', 't.user_id')
    .innerJoin('memberships as m', (join) =>
      join.onRef('m.user_id', '=', 't.user_id').onRef('m.org_id', '=', 't.org_id'),
    )
    .innerJoin('orgs as o', 'o.id', 't.org_id')
    .select([
      't.id as token_id',
      't.name as token_name',
      't.prefix',
      't.scope',
      't.expires_at',
      't.last_used_at',
      'u.id',
      'u.email',
      'u.name',
      'u.locale',
      'm.role',
      'o.id as org_id',
      'o.name as org_name',
      'o.slug as org_slug',
      'o.plan as org_plan',
    ])
    .where('t.token_hash', '=', sha256(value))
    .where('t.revoked_at', 'is', null)
    .where((eb) => eb.or([eb('t.expires_at', 'is', null), eb('t.expires_at', '>', now)]))
    .executeTakeFirst();
  if (!row) return null;
  return {
    token: {
      id: row.token_id,
      name: row.token_name,
      prefix: row.prefix,
      scope: row.scope as ApiTokenScope,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      public: row.email === DEMO_USER_EMAIL,
    },
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      locale: row.locale,
      role: row.role as Role,
      org: { id: row.org_id, name: row.org_name, slug: row.org_slug, plan: row.org_plan as Plan },
    },
  };
}

export interface TokenUse {
  ip: string | null;
  country: string | null;
  /** A REST request (MCP calls have their own log, v0.2 slice 4). */
  rest: boolean;
}

/** Entries kept in memory before they are dropped (they are only a shortcut). */
const MAX_TRACKED = 10_000;
const MAX_IPS_PER_TOKEN = 256;

/**
 * Records a token's use: last_used_* at most once a minute per token (in memory, and by
 * a condition in the database so several replicas don't all write), the first use, and
 * the first use from each new address in the token's history.
 */
export class TokenUsage {
  private readonly lastWrite = new Map<string, number>();
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly db: Database,
    private readonly everyMs = LAST_USED_EVERY_MS,
  ) {}

  async record(token: RequestToken, use: TokenUse, now: Date): Promise<void> {
    await this.recordAddress(token, use, now);
    await this.recordLastUsed(token, use, now);
  }

  private async recordAddress(token: RequestToken, use: TokenUse, now: Date): Promise<void> {
    if (this.seen.size > MAX_TRACKED) this.seen.clear();
    let seen = this.seen.get(token.id);
    if (!seen) this.seen.set(token.id, (seen = new Set()));
    const key = use.ip ?? '';
    if (seen.has(key)) return;
    if (use.ip === null) {
      // Without an address only the first use is recorded.
      if (token.lastUsedAt === null) {
        await this.db
          .insertInto('api_token_events')
          .values({
            id: newId(),
            token_id: token.id,
            at: now,
            kind: 'first_use',
            country: use.country,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    } else {
      // The unique indexes make this a no-op for a known address or a second first use.
      await sql`
        INSERT INTO api_token_events (id, token_id, at, kind, ip, country)
        SELECT ${newId()}, ${token.id}, ${now},
               CASE WHEN EXISTS (SELECT 1 FROM api_token_events
                                  WHERE token_id = ${token.id} AND kind = 'first_use')
                    THEN 'new_ip' ELSE 'first_use' END,
               ${use.ip}::inet, ${use.country}
         WHERE (SELECT count(*) FROM api_token_events
                 WHERE token_id = ${token.id} AND kind = 'new_ip') < ${MAX_NEW_IP_EVENTS}
        ON CONFLICT DO NOTHING`.execute(this.db);
    }
    if (seen.size < MAX_IPS_PER_TOKEN) seen.add(key);
  }

  private async recordLastUsed(token: RequestToken, use: TokenUse, now: Date): Promise<void> {
    const t = now.getTime();
    const last = Math.max(this.lastWrite.get(token.id) ?? 0, token.lastUsedAt?.getTime() ?? 0);
    if (t - last < this.everyMs) return;
    if (this.lastWrite.size > MAX_TRACKED) this.lastWrite.clear();
    this.lastWrite.set(token.id, t);
    await this.db
      .updateTable('api_tokens')
      .set({
        last_used_at: now,
        last_used_ip: use.ip,
        last_used_country: use.country,
        ...(use.rest ? { used_rest_at: now } : {}),
      })
      .where('id', '=', token.id)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<=', new Date(t - this.everyMs)),
        ]),
      )
      .execute();
  }
}
