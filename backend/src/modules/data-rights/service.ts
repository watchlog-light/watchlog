// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's data rights and inactive orgs (ADR-181):
//   - the org's state for the dashboard's banners (deletion pending, inactivity warning,
//     suspension), read under the org;
//   - the configuration export, read under the org (Row-Level Security), never a secret;
//   - the deletions the worker runs after the 7-day undo, and the inactive Free orgs it
//     warns and then suspends. Both work across orgs, so on the owner's connection
//     (systemDb, allow-listed in test/isolation/guards.test.ts).
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { authorisedScope, type VictoriaClient } from '../../lib/victoria.js';
import { transport } from '../alerts/channels.js';
import type { AlertingSettings } from '../settings/service.js';
import { audit } from '../users/service.js';

const DAY = 86_400_000;
/** How long an Owner can undo a deletion. */
export const DELETION_UNDO_MS = 7 * DAY;
/** A Free org with no data this long is warned … */
export const INACTIVE_WARN_MS = 30 * DAY;
/** … and suspended this long after the warning, unless data arrives. */
export const INACTIVE_SUSPEND_MS = 7 * DAY;
export const DATA_RIGHTS_EVERY_MS = 60 * 60_000;

export interface OrgStatus {
  deletion: { requestedAt: string; dueAt: string; requestedBy: string | null } | null;
  suspension: { at: string; kind: 'staff' | 'inactive'; reason: string | null } | null;
  inactivity: { warnedAt: string; suspendsAt: string } | null;
  lastDataAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The last heartbeat of any of the org's agents. */
async function lastDataAt(db: Database, orgId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('agent_instances')
    .select((eb) => eb.fn.max('last_seen_at').as('at'))
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  return (row?.at as Date | null | undefined) ?? null;
}

/** The banners' facts, under the request's org. */
export async function orgStatus(db: Database, orgId: string): Promise<OrgStatus> {
  const org = await db
    .selectFrom('orgs as o')
    .leftJoin('users as u', 'u.id', 'o.deletion_requested_by')
    .select([
      'o.deletion_requested_at',
      'o.deletion_due_at',
      'u.name as requested_by_name',
      'u.email as requested_by_email',
      'o.suspended_at',
      'o.suspended_reason',
      'o.suspension_kind',
      'o.inactive_warned_at',
    ])
    .where('o.id', '=', orgId)
    .executeTakeFirstOrThrow();
  return {
    deletion:
      org.deletion_requested_at && org.deletion_due_at
        ? {
            requestedAt: org.deletion_requested_at.toISOString(),
            dueAt: org.deletion_due_at.toISOString(),
            requestedBy: org.requested_by_name || org.requested_by_email || null,
          }
        : null,
    suspension: org.suspended_at
      ? {
          at: org.suspended_at.toISOString(),
          kind: org.suspension_kind === 'inactive' ? 'inactive' : 'staff',
          reason: org.suspended_reason,
        }
      : null,
    inactivity:
      org.inactive_warned_at && !org.suspended_at
        ? {
            warnedAt: org.inactive_warned_at.toISOString(),
            suspendsAt: new Date(
              org.inactive_warned_at.getTime() + INACTIVE_SUSPEND_MS,
            ).toISOString(),
          }
        : null,
    lastDataAt: iso(await lastDataAt(db, orgId)),
  };
}

// ---------------------------------------------------------------- the configuration export

export const EXPORT_FORMAT = 'watchlog-org-export/1';

/**
 * The org's configuration as JSON: the org and its plan, members, clusters (with token
 * prefixes, never hashes), alert rules, channels (their visible settings: never a Slack URL,
 * bot token or signing secret), silences, applications (never credentials), API tokens
 * (names and prefixes) and the discovery choices. Every read is under the org (RLS).
 */
export async function buildExport(db: Database, orgId: string, now = new Date()) {
  const [
    org,
    plan,
    members,
    clusters,
    tokens,
    rules,
    channels,
    silences,
    apps,
    apiTokens,
    ignores,
  ] = await Promise.all([
    db
      .selectFrom('orgs')
      .select(['id', 'name', 'slug', 'plan', 'created_at'])
      .where('id', '=', orgId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('entitlements')
      .select([
        'plan',
        'source',
        'clusters',
        'nodes',
        'users',
        'retention_days',
        'pro_features',
        'beta_until',
      ])
      .where('org_id', '=', orgId)
      .executeTakeFirst(),
    db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.email', 'u.name', 'm.role', 'm.created_at'])
      .where('m.org_id', '=', orgId)
      .orderBy('m.created_at')
      .execute(),
    db
      .selectFrom('clusters')
      .select([
        'id',
        'name',
        'kind',
        'status',
        'agent_version',
        'k8s_version',
        'node_count',
        'first_seen_at',
        'last_seen_at',
        'created_at',
      ])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('cluster_tokens')
      .select(['cluster_id', 'prefix', 'created_at', 'revoked_at'])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('alert_rules')
      .select([
        'id',
        'cluster_id',
        'name',
        'type',
        'rule_key',
        'default_key',
        'metric',
        'scope',
        'condition',
        'for_seconds',
        'renotify_seconds',
        'severity',
        'enabled',
        'channel_ids',
        'created_at',
      ])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('alert_channels')
      .select(['id', 'type', 'name', 'config', 'verified_at', 'created_at'])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('silences')
      .select(['id', 'matchers', 'starts_at', 'ends_at', 'comment', 'created_at'])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('integrations')
      .select([
        'id',
        'cluster_id',
        'type',
        'name',
        'target',
        'settings',
        'status',
        'monitored_since',
        'created_at',
      ])
      .where('org_id', '=', orgId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('api_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select([
        't.name',
        't.prefix',
        't.scope',
        'u.email as user',
        't.created_at',
        't.expires_at',
        't.revoked_at',
      ])
      .where('t.org_id', '=', orgId)
      .orderBy('t.created_at')
      .execute(),
    db
      .selectFrom('discovery_ignores')
      .select(['cluster_id', 'service_key', 'group_name', 'label', 'created_at'])
      .where('org_id', '=', orgId)
      .execute(),
  ]);
  // Only what a channel shows anyway: recipients, a webhook's URL, the bot and chat names.
  const visible = (config: unknown) => {
    const c = (config ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ['recipients', 'url', 'botName', 'chatName']) if (k in c) out[k] = c[k];
    return out;
  };
  return {
    format: EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.created_at },
    plan: plan
      ? {
          plan: plan.plan,
          source: plan.source,
          limits: {
            clusters: plan.clusters,
            nodes: plan.nodes,
            users: plan.users,
            retentionDays: plan.retention_days,
          },
          proFeatures: plan.pro_features,
          betaUntil: plan.beta_until,
        }
      : { plan: org.plan },
    members: members.map((m) => ({
      email: m.email,
      name: m.name,
      role: m.role,
      joinedAt: m.created_at,
    })),
    clusters: clusters.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      status: c.status,
      agentVersion: c.agent_version,
      kubernetesVersion: c.k8s_version,
      nodes: c.node_count,
      firstSeenAt: c.first_seen_at,
      lastSeenAt: c.last_seen_at,
      createdAt: c.created_at,
      tokens: tokens
        .filter((t) => t.cluster_id === c.id)
        .map((t) => ({ prefix: t.prefix, createdAt: t.created_at, revokedAt: t.revoked_at })),
    })),
    alertRules: rules.map((r) => ({
      id: r.id,
      clusterId: r.cluster_id,
      name: r.name,
      type: r.type,
      key: r.rule_key,
      defaultKey: r.default_key,
      metric: r.metric,
      scope: r.scope,
      condition: r.condition,
      forSeconds: r.for_seconds,
      renotifySeconds: r.renotify_seconds,
      severity: r.severity,
      enabled: r.enabled,
      channelIds: r.channel_ids,
      createdAt: r.created_at,
    })),
    channels: channels.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      settings: visible(c.config),
      verifiedAt: c.verified_at,
      createdAt: c.created_at,
    })),
    silences: silences.map((s) => ({
      id: s.id,
      matchers: s.matchers,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      comment: s.comment,
      createdAt: s.created_at,
    })),
    applications: apps.map((a) => ({
      id: a.id,
      clusterId: a.cluster_id,
      type: a.type,
      name: a.name,
      target: a.target,
      settings: a.settings,
      status: a.status,
      monitoredSince: a.monitored_since,
      createdAt: a.created_at,
    })),
    apiTokens: apiTokens.map((t) => ({
      name: t.name,
      prefix: t.prefix,
      scope: t.scope,
      user: t.user,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
      revokedAt: t.revoked_at,
    })),
    discoveryIgnores: ignores.map((i) => ({
      clusterId: i.cluster_id,
      serviceKey: i.service_key,
      group: i.group_name,
      label: i.label,
      createdAt: i.created_at,
    })),
  };
}

// ---------------------------------------------------------------- emails to the Owners

export interface MailDeps {
  systemDb: Database;
  settings: () => Promise<Pick<AlertingSettings, 'smtp' | 'publicUrl'>>;
  /** WATCHLOG_LIFECYCLE_FROM; the email server's own sender otherwise. */
  from?: string;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/**
 * A service notice to the org's Owners with a verified address (no unsubscribe: it is about
 * their data). Answers how many were sent; never throws.
 */
export async function mailOwners(
  deps: MailDeps,
  orgId: string,
  mail: (site: string) => { subject: string; text: string },
): Promise<number> {
  try {
    const s = await deps.settings();
    if (!s.smtp || !s.publicUrl) return 0;
    const owners = await deps.systemDb
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.email'])
      .where('m.org_id', '=', orgId)
      .where('m.role', '=', 'owner')
      .where('u.email_verified_at', 'is not', null)
      .where('u.disabled_at', 'is', null)
      .execute();
    if (owners.length === 0) return 0;
    const m = mail(s.publicUrl.replace(/\/+$/, ''));
    const from = deps.from ?? s.smtp.from;
    let sent = 0;
    for (const o of owners) {
      await transport(s.smtp.transport).sendMail({
        from,
        replyTo: from,
        to: o.email,
        subject: m.subject,
        text: m.text,
      });
      sent++;
    }
    return sent;
  } catch (err) {
    deps.log.warn({ orgId, err: (err as Error).message.slice(0, 200) }, 'owner notice not sent');
    return 0;
  }
}

const day = (d: Date) =>
  d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const notices = {
  deletionRequested: (org: string, due: Date, by: string) => (site: string) => ({
    subject: `${org} will be deleted on ${day(due)}`,
    text: `${by} asked to delete the WatchLog organization ${org}.\n\nIts agents' data is no longer stored. On ${day(due)} (UTC) its clusters, alert rules, channels, members and metrics are deleted for good.\n\nChanged your mind? An Owner can undo it until then: ${site}/settings?tab=data\n\nDownload what you want to keep first: ${site}/settings?tab=data\n`,
  }),
  inactiveWarning: (org: string, suspendsAt: Date) => (site: string) => ({
    subject: `${org} has sent no data for 30 days`,
    text: `The WatchLog organization ${org} has received no data from any agent for 30 days.\n\nOn ${day(suspendsAt)} (UTC) it will be suspended: agents' data won't be stored. Your data and settings stay; you can still sign in, export it or delete the organization.\n\nTo keep it active, start an agent again before then: ${site}/\nIf you don't need it any more, you can delete it: ${site}/settings?tab=data\n`,
  }),
  inactiveSuspended: (org: string) => (site: string) => ({
    subject: `${org} is suspended after 37 days without data`,
    text: `The WatchLog organization ${org} received no data for 37 days, so it is now suspended: agents' data isn't stored.\n\nYou can still sign in. An Owner can reactivate it, export its data or delete it: ${site}/settings?tab=data\n`,
  }),
};

// ---------------------------------------------------------------- deletions (the worker)

export interface DeletionDeps extends MailDeps {
  victoria?: VictoriaClient;
}

/**
 * Deletes the orgs whose undo window is over: each cluster's series in VictoriaMetrics (both
 * tiers), then the org's rows (every tenant table cascades from orgs), the accounts left
 * without any org, and records it in org_deletions. The org row stays locked meanwhile, so
 * an undo either happens before (and nothing is deleted) or waits and finds it gone.
 * Answers the orgs deleted.
 */
export async function runDeletions(deps: DeletionDeps, nowMs: number): Promise<string[]> {
  const now = new Date(nowMs);
  const due = await deps.systemDb
    .selectFrom('orgs')
    .select('id')
    .where('deletion_due_at', '<=', now)
    .orderBy('deletion_due_at')
    .limit(20)
    .execute();
  const deleted: string[] = [];
  for (const { id } of due) {
    try {
      const done = await deps.systemDb.transaction().execute(async (trx) => {
        const org = await trx
          .selectFrom('orgs')
          .select(['id', 'name', 'deletion_requested_at', 'deletion_requested_by'])
          .where('id', '=', id)
          .where('deletion_due_at', '<=', now)
          .forUpdate()
          .executeTakeFirst();
        if (!org) return false; // undone meanwhile
        const clusters = await trx
          .selectFrom('clusters')
          .select('id')
          .where('org_id', '=', id)
          .execute();
        const series: Record<string, number> = {};
        for (const c of clusters) {
          if (!deps.victoria) throw new Error('VICTORIAMETRICS_URL is not set');
          // The cluster is this org's own row: no request names it (ADR-174's allow-list).
          const counts = await deps.victoria.deleteSeries(authorisedScope(c.id), nowMs);
          for (const [tier, n] of Object.entries(counts)) series[tier] = (series[tier] ?? 0) + n;
        }
        // Accounts whose only org this is go with it; members of other orgs stay.
        const alone = await trx
          .selectFrom('memberships as m')
          .select('m.user_id')
          .where('m.org_id', '=', id)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom('memberships as o')
                  .select('o.id')
                  .whereRef('o.user_id', '=', 'm.user_id')
                  .where('o.org_id', '<>', id),
              ),
            ),
          )
          .execute();
        // Token hashes outlive the clusters, as when a cluster is deleted (ADR-069): an agent
        // still running can't recreate one through the Helm bootstrap.
        await trx
          .insertInto('retired_cluster_tokens')
          .columns(['token_hash'])
          .expression((eb) =>
            eb.selectFrom('cluster_tokens').select('token_hash').where('org_id', '=', id),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
        await trx.deleteFrom('orgs').where('id', '=', id).execute();
        const users = alone.map((u) => u.user_id);
        if (users.length) await trx.deleteFrom('users').where('id', 'in', users).execute();
        await trx
          .insertInto('org_deletions')
          .values({
            deleted_org_id: id,
            org_name: org.name,
            requested_at: org.deletion_requested_at!,
            requested_by: org.deletion_requested_by,
            deleted_at: now,
            cluster_ids: clusters.map((c) => c.id),
            users_deleted: users.length,
            series: JSON.stringify(series),
          })
          .execute();
        deps.log.info(
          { orgId: id, clusters: clusters.length, users: users.length, series },
          'org deleted',
        );
        return true;
      });
      if (done) deleted.push(id);
    } catch (err) {
      deps.log.warn(
        { orgId: id, err: (err as Error).message.slice(0, 200) },
        'org deletion failed; retrying at the next run',
      );
    }
  }
  return deleted;
}

// ---------------------------------------------------------------- inactive Free orgs

export interface InactivityDeps extends MailDeps {
  /** Clears the ingest cache of an org this process suspended. */
  invalidate?: (orgId: string) => void;
}

/**
 * Free orgs without data for 30 days get a warning (email, banner); 7 days later, still
 * without data, they are suspended (ingest 402; sign-in, export and deletion still work).
 * Data arriving after the warning, or a plan other than Free, cancels it. The days count
 * from the last heartbeat, the org's creation, or a lifted suspension, whichever is last.
 */
export async function runInactivity(
  deps: InactivityDeps,
  nowMs: number,
): Promise<{ warned: string[]; suspended: string[]; cleared: string[] }> {
  const now = new Date(nowMs);
  const out = { warned: [] as string[], suspended: [] as string[], cleared: [] as string[] };
  const rows = await deps.systemDb
    .selectFrom('orgs as o')
    .leftJoin('entitlements as e', 'e.org_id', 'o.id')
    .select((eb) => [
      'o.id',
      'o.name',
      'o.created_at',
      'o.inactive_warned_at',
      'o.inactivity_reset_at',
      sql<string>`coalesce(e.plan, 'free')`.as('plan'),
      eb
        .selectFrom('agent_instances as a')
        .select((e) => e.fn.max('a.last_seen_at').as('at'))
        .whereRef('a.org_id', '=', 'o.id')
        .as('last_data_at'),
    ])
    .where('o.suspended_at', 'is', null)
    .where('o.deletion_requested_at', 'is', null)
    .where('o.plan', '<>', 'community')
    .execute();
  for (const o of rows) {
    const last = Math.max(
      o.created_at.getTime(),
      o.inactivity_reset_at?.getTime() ?? 0,
      (o.last_data_at as Date | null)?.getTime() ?? 0,
    );
    const warned = o.inactive_warned_at;
    if (warned && (o.plan !== 'free' || last > warned.getTime())) {
      await deps.systemDb
        .updateTable('orgs')
        .set({ inactive_warned_at: null })
        .where('id', '=', o.id)
        .execute();
      out.cleared.push(o.id);
      continue;
    }
    if (o.plan !== 'free') continue;
    if (!warned && nowMs - last >= INACTIVE_WARN_MS) {
      const claimed = await deps.systemDb
        .updateTable('orgs')
        .set({ inactive_warned_at: now })
        .where('id', '=', o.id)
        .where('inactive_warned_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;
      await audit(deps.systemDb, {
        orgId: o.id,
        action: 'org_inactive_warned',
        actor: null,
        details: { lastDataAt: new Date(last).toISOString() },
      });
      await mailOwners(
        deps,
        o.id,
        notices.inactiveWarning(o.name, new Date(nowMs + INACTIVE_SUSPEND_MS)),
      );
      out.warned.push(o.id);
      continue;
    }
    if (warned && nowMs - warned.getTime() >= INACTIVE_SUSPEND_MS) {
      const days = Math.floor((nowMs - last) / DAY);
      const claimed = await deps.systemDb
        .updateTable('orgs')
        .set({
          suspended_at: now,
          suspension_kind: 'inactive',
          suspended_reason: `No data for ${days} days`,
        })
        .where('id', '=', o.id)
        .where('suspended_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) continue;
      deps.invalidate?.(o.id);
      await audit(deps.systemDb, {
        orgId: o.id,
        action: 'org_inactive_suspended',
        actor: null,
        details: { days },
      });
      await mailOwners(deps, o.id, notices.inactiveSuspended(o.name));
      out.suspended.push(o.id);
    }
  }
  return out;
}
