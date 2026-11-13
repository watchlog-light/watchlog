// SPDX-License-Identifier: AGPL-3.0-only
// The internal admin API (ADR-179), Cloud only, on the internal listener: what the Cloud
// admin (the waitlist's admin panel, behind its own sign-in with TOTP) calls. Besides the
// internal token, every /internal/admin request names the staff member in
// `X-WatchLog-Staff: <email>`; the panel sets it from its own signed-in admin, the API
// records it with every write (the org's audit events) and with every support session.
// Across orgs, so on the owner's connection (systemDb, allow-listed).
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { sql } from 'kysely';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { transport } from '../alerts/channels.js';
import { ProblemSchema } from '../auth/schemas.js';
import type { EntitlementsService } from '../entitlements/service.js';
import { usageReport } from '../entitlements/usage.js';
import { funnelByWeek } from '../funnel/report.js';
import type { FunnelRecorder } from '../funnel/recorder.js';
import type { AlertingSettings } from '../settings/service.js';
import {
  endSupportSession,
  listSupportSessions,
  openSupportSession,
  staffActor,
  SUPPORT_CODE_TTL_MS,
  SUPPORT_MAX_MS,
} from '../support/service.js';
import { SupportSessionSchema } from '../support/routes.js';
import { audit } from '../users/service.js';
import { EntitlementView, entitlementView, UsageView } from './views.js';

/** The header that names the staff member (set by the Cloud admin after its TOTP sign-in). */
export const STAFF_HEADER = 'x-watchlog-staff';
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

declare module 'fastify' {
  interface FastifyRequest {
    /** The staff member named by X-WatchLog-Staff (internal admin routes). */
    staffEmail?: string;
  }
}

export interface AdminDeps {
  systemDb: Database;
  entitlements: EntitlementsService;
  funnel?: FunnelRecorder | null;
  /** The email server and public address (support links and the Owners' email). */
  settings?: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  now?: () => number;
}

const Iso = Type.String({ format: 'date-time' });
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) =>
  Type.Union([t, Type.Null()]);

export const AdminOrgRow = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  source: Nullable(Type.String()),
  status: Type.Union([Type.Literal('active'), Type.Literal('suspended')]),
  createdAt: Iso,
  clusters: Type.Integer(),
  members: Type.Integer(),
  /** Nodes and Docker hosts that sent a heartbeat in the last 3 minutes. */
  nodesNow: Type.Integer(),
  /** The last heartbeat of any of its agents. */
  lastDataAt: Nullable(Iso),
});

const Member = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  name: Type.String(),
  role: Type.String(),
  joinedAt: Iso,
  emailVerified: Type.Boolean(),
  mfa: Type.Boolean(),
  lastActiveAt: Nullable(Iso),
});

const Params = Type.Object({ id: Type.String({ maxLength: 64 }) });

export function supportStartedMail(p: {
  orgName: string;
  staffEmail: string;
  reason: string;
  expiresAt: Date;
  site?: string;
}) {
  const until = p.expiresAt.toISOString().slice(11, 16);
  return {
    subject: `WatchLog staff opened a support session in ${p.orgName}`,
    text: [
      'Hello,',
      '',
      `${p.staffEmail} at WatchLog opened a read-only support session in ${p.orgName}.`,
      '',
      `Why: ${p.reason}`,
      `Until: ${until} UTC at the latest (a session lasts at most an hour and can't change anything).`,
      '',
      `Settings › Security lists every session, with what it opened${p.site ? `: ${p.site}/settings?tab=security` : '.'}`,
      '',
      "If you didn't expect this, reply to this email.",
      '',
      '— WatchLog',
    ].join('\n'),
  };
}

export const adminRoutes: FastifyPluginAsyncTypebox<AdminDeps> = async (app, deps) => {
  const { systemDb, entitlements } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  // The staff member, on every admin route (after the token check of the whole app).
  app.addHook('preHandler', async (request, reply) => {
    const raw = request.headers[STAFF_HEADER];
    const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? '';
    if (!EMAIL.test(email)) {
      return sendProblem(reply, 400, `Name the staff member in ${STAFF_HEADER}: <email>`);
    }
    request.staffEmail = email;
  });

  const findOrg = async (id: string) =>
    UUID.test(id)
      ? systemDb
          .selectFrom('orgs')
          .select(['id', 'name', 'slug', 'plan', 'created_at', 'suspended_at', 'suspended_reason'])
          .where('id', '=', id)
          .executeTakeFirst()
      : undefined;

  const orgRows = (filter: { q?: string; status?: string; id?: string }) => {
    const seen = new Date(now().getTime() - 3 * 60_000);
    let q = systemDb
      .selectFrom('orgs as o')
      .leftJoin('entitlements as e', 'e.org_id', 'o.id')
      .select((eb) => [
        'o.id',
        'o.name',
        'o.slug',
        'o.plan',
        'e.source',
        'o.suspended_at',
        'o.created_at',
        eb
          .selectFrom('clusters as c')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('c.org_id', '=', 'o.id')
          .as('clusters'),
        eb
          .selectFrom('memberships as m')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('m.org_id', '=', 'o.id')
          .as('members'),
        eb
          .selectFrom('agent_instances as a')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('a.org_id', '=', 'o.id')
          .where('a.mode', 'in', ['node', 'docker'])
          .where('a.last_seen_at', '>', seen)
          .as('nodes_now'),
        eb
          .selectFrom('agent_instances as a')
          .select((e) => e.fn.max('a.last_seen_at').as('at'))
          .whereRef('a.org_id', '=', 'o.id')
          .as('last_data_at'),
      ]);
    if (filter.id) q = q.where('o.id', '=', filter.id);
    const text = filter.q;
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) =>
        eb.or([
          eb('o.name', 'ilike', like),
          eb('o.slug', 'ilike', like),
          eb.exists(
            eb
              .selectFrom('memberships as m')
              .innerJoin('users as u', 'u.id', 'm.user_id')
              .select('m.id')
              .whereRef('m.org_id', '=', 'o.id')
              .where('u.email', 'ilike', like),
          ),
          ...(UUID.test(text) ? [eb('o.id', '=', text)] : []),
        ]),
      );
    }
    if (filter.status === 'suspended') q = q.where('o.suspended_at', 'is not', null);
    if (filter.status === 'active') q = q.where('o.suspended_at', 'is', null);
    return q;
  };
  const rowView = (r: Awaited<ReturnType<ReturnType<typeof orgRows>['execute']>>[number]) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    source: r.source ?? null,
    status: r.suspended_at ? ('suspended' as const) : ('active' as const),
    createdAt: r.created_at.toISOString(),
    clusters: r.clusters ?? 0,
    members: r.members ?? 0,
    nodesNow: r.nodes_now ?? 0,
    lastDataAt: r.last_data_at ? new Date(r.last_data_at as Date).toISOString() : null,
  });

  app.get(
    '/internal/admin/orgs',
    {
      schema: {
        summary: 'Orgs, newest first, searchable by name, slug, member email or id',
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('suspended')])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        }),
        response: {
          200: Type.Object({ orgs: Type.Array(AdminOrgRow), total: Type.Integer() }),
          400: ProblemSchema,
          401: ProblemSchema,
        },
      },
    },
    async (request) => {
      const { q, status, limit = 50, offset = 0 } = request.query;
      const filter = { q: q?.trim() || undefined, status };
      const [rows, total] = await Promise.all([
        orgRows(filter).orderBy('o.created_at', 'desc').limit(limit).offset(offset).execute(),
        systemDb
          .selectFrom(orgRows(filter).as('x'))
          .select(sql<number>`count(*)::int`.as('n'))
          .executeTakeFirstOrThrow(),
      ]);
      return { orgs: rows.map(rowView), total: total.n };
    },
  );

  app.get(
    '/internal/admin/orgs/:id',
    {
      schema: {
        summary: 'One org: its row, entitlements, members and clusters',
        params: Params,
        response: {
          200: Type.Object({
            org: Type.Intersect([
              AdminOrgRow,
              Type.Object({ suspendedAt: Nullable(Iso), suspendedReason: Nullable(Type.String()) }),
            ]),
            entitlements: EntitlementView,
            members: Type.Array(Member),
            clusters: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                kind: Type.String(),
                status: Type.String(),
                nodes: Type.Integer(),
                firstSeenAt: Nullable(Iso),
                lastSeenAt: Nullable(Iso),
              }),
            ),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      const [row, ent, members, clusters] = await Promise.all([
        orgRows({ id: org.id }).executeTakeFirstOrThrow(),
        entitlements.get(org.id),
        membersOf(org.id),
        systemDb
          .selectFrom('clusters')
          .select(['id', 'name', 'kind', 'status', 'node_count', 'first_seen_at', 'last_seen_at'])
          .where('org_id', '=', org.id)
          .orderBy('created_at')
          .execute(),
      ]);
      return {
        org: {
          ...rowView(row),
          suspendedAt: org.suspended_at?.toISOString() ?? null,
          suspendedReason: org.suspended_reason,
        },
        entitlements: entitlementView(ent),
        members,
        clusters: clusters.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          status: c.status,
          nodes: c.node_count ?? 0,
          firstSeenAt: c.first_seen_at?.toISOString() ?? null,
          lastSeenAt: c.last_seen_at?.toISOString() ?? null,
        })),
      };
    },
  );

  async function membersOf(orgId: string) {
    const rows = await systemDb
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select((eb) => [
        'u.id',
        'u.email',
        'u.name',
        'm.role',
        'm.created_at',
        'u.email_verified_at',
        'u.totp_enabled_at',
        eb
          .selectFrom('sessions as s')
          .select((e) => e.fn.max('s.last_seen_at').as('at'))
          .whereRef('s.user_id', '=', 'u.id')
          .as('last_active'),
      ])
      .where('m.org_id', '=', orgId)
      .orderBy('m.created_at')
      .execute();
    return rows.map((r) => ({
      userId: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      joinedAt: r.created_at.toISOString(),
      emailVerified: r.email_verified_at !== null,
      mfa: r.totp_enabled_at !== null,
      lastActiveAt: r.last_active ? new Date(r.last_active as Date).toISOString() : null,
    }));
  }

  app.get(
    '/internal/admin/orgs/:id/members',
    {
      schema: {
        summary: "An org's members, with their emails (staff only)",
        params: Params,
        response: {
          200: Type.Object({ members: Type.Array(Member) }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      return { members: await membersOf(org.id) };
    },
  );

  app.get(
    '/internal/admin/orgs/:id/usage',
    {
      schema: {
        summary: "An org's hourly nodes and their 95th percentile (default: the last 30 days)",
        params: Params,
        querystring: Type.Object({
          from: Type.Optional(Iso),
          to: Type.Optional(Iso),
        }),
        response: { 200: UsageView, 400: ProblemSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      const nowMs = now().getTime();
      const to = request.query.to ? new Date(request.query.to) : new Date(nowMs);
      const from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 30 * DAY);
      if (!(to > from) || to.getTime() - from.getTime() > 400 * DAY) {
        return sendProblem(reply, 400, '`to` must be after `from`, at most 400 days later');
      }
      return { orgId: org.id, ...(await usageReport(systemDb, org.id, from, to, nowMs)) };
    },
  );

  app.get(
    '/internal/admin/orgs/:id/entitlements',
    {
      schema: {
        summary: "An org's entitlements",
        params: Params,
        response: {
          200: EntitlementView,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      return entitlementView(await entitlements.get(org.id));
    },
  );

  app.put(
    '/internal/admin/orgs/:id/entitlements',
    {
      schema: {
        summary: "Staff set an org's entitlements (source: staff), recorded in its audit events",
        params: Params,
        body: Type.Object(
          {
            plan: Type.Union([
              Type.Literal('free'),
              Type.Literal('pro'),
              Type.Literal('enterprise'),
            ]),
            clusters: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 1_000_000 }))),
            nodes: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 1_000_000 }))),
            users: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 1_000_000 }))),
            retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3660 })),
            proFeatures: Type.Optional(Type.Boolean()),
            betaUntil: Type.Optional(Nullable(Iso)),
            /** Why, for the audit event. */
            note: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: EntitlementView,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      const { note, betaUntil, ...b } = request.body;
      const before = await entitlements.get(org.id);
      const saved = await entitlements.put(org.id, {
        ...b,
        source: 'staff',
        betaUntil: betaUntil ? new Date(betaUntil) : null,
      });
      await audit(systemDb, {
        orgId: org.id,
        action: 'staff_entitlements_set',
        actor: staffActor(request.staffEmail!, request.ip),
        details: {
          planBefore: before.plan,
          plan: saved.plan,
          nodes: saved.nodes,
          clusters: saved.clusters,
          users: saved.users,
          retentionDays: saved.retentionDays,
          note: note ?? null,
        },
      });
      if (saved.plan === 'pro' && before.plan !== 'pro' && deps.funnel) {
        await deps.funnel.record({
          name: 'pro_started',
          orgId: org.id,
          props: { source: 'staff' },
        });
      }
      request.log.info(
        { orgId: org.id, plan: saved.plan, staff: request.staffEmail },
        'entitlements set by staff',
      );
      return entitlementView(saved);
    },
  );

  for (const action of ['suspend', 'unsuspend'] as const) {
    app.post(
      `/internal/admin/orgs/:id/${action}`,
      {
        schema: {
          summary:
            action === 'suspend'
              ? 'Suspend an org: ingest answers 402; its Owners can still sign in'
              : 'Lift a suspension',
          params: Params,
          body: Type.Object(
            { reason: Type.String({ minLength: 3, maxLength: 500 }) },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object({
              id: Type.String(),
              status: Type.String(),
              suspendedAt: Nullable(Iso),
            }),
            400: ProblemSchema,
            401: ProblemSchema,
            404: ProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const org = await findOrg(request.params.id);
        if (!org) return sendProblem(reply, 404, 'No such org');
        const at = action === 'suspend' ? (org.suspended_at ?? now()) : null;
        await systemDb
          .updateTable('orgs')
          .set({ suspended_at: at, suspended_reason: at ? request.body.reason : null })
          .where('id', '=', org.id)
          .execute();
        entitlements.invalidate(org.id);
        await audit(systemDb, {
          orgId: org.id,
          action: action === 'suspend' ? 'staff_org_suspended' : 'staff_org_unsuspended',
          actor: staffActor(request.staffEmail!, request.ip),
          details: { reason: request.body.reason },
        });
        return {
          id: org.id,
          status: at ? 'suspended' : 'active',
          suspendedAt: at?.toISOString() ?? null,
        };
      },
    );
  }

  app.get(
    '/internal/admin/funnel',
    {
      schema: {
        summary: 'The funnel by signup week: orgs reaching each step, and the conversion',
        querystring: Type.Object({
          weeks: Type.Optional(Type.Integer({ minimum: 1, maximum: 104, default: 12 })),
        }),
        response: {
          200: Type.Object({
            steps: Type.Array(Type.String()),
            weeks: Type.Array(
              Type.Object({
                week: Type.String(),
                steps: Type.Array(
                  Type.Object({
                    name: Type.String(),
                    orgs: Type.Integer(),
                    conversion: Nullable(Type.Number()),
                  }),
                ),
              }),
            ),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
        },
      },
    },
    async (request) => funnelByWeek(systemDb, request.query.weeks ?? 12, now().getTime()),
  );

  // ---------------------------------------------------------------- support mode

  app.post(
    '/internal/admin/orgs/:id/support-sessions',
    {
      schema: {
        summary:
          'Open a read-only support session (at most an hour); returns a one-time sign-in link',
        params: Params,
        body: Type.Object(
          {
            reason: Type.String({ minLength: 3, maxLength: 500 }),
            minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: SUPPORT_MAX_MS / 60_000 })),
          },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({
            session: SupportSessionSchema,
            url: Type.String(),
            codeExpiresAt: Iso,
            ownersEmailed: Type.Integer(),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
          503: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      const settings = deps.settings ? await deps.settings() : undefined;
      const site = settings?.publicUrl?.replace(/\/+$/, '');
      if (!site) {
        return sendProblem(reply, 503, 'Set the public address (WATCHLOG_PUBLIC_URL) first');
      }
      const staffEmail = request.staffEmail!;
      const at = now();
      const { session, code } = await openSupportSession(systemDb, {
        orgId: org.id,
        staffEmail,
        reason: request.body.reason.trim(),
        minutes: request.body.minutes ?? 60,
        now: at,
      });
      await audit(systemDb, {
        orgId: org.id,
        action: 'support_session_started',
        actor: staffActor(staffEmail, request.ip),
        details: {
          sessionId: session.id,
          reason: session.reason,
          expiresAt: session.expires_at.toISOString(),
        },
      });
      // The Owners hear of it at once (ADR-179).
      let emailed = 0;
      if (settings?.smtp) {
        const owners = await systemDb
          .selectFrom('memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select('u.email')
          .where('m.org_id', '=', org.id)
          .where('m.role', '=', 'owner')
          .execute();
        const mail = supportStartedMail({
          orgName: org.name,
          staffEmail,
          reason: session.reason,
          expiresAt: session.expires_at,
          site,
        });
        for (const o of owners) {
          try {
            await transport(settings.smtp.transport).sendMail({
              from: settings.smtp.from,
              to: o.email,
              ...mail,
            });
            emailed++;
          } catch (err) {
            request.log.warn(
              { orgId: org.id, err: (err as Error).message.slice(0, 200) },
              'support session email not sent',
            );
          }
        }
      }
      request.log.info(
        { orgId: org.id, supportSession: session.id, staff: staffEmail },
        'support session opened',
      );
      const [listed] = await listSupportSessions(systemDb, org.id, 1);
      return reply.code(201).send({
        session: listed!,
        url: `${site}/api/v1/support/enter?code=${encodeURIComponent(code)}`,
        codeExpiresAt: new Date(at.getTime() + SUPPORT_CODE_TTL_MS).toISOString(),
        ownersEmailed: emailed,
      });
    },
  );

  app.get(
    '/internal/admin/orgs/:id/support-sessions',
    {
      schema: {
        summary: "An org's support sessions, newest first, with what each opened",
        params: Params,
        response: {
          200: Type.Object({ sessions: Type.Array(SupportSessionSchema) }),
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const org = await findOrg(request.params.id);
      if (!org) return sendProblem(reply, 404, 'No such org');
      return { sessions: await listSupportSessions(systemDb, org.id) };
    },
  );

  app.delete(
    '/internal/admin/support-sessions/:id',
    {
      schema: {
        summary: 'End a support session now',
        params: Params,
        response: { 204: Type.Null(), 400: ProblemSchema, 401: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const row = UUID.test(id)
        ? await systemDb
            .selectFrom('support_sessions')
            .select(['id', 'org_id'])
            .where('id', '=', id)
            .executeTakeFirst()
        : undefined;
      if (!row) return sendProblem(reply, 404, 'No such support session');
      const ended = await endSupportSession(systemDb, row.id, row.org_id, {
        staffEmail: request.staffEmail!,
        ip: request.ip,
      });
      if (!ended) return sendProblem(reply, 404, 'That support session has already ended');
      return reply.code(204).send(null);
    },
  );
};
