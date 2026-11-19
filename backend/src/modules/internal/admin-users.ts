// SPDX-License-Identifier: AGPL-3.0-only
// The internal admin API's users (ADR-179, amended in 0.9.9): what the Cloud admin's Users
// page reads. Read-only: who signed up, how, with which orgs and plans, whether an agent ever
// connected and when data last came. Never a password hash, a TOTP secret, a recovery code, a
// token or a session id: none of those columns is selected here. Across orgs, so on the
// owner's connection, like the rest of /internal/admin.
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { sql, type RawBuilder } from 'kysely';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { ProblemSchema } from '../auth/schemas.js';
import { FUNNEL_STEPS } from '../funnel/events.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const Iso = Type.String({ format: 'date-time' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

/** One of the user's orgs, with what the page shows of it. */
const UserOrg = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  role: Type.String(),
  plan: Type.String(),
  /** Where the plan came from: signup, beta, billing or staff (null: no entitlements row). */
  source: Nullable(Type.String()),
  /** Nodes and servers that sent a heartbeat in the last 3 minutes. */
  nodesNow: Type.Integer(),
  /** When the org's first agent connected. */
  firstAgentAt: Nullable(Iso),
  /** The last heartbeat of any of its agents. */
  lastDataAt: Nullable(Iso),
});

export const AdminUserRow = Type.Object({
  id: Type.String(),
  email: Type.String(),
  name: Type.String(),
  createdAt: Iso,
  signedUpWith: Type.Union([Type.Literal('github'), Type.Literal('google'), Type.Literal('email')]),
  emailVerified: Type.Boolean(),
  mfa: Type.Boolean(),
  disabled: Type.Boolean(),
  orgs: Type.Array(UserOrg),
  /** Across the user's orgs. */
  nodesNow: Type.Integer(),
  firstAgentAt: Nullable(Iso),
  lastDataAt: Nullable(Iso),
  lastSignInAt: Nullable(Iso),
  /** The last request of any of their sessions still open (null after signing out). */
  lastActiveAt: Nullable(Iso),
});

const Totals = Type.Object({
  users: Type.Integer(),
  verified: Type.Integer(),
  withAgent: Type.Integer(),
  onPro: Type.Integer(),
  newThisWeek: Type.Integer(),
});

/** What the list can be ordered by, and the expression each is in the query below. */
const SORTS = {
  email: sql`email`,
  name: sql`lower(name)`,
  createdAt: sql`created_at`,
  signedUpWith: sql`signed_up_with`,
  emailVerified: sql`(email_verified_at IS NOT NULL)`,
  mfa: sql`(totp_enabled_at IS NOT NULL)`,
  orgs: sql`org_count`,
  plan: sql`plan_rank`,
  nodesNow: sql`nodes_now`,
  firstAgentAt: sql`first_agent_at`,
  lastDataAt: sql`last_data_at`,
  lastSignInAt: sql`last_sign_in_at`,
} as const satisfies Record<string, RawBuilder<unknown>>;
type SortKey = keyof typeof SORTS;
const SortKeys = Type.Union(
  (Object.keys(SORTS) as SortKey[]).map((k) => Type.Literal(k)) as [
    ReturnType<typeof Type.Literal<SortKey>>,
  ],
);

const ListQuery = Type.Object({
  /** In the email, or in the name or slug of one of their orgs. */
  q: Type.Optional(Type.String({ maxLength: 200 })),
  /** In an org on this plan. */
  plan: Type.Optional(
    Type.Union([Type.Literal('free'), Type.Literal('pro'), Type.Literal('enterprise')]),
  ),
  /** Whether an agent ever connected in one of their orgs. */
  agent: Type.Optional(Type.Union([Type.Literal('yes'), Type.Literal('no')])),
  /** Signed up in the last N days (7 or 30). */
  signedUpDays: Type.Optional(Type.Union([Type.Literal(7), Type.Literal(30)])),
  /** No sign-in and no request for N days (14). */
  inactiveDays: Type.Optional(Type.Literal(14)),
  sort: Type.Optional(SortKeys),
  dir: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
type ListFilter = Static<typeof ListQuery>;

interface UserFacts {
  id: string;
  email: string;
  name: string;
  created_at: Date;
  email_verified_at: Date | null;
  totp_enabled_at: Date | null;
  disabled_at: Date | null;
  last_sign_in_at: Date | null;
  last_active_at: Date | null;
  signed_up_with: 'github' | 'google' | 'email';
  org_count: number;
  nodes_now: number;
  first_agent_at: Date | null;
  last_data_at: Date | null;
  org_list: Static<typeof UserOrg>[] | null;
  total?: number;
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const view = (r: UserFacts): Static<typeof AdminUserRow> => ({
  id: r.id,
  email: r.email,
  name: r.name,
  createdAt: new Date(r.created_at).toISOString(),
  signedUpWith: r.signed_up_with,
  emailVerified: r.email_verified_at !== null,
  mfa: r.totp_enabled_at !== null,
  disabled: r.disabled_at !== null,
  orgs: (r.org_list ?? []).map((o) => ({
    ...o,
    firstAgentAt: iso(o.firstAgentAt),
    lastDataAt: iso(o.lastDataAt),
  })),
  nodesNow: r.nodes_now,
  firstAgentAt: iso(r.first_agent_at),
  lastDataAt: iso(r.last_data_at),
  lastSignInAt: iso(r.last_sign_in_at),
  lastActiveAt: iso(r.last_active_at),
});

export interface AdminUsersDeps {
  systemDb: Database;
  now: () => Date;
}

/**
 * Every user with their facts, as a subquery named `u`: one row per user, the orgs as a JSON
 * list. Only the columns named here leave the users table.
 */
function facts(now: Date) {
  const seen = new Date(now.getTime() - 3 * 60_000);
  return sql`
    SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at, u.totp_enabled_at,
           u.disabled_at, u.last_sign_in_at,
           CASE u.signup_source->>'method'
             WHEN 'github' THEN 'github' WHEN 'google' THEN 'google' ELSE 'email' END
             AS signed_up_with,
           (SELECT max(s.last_seen_at) FROM sessions s
             WHERE s.user_id = u.id AND s.stage = 'full') AS last_active_at,
           coalesce(agg.org_count, 0) AS org_count,
           coalesce(agg.nodes_now, 0) AS nodes_now,
           coalesce(agg.plan_rank, 0) AS plan_rank,
           coalesce(agg.on_pro, false) AS on_pro,
           agg.first_agent_at, agg.last_data_at, agg.org_list, agg.org_names, agg.plans
      FROM users u
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS org_count,
               sum(f.nodes_now)::int AS nodes_now,
               min(f.first_agent_at) AS first_agent_at,
               max(f.last_data_at) AS last_data_at,
               bool_or(f.plan = 'pro') AS on_pro,
               max(CASE f.plan WHEN 'enterprise' THEN 3 WHEN 'pro' THEN 2 WHEN 'free' THEN 1
                               ELSE 0 END) AS plan_rank,
               array_agg(f.plan) AS plans,
               string_agg(f.name || ' ' || f.slug, ' ') AS org_names,
               json_agg(json_build_object(
                 'id', f.id, 'name', f.name, 'slug', f.slug, 'role', m.role, 'plan', f.plan,
                 'source', f.source, 'nodesNow', f.nodes_now,
                 'firstAgentAt', f.first_agent_at, 'lastDataAt', f.last_data_at)
                 ORDER BY m.created_at, f.id) AS org_list
          FROM memberships m
          JOIN LATERAL (
            SELECT o.id, o.name, o.slug, coalesce(e.plan, o.plan) AS plan, e.source,
                   (SELECT count(*)::int FROM agent_instances a
                     WHERE a.org_id = o.id AND a.mode IN ('node', 'docker')
                       AND a.last_seen_at > ${seen}) AS nodes_now,
                   (SELECT min(c.first_seen_at) FROM clusters c WHERE c.org_id = o.id)
                     AS first_agent_at,
                   (SELECT max(a.last_seen_at) FROM agent_instances a WHERE a.org_id = o.id)
                     AS last_data_at
              FROM orgs o LEFT JOIN entitlements e ON e.org_id = o.id
             WHERE o.id = m.org_id
          ) f ON true
         WHERE m.user_id = u.id
      ) agg ON true`;
}

function where(f: ListFilter, now: Date): RawBuilder<unknown> {
  const conds: RawBuilder<unknown>[] = [sql`true`];
  const text = f.q?.trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(sql`(email ILIKE ${like} OR name ILIKE ${like} OR org_names ILIKE ${like})`);
  }
  if (f.plan) conds.push(sql`${f.plan} = ANY(plans)`);
  if (f.agent === 'yes') conds.push(sql`first_agent_at IS NOT NULL`);
  if (f.agent === 'no') conds.push(sql`first_agent_at IS NULL`);
  if (f.signedUpDays) {
    conds.push(sql`created_at >= ${new Date(now.getTime() - f.signedUpDays * DAY)}`);
  }
  if (f.inactiveDays) {
    // Last seen: the later of the last sign-in and the last request; never seen: sign-up.
    conds.push(
      sql`coalesce(greatest(last_sign_in_at, last_active_at), created_at)
            < ${new Date(now.getTime() - f.inactiveDays * DAY)}`,
    );
  }
  return sql.join(conds, sql` AND `);
}

/** The internal app with its TypeBox provider (the routes are added to it directly, so the
 *  staff check of /internal/admin covers them). */
type InternalApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export function adminUserRoutes(app: InternalApp, { systemDb, now }: AdminUsersDeps): void {
  app.get(
    '/internal/admin/users',
    {
      schema: {
        summary:
          'Cloud users with their orgs, plans and agents; searchable, filterable, sortable; totals of all users',
        querystring: ListQuery,
        response: {
          200: Type.Object({
            users: Type.Array(AdminUserRow),
            /** How many match the filters (for paging). */
            total: Type.Integer(),
            /** Of every user, whatever the filters. */
            totals: Totals,
          }),
          400: ProblemSchema,
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const f = request.query;
      const at = now();
      const order = SORTS[f.sort ?? 'createdAt'];
      const dir = (f.dir ?? (f.sort ? 'asc' : 'desc')) === 'asc' ? sql`ASC` : sql`DESC`;
      const [rows, totals] = await Promise.all([
        sql<UserFacts>`
          SELECT *, count(*) OVER ()::int AS total
            FROM (${facts(at)}) u
           WHERE ${where(f, at)}
           ORDER BY ${order} ${dir} NULLS LAST, id
           LIMIT ${f.limit ?? 50} OFFSET ${f.offset ?? 0}`.execute(systemDb),
        sql<Static<typeof Totals>>`
          SELECT count(*)::int AS users,
                 count(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS verified,
                 count(*) FILTER (WHERE first_agent_at IS NOT NULL)::int AS "withAgent",
                 count(*) FILTER (WHERE on_pro)::int AS "onPro",
                 count(*) FILTER (WHERE created_at >= ${new Date(at.getTime() - 7 * DAY)})::int
                   AS "newThisWeek"
            FROM (${facts(at)}) u`.execute(systemDb),
      ]);
      let total = rows.rows[0]?.total ?? 0;
      // A page past the end has no row to carry the count.
      if (rows.rows.length === 0 && (f.offset ?? 0) > 0) {
        const n = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM (${facts(at)}) u WHERE ${where(f, at)}`.execute(systemDb);
        total = n.rows[0]!.n;
      }
      return { users: rows.rows.map(view), total, totals: totals.rows[0]! };
    },
  );

  app.get(
    '/internal/admin/users/:id',
    {
      schema: {
        summary: "One user: the same facts, and each of their orgs' funnel steps with dates",
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({
            user: AdminUserRow,
            /** Ways to sign in that are set up: a password, and linked providers. */
            signIn: Type.Object({
              password: Type.Boolean(),
              providers: Type.Array(
                Type.Object({ provider: Type.String(), linkedAt: Iso, lastUsedAt: Nullable(Iso) }),
              ),
            }),
            /** Per org, the funnel's steps in order; `at` is null for a step not reached. */
            funnel: Type.Array(
              Type.Object({
                orgId: Type.String(),
                steps: Type.Array(Type.Object({ name: Type.String(), at: Nullable(Iso) })),
              }),
            ),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!UUID.test(id)) return sendProblem(reply, 404, 'User not found');
      const at = now();
      const found = await sql<UserFacts>`
        SELECT * FROM (${facts(at)}) u WHERE id = ${id}`.execute(systemDb);
      const row = found.rows[0];
      if (!row) return sendProblem(reply, 404, 'User not found');
      const user = view(row);
      const [account, providers, events] = await Promise.all([
        // Whether a password is set: a yes or no, never the hash.
        sql<{ password: boolean }>`
          SELECT password_hash IS NOT NULL AS password FROM users WHERE id = ${id}`.execute(
          systemDb,
        ),
        systemDb
          .selectFrom('user_identities')
          .select(['provider', 'created_at', 'last_used_at'])
          .where('user_id', '=', id)
          .orderBy('created_at')
          .execute(),
        user.orgs.length
          ? systemDb
              .selectFrom('funnel_events')
              .select((eb) => ['org_id', 'name', eb.fn.min('ts').as('at')])
              .where(
                'org_id',
                'in',
                user.orgs.map((o) => o.id),
              )
              .where('name', 'in', [...FUNNEL_STEPS])
              .groupBy(['org_id', 'name'])
              .execute()
          : [],
      ]);
      return {
        user,
        signIn: {
          password: account.rows[0]?.password ?? false,
          providers: providers.map((p) => ({
            provider: p.provider,
            linkedAt: new Date(p.created_at).toISOString(),
            lastUsedAt: iso(p.last_used_at),
          })),
        },
        funnel: user.orgs.map((o) => ({
          orgId: o.id,
          steps: FUNNEL_STEPS.map((name) => ({
            name,
            at: iso(events.find((e) => e.org_id === o.id && e.name === name)?.at ?? null),
          })),
        })),
      };
    },
  );
}
