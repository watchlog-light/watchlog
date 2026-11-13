// SPDX-License-Identifier: AGPL-3.0-only
// The connect flow (ADR-133, ADR-134): the drawer tests access before a service is
// monitored (probes the collector tries every 5 s for 15 minutes, or at once on "Check
// now"), and the settings drawer replaces or removes a service's access, pauses it and
// shows its log. Passwords are write-only: no response carries one, except the one-time
// command that creates WatchLog's user, shown once to the person who asked for it.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type, type Static } from 'typebox';
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { sendProblem } from '../../lib/problem.js';
import { requireRole, requireUser } from '../../plugins/auth.js';
import { ProblemSchema } from '../auth/schemas.js';
import type { IntegrationTarget, IntegrationType } from './collector-config.js';
import {
  connectCommand,
  DEFAULT_NAMESPACE,
  fileCommands,
  generatePassword,
  recordEvent,
  rebind,
  sealAccess,
  secretRoleCommands,
  type Access,
} from './credentials.js';
import { SERVICE_KINDS } from './discovery.js';
import type { ConfigNotifier } from './notifier.js';
import { TargetSchema } from './schemas.js';

/** How long a probe is tried (ADR-134: every 5 s for 15 minutes). */
export const PROBE_TTL_MS = 15 * 60 * 1000;

const K8sName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$',
});
const User = Type.String({ minLength: 1, maxLength: 128, pattern: '^[^\\s]+$' });

// One flat object, not a union: the validator strips unknown fields while it tries each
// branch of a union, so a union of strict objects loses fields. checkAccess() below says
// which fields each method needs.
export const AccessSchema = Type.Object(
  {
    method: Type.Union([
      Type.Literal('none'),
      Type.Literal('generated'),
      Type.Literal('entered'),
      Type.Literal('reference'),
    ]),
    username: Type.Optional(User),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 1024, writeOnly: true })),
    /** Kubernetes: a Secret in the collector's namespace and its key. */
    secret: Type.Optional(
      Type.Object(
        {
          name: K8sName,
          key: Type.String({ minLength: 1, maxLength: 253, pattern: '^[-._a-zA-Z0-9]+$' }),
        },
        { additionalProperties: false },
      ),
    ),
    /** Docker: a file under /etc/watchlog/secrets on the host. */
    file: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]*$' }),
    ),
  },
  { additionalProperties: false },
);

/** The access as the code uses it, or why the fields don't fit the method. */
export function checkAccess(
  a: Static<typeof AccessSchema>,
  clusterKind: string,
): { ok: true; access: Access } | { ok: false; message: string } {
  switch (a.method) {
    case 'none':
      return { ok: true, access: { method: 'none' } };
    case 'generated':
      if (a.username !== undefined && !/^[a-z_][a-z0-9_]{0,62}$/.test(a.username)) {
        return { ok: false, message: 'A generated user is lower-case letters, digits and _' };
      }
      return { ok: true, access: { method: 'generated', username: a.username } };
    case 'entered':
      if (!a.username || !a.password) {
        return { ok: false, message: 'An existing user needs its name and password' };
      }
      return {
        ok: true,
        access: { method: 'entered', username: a.username, password: a.password },
      };
    case 'reference':
      if (clusterKind === 'kubernetes' && !a.secret) {
        return { ok: false, message: 'On Kubernetes, name the Secret and its key' };
      }
      if (clusterKind === 'docker' && !a.file) {
        return { ok: false, message: 'On Docker, name the file under /etc/watchlog/secrets' };
      }
      return {
        ok: true,
        access: {
          method: 'reference',
          username: a.username,
          ...(clusterKind === 'kubernetes' ? { secret: a.secret } : { file: a.file }),
        },
      };
  }
}

const ProbeResult = Type.Object({
  ok: Type.Boolean(),
  code: Type.String({
    description:
      'ok, unreachable, auth_failed, permission_missing, credential_unavailable, login_untested or error',
  }),
  error: Type.Union([Type.String(), Type.Null()]),
  version: Type.Union([Type.String(), Type.Null()]),
  facts: Type.Record(
    Type.String(),
    Type.Unsafe<string | number | boolean>({ type: ['number', 'boolean', 'string'] }),
  ),
  excess: Type.Array(Type.String()),
  missing: Type.Array(Type.String()),
});
export const ProbeSchema = Type.Object({
  id: Type.String(),
  /** failed: it expired without working; "Check now" tries again. */
  status: Type.Union([Type.Literal('pending'), Type.Literal('ok'), Type.Literal('failed')]),
  method: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  attempts: Type.Integer(),
  result: Type.Union([ProbeResult, Type.Null()]),
  expiresAt: Type.String(),
});
type ProbeView = Static<typeof ProbeSchema>;

const ProbeBody = Type.Object(
  {
    clusterId: Type.String({ format: 'uuid' }),
    type: Type.Union([
      Type.Literal('redis'),
      Type.Literal('postgres'),
      Type.Literal('nginx'),
      Type.Literal('rabbitmq'),
      Type.Literal('mysql'),
      Type.Literal('mongodb'),
      Type.Literal('traefik'),
      Type.Literal('kafka'),
      Type.Literal('elasticsearch'),
    ]),
    target: TargetSchema,
    collectorHost: Type.Optional(
      Type.String({ maxLength: 253, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' }),
    ),
    /** Testing new access for a service already monitored (the settings drawer). */
    integrationId: Type.Optional(Type.String({ format: 'uuid' })),
    access: AccessSchema,
  },
  { additionalProperties: false },
);

const AccessView = Type.Object({
  method: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  reference: Type.Union([
    Type.Object({
      secret: Type.Optional(
        Type.Object({ namespace: Type.String(), name: Type.String(), key: Type.String() }),
      ),
      file: Type.Optional(Type.String()),
    }),
    Type.Null(),
  ]),
  setBy: Type.Union([Type.String(), Type.Null()]),
  setAt: Type.String(),
  verifiedAt: Type.Union([Type.String(), Type.Null()]),
});
const EventView = Type.Object({
  action: Type.String(),
  user: Type.Union([Type.String(), Type.Null()]),
  /** Owners and Admins only. */
  ip: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  at: Type.String(),
  details: Type.Record(Type.String(), Type.Unknown()),
});

/** Where a service runs, checked against its cluster; the collector that reaches it. */
export async function placementOf(
  db: Database,
  orgId: string,
  body: {
    clusterId: string;
    type: IntegrationType;
    target: IntegrationTarget;
    collectorHost?: string;
  },
): Promise<
  | { ok: true; clusterKind: string; collectorHost: string }
  | { ok: false; status: 400 | 404; message: string }
> {
  const cluster = await db
    .selectFrom('clusters')
    .select(['id', 'kind'])
    .where('id', '=', body.clusterId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!cluster) return { ok: false, status: 404, message: 'Cluster not found' };
  const kind = SERVICE_KINDS.find((k) => k.type === body.type)!;
  if (!kind.available) {
    return {
      ok: false,
      status: 400,
      message: `${body.type} monitoring isn't available in this version yet`,
    };
  }
  const t = body.target;
  const k8sTarget = t.kind === 'workload';
  const dockerTarget = t.kind === 'compose' || t.kind === 'container';
  if ((k8sTarget && cluster.kind !== 'kubernetes') || (dockerTarget && cluster.kind !== 'docker')) {
    return {
      ok: false,
      status: 400,
      message: `A ${t.kind} target doesn't belong to a ${cluster.kind} cluster`,
    };
  }
  let collectorHost = '';
  if (dockerTarget) collectorHost = t.host;
  if (t.kind === 'address' && cluster.kind === 'docker') {
    if (!body.collectorHost) {
      return {
        ok: false,
        status: 400,
        message: 'Name the Docker host whose collector reaches this address',
      };
    }
    collectorHost = body.collectorHost;
  }
  return { ok: true, clusterKind: cluster.kind, collectorHost };
}

/** The collector's namespace and ServiceAccount, as it reported them (Kubernetes). */
export async function collectorIdentity(db: Database, clusterId: string) {
  const row = await db
    .selectFrom('integration_collectors')
    .select('self')
    .where('cluster_id', '=', clusterId)
    .where('host', '=', '')
    .executeTakeFirst();
  const self = (row?.self ?? {}) as { namespace?: string; service_account?: string };
  return {
    namespace: self.namespace || DEFAULT_NAMESPACE,
    serviceAccount: self.service_account || 'watchlog-agent-integrations',
    reported: !!self.namespace,
  };
}

/** A running container of a Compose service, for `docker exec`. */
async function containerOf(db: Database, clusterId: string, t: IntegrationTarget) {
  if (t.kind !== 'compose') return t.kind === 'container' ? t.container : null;
  const rows = await db
    .selectFrom('objects')
    .select(['name', 'spec_summary', 'status_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', 'DockerContainer')
    .where('deleted_at', 'is', null)
    .where('node', '=', t.host)
    .where('namespace', '=', t.compose_project)
    .orderBy('name')
    .execute();
  return (
    rows.find(
      (r) =>
        (r.spec_summary as { compose_service?: string }).compose_service === t.compose_service &&
        (r.status_summary as { state?: string }).state === 'running',
    )?.name ?? null
  );
}

export function probeView(
  row: {
    id: string;
    status: string;
    method: string;
    username: string | null;
    attempts: number;
    result: unknown;
    expires_at: Date;
  },
  now = Date.now(),
): ProbeView {
  const r = row.result as ProbeView['result'];
  return {
    id: row.id,
    status: row.status === 'ok' ? 'ok' : row.expires_at.getTime() <= now ? 'failed' : 'pending',
    method: row.method,
    username: row.username,
    attempts: row.attempts,
    result: r
      ? {
          ok: r.ok,
          code: r.code ?? (r.ok ? 'ok' : 'error'),
          error: r.error ?? null,
          version: r.version ?? null,
          facts: r.facts ?? {},
          excess: r.excess ?? [],
          missing: r.missing ?? [],
        }
      : null,
    expiresAt: row.expires_at.toISOString(),
  };
}

const PROBE_COLUMNS = [
  'id',
  'status',
  'method',
  'username',
  'attempts',
  'result',
  'expires_at',
] as const;

const actor = (request: FastifyRequest) => ({
  user: { id: request.user!.id, name: request.user!.name, email: request.user!.email },
  ip: request.ip,
});

export const connectRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  notifier: ConfigNotifier;
  secretKey: Buffer;
}> = async (app, { db, notifier, secretKey }) => {
  const signedIn = requireUser(db);
  const canManage = [signedIn, requireRole('owner', 'admin')];

  app.post(
    '/applications/probes',
    {
      preHandler: canManage,
      schema: {
        summary: 'Test access to a service before monitoring it (ADR-134)',
        tags: ['applications'],
        body: ProbeBody,
        response: {
          201: Type.Object({
            probe: ProbeSchema,
            /** Option a: the one-time command that creates WatchLog's user, password included. */
            command: Type.Optional(Type.String()),
            /** Option c: the Role and RoleBinding (Kubernetes) or the file (Docker). */
            commands: Type.Optional(Type.Array(Type.String())),
            /** Option c on Docker: the mount the collector needs. */
            mount: Type.Optional(Type.String()),
          }),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const body = request.body;
      const target = body.target as IntegrationTarget;
      const placed = await placementOf(db, orgId, { ...body, target });
      if (!placed.ok) return sendProblem(reply, placed.status, placed.message);
      if (body.integrationId) {
        const owned = await db
          .selectFrom('integrations')
          .select('id')
          .where('id', '=', body.integrationId)
          .where('org_id', '=', orgId)
          .executeTakeFirst();
        if (!owned) return sendProblem(reply, 404, 'Service not found');
      }
      const checked = checkAccess(body.access, placed.clusterKind);
      if (!checked.ok) return sendProblem(reply, 400, checked.message);
      const access = checked.access;
      const id = newId();
      const identity = await collectorIdentity(db, body.clusterId);
      const password = access.method === 'generated' ? generatePassword() : null;
      const sealed =
        access.method === 'none'
          ? { method: 'none' as const, username: null, ciphertext: null, reference: null }
          : sealAccess(secretKey, id, access, password, identity.namespace);
      const now = Date.now();
      await db
        .insertInto('integration_probes')
        .values({
          id,
          org_id: orgId,
          cluster_id: body.clusterId,
          collector_host: placed.collectorHost,
          type: body.type,
          target: JSON.stringify(target),
          integration_id: body.integrationId ?? null,
          method: sealed.method,
          username: sealed.username,
          ciphertext: sealed.ciphertext,
          reference: sealed.reference ? JSON.stringify(sealed.reference) : null,
          expires_at: new Date(now + PROBE_TTL_MS),
          created_by: request.user!.id,
        })
        .execute();
      notifier.notify(body.clusterId);
      const row = await db
        .selectFrom('integration_probes')
        .select(PROBE_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      reply.header('cache-control', 'no-store');
      const extra: { command?: string; commands?: string[]; mount?: string } = {};
      if (password) {
        const command = connectCommand(body.type, target, password, {
          user: sealed.username ?? undefined,
          container: await containerOf(db, body.clusterId, target),
        });
        if (command) extra.command = command;
      }
      if (access.method === 'reference' && access.secret) {
        extra.commands = secretRoleCommands(
          access.secret.name,
          identity.namespace,
          identity.serviceAccount,
        );
      }
      if (access.method === 'reference' && access.file) {
        extra.commands = fileCommands(access.file);
        extra.mount = '-v /etc/watchlog/secrets:/etc/watchlog/secrets:ro';
      }
      return reply.code(201).send({ probe: probeView(row, now), ...extra });
    },
  );

  app.get(
    '/applications/probes/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Where a connection test is',
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({ probe: ProbeSchema }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const row = await db
        .selectFrom('integration_probes')
        .select(PROBE_COLUMNS)
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Probe not found');
      reply.header('cache-control', 'no-store');
      return { probe: probeView(row) };
    },
  );

  app.post(
    '/applications/probes/:id/check',
    {
      preHandler: canManage,
      schema: {
        summary: 'Check now: try a connection test at once, for 15 more minutes',
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({ probe: ProbeSchema }),
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const row = await db
        .updateTable('integration_probes')
        .set({
          requested_at: now,
          expires_at: new Date(now.getTime() + PROBE_TTL_MS),
          status: 'pending',
        })
        .where('id', '=', request.params.id)
        .where('org_id', '=', request.user!.org.id)
        .returning([...PROBE_COLUMNS, 'cluster_id'])
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Probe not found');
      notifier.notify(row.cluster_id);
      return { probe: probeView(row, now.getTime()) };
    },
  );

  app.get(
    '/applications/:id/access',
    {
      preHandler: signedIn,
      schema: {
        summary: "A service's access (never its password), switches and log (ADR-133)",
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({
            access: Type.Union([AccessView, Type.Null()]),
            settings: Type.Object({ queryText: Type.Boolean(), paused: Type.Boolean() }),
            events: Type.Array(EventView),
          }),
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const row = await db
        .selectFrom('integrations as i')
        .leftJoin('integration_credentials as c', 'c.integration_id', 'i.id')
        .leftJoin('users as u', 'u.id', 'c.set_by')
        .select([
          'i.id',
          'i.status',
          'i.settings',
          'c.method',
          'c.username',
          'c.reference',
          'c.set_at',
          'c.verified_at',
          'u.name as set_by_name',
          'u.email as set_by_email',
        ])
        .where('i.id', '=', request.params.id)
        .where('i.org_id', '=', orgId)
        .executeTakeFirst();
      if (!row) return sendProblem(reply, 404, 'Service not found');
      const manager = request.user!.role === 'owner' || request.user!.role === 'admin';
      const events = await db
        .selectFrom('integration_events')
        .select(['action', 'user_name', 'ip', 'at', 'details'])
        .where('integration_id', '=', row.id)
        .where('org_id', '=', orgId)
        .orderBy('at', 'desc')
        .limit(50)
        .execute();
      return {
        access: row.method
          ? {
              method: row.method,
              username: row.username,
              reference: (row.reference as Static<typeof AccessView>['reference']) ?? null,
              setBy: row.set_by_name || row.set_by_email || null,
              setAt: row.set_at!.toISOString(),
              verifiedAt: row.verified_at?.toISOString() ?? null,
            }
          : null,
        settings: {
          queryText: (row.settings as { query_text?: boolean }).query_text !== false,
          paused: row.status === 'paused',
        },
        events: events.map((e) => ({
          action: e.action,
          user: e.user_name,
          ...(manager ? { ip: e.ip } : {}),
          at: e.at.toISOString(),
          details: e.details as Record<string, unknown>,
        })),
      };
    },
  );

  app.put(
    '/applications/:id/access',
    {
      preHandler: canManage,
      schema: {
        summary: "Replace a service's access with one a probe tested",
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          { probeId: Type.String({ format: 'uuid' }) },
          { additionalProperties: false },
        ),
        response: {
          204: Type.Null(),
          400: ProblemSchema,
          401: ProblemSchema,
          403: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const result = await adoptProbe(db, secretKey, {
        orgId,
        integrationId: request.params.id,
        probeId: request.body.probeId,
        userId: request.user!.id,
      });
      if (!result.ok) return sendProblem(reply, result.status, result.message);
      await recordEvent(db, {
        orgId,
        integrationId: request.params.id,
        action: result.replaced ? 'credential_replaced' : 'credential_set',
        details: { method: result.method },
        ...actor(request),
      });
      notifier.notify(result.clusterId);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/applications/:id/access',
    {
      preHandler: canManage,
      schema: {
        summary: "Remove a service's stored access",
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const svc = await db
        .selectFrom('integrations')
        .select(['id', 'cluster_id'])
        .where('id', '=', request.params.id)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!svc) return sendProblem(reply, 404, 'Service not found');
      const gone = await db
        .deleteFrom('integration_credentials')
        .where('integration_id', '=', svc.id)
        .returning('method')
        .executeTakeFirst();
      if (gone) {
        await recordEvent(db, {
          orgId,
          integrationId: svc.id,
          action: 'credential_removed',
          details: { method: gone.method },
          ...actor(request),
        });
        notifier.notify(svc.cluster_id);
      }
      return reply.code(204).send(null);
    },
  );

  app.patch(
    '/applications/:id',
    {
      preHandler: canManage,
      schema: {
        summary: 'Pause or resume a service, or switch query text (ADR-138)',
        tags: ['applications'],
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          { paused: Type.Optional(Type.Boolean()), queryText: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null(), 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.user!.org.id;
      const svc = await db
        .selectFrom('integrations')
        .select(['id', 'cluster_id', 'status', 'settings'])
        .where('id', '=', request.params.id)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!svc) return sendProblem(reply, 404, 'Service not found');
      const { paused, queryText } = request.body;
      const settings = svc.settings as { query_text?: boolean };
      const wasPaused = svc.status === 'paused';
      await db
        .updateTable('integrations')
        .set({
          ...(paused === undefined || paused === wasPaused
            ? {}
            : paused
              ? { status: 'paused' }
              : { status: 'pending', status_details: '{}' }),
          ...(queryText === undefined
            ? {}
            : { settings: JSON.stringify({ ...settings, query_text: queryText }) }),
        })
        .where('id', '=', svc.id)
        .execute();
      if (paused !== undefined && paused !== wasPaused) {
        await recordEvent(db, {
          orgId,
          integrationId: svc.id,
          action: paused ? 'paused' : 'resumed',
          ...actor(request),
        });
      }
      if (queryText !== undefined && queryText !== (settings.query_text !== false)) {
        await recordEvent(db, {
          orgId,
          integrationId: svc.id,
          action: 'settings_changed',
          details: { queryText },
          ...actor(request),
        });
      }
      notifier.notify(svc.cluster_id);
      return reply.code(204).send(null);
    },
  );
};

/**
 * Gives a monitored service the access a probe tested: the sealed password is moved to
 * the service's row (re-bound to its id) and the probe is removed.
 */
export async function adoptProbe(
  db: Database,
  key: Buffer,
  p: { orgId: string; integrationId: string; probeId: string; userId: string },
): Promise<
  | { ok: true; replaced: boolean; method: string; clusterId: string }
  | { ok: false; status: 400 | 404; message: string }
> {
  return db.transaction().execute(async (trx) => {
    const svc = await trx
      .selectFrom('integrations')
      .select(['id', 'cluster_id', 'type', 'collector_host'])
      .where('id', '=', p.integrationId)
      .where('org_id', '=', p.orgId)
      .executeTakeFirst();
    if (!svc) return { ok: false as const, status: 404 as const, message: 'Service not found' };
    const probe = await trx
      .selectFrom('integration_probes')
      .selectAll()
      .where('id', '=', p.probeId)
      .where('org_id', '=', p.orgId)
      .executeTakeFirst();
    if (!probe) return { ok: false as const, status: 404 as const, message: 'Probe not found' };
    if (
      probe.cluster_id !== svc.cluster_id ||
      probe.type !== svc.type ||
      probe.collector_host !== svc.collector_host
    ) {
      return {
        ok: false as const,
        status: 400 as const,
        message: 'This probe tested another service',
      };
    }
    const existing = await trx
      .selectFrom('integration_credentials')
      .select('method')
      .where('integration_id', '=', svc.id)
      .executeTakeFirst();
    await trx.deleteFrom('integration_credentials').where('integration_id', '=', svc.id).execute();
    if (probe.method !== 'none') {
      const sealed = rebind(key, probe.id, svc.id, probe);
      await trx
        .insertInto('integration_credentials')
        .values({
          integration_id: svc.id,
          method: sealed.method,
          username: sealed.username,
          ciphertext: sealed.ciphertext,
          reference: sealed.reference ? JSON.stringify(sealed.reference) : null,
          set_by: p.userId,
          verified_at: probe.status === 'ok' ? new Date() : null,
        })
        .execute();
    }
    await trx.deleteFrom('integration_probes').where('id', '=', probe.id).execute();
    return {
      ok: true as const,
      replaced: !!existing,
      method: probe.method,
      clusterId: svc.cluster_id,
    };
  });
}
