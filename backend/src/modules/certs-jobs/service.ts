// SPDX-License-Identifier: AGPL-3.0-only
// Certificates and scheduled jobs as the pages, the API and MCP read them (0.10.0, ADR-224):
// bounded reads, scoped to the cluster (and the server, where one is named).
import type { Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { ScheduledJobs } from '../../db/types.js';

/** The default rules' thresholds (ADR-225), for a certificate's status on the pages. */
export const CERT_WARNING_DAYS = 14;
export const CERT_CRITICAL_DAYS = 3;

export type CertStatus = 'expired' | 'expires_soon' | 'expiring' | 'problem' | 'ok';

export interface CertificateView {
  id: string;
  node: string;
  names: string[];
  subject: string;
  issuer: string;
  issuerOrg: string;
  notBefore: number;
  notAfter: number;
  daysLeft: number;
  status: CertStatus;
  chain: string;
  nameMismatch: string[];
  keyType: string;
  keyBits: number;
  fingerprint: string;
  endpoints: {
    kind: string;
    workload: string;
    port: number;
    proto: string;
    sni: string | null;
  }[];
  firstSeen: number;
  /** The last renewal seen under this identity: days before the old one expired. */
  renewedDaysBefore: number | null;
  renewedAt: number | null;
  /** The job that renews it, when WatchLog sees one on the same server (certbot, acme.sh). */
  renewalJob: { id: string; name: string; state: string } | null;
}

export interface JobView {
  id: string;
  node: string;
  kind: string;
  name: string;
  unit: string;
  schedule: string;
  source: string;
  enabled: boolean;
  persistent: boolean;
  randomDelaySec: number;
  nextAt: number | null;
  everySec: number;
  state: string;
  failedStreak: number;
  lastGoodAt: number | null;
  missedRuns: number;
  missedWhy: string | null;
  missedAt: number | null;
  usualSeconds: number | null;
  frequent: boolean;
  lastRun: RunView | null;
  updatedAt: number;
}

export interface RunView {
  startedAt: number;
  endedAt: number | null;
  seconds: number | null;
  code: number | null;
  result: string;
}

export interface CoverageView {
  node: string;
  receivedAt: number;
  certificates: Record<string, unknown> | null;
  jobs: Record<string, unknown> | null;
}

const unix = (d: Date | string | null | undefined) =>
  d ? Math.floor(new Date(d).getTime() / 1000) : null;

/** A certificate's status from the seconds it has left (negative once expired). */
export function certStatus(secondsLeft: number, chain: string, mismatch: string[]): CertStatus {
  if (secondsLeft < 0) return 'expired';
  if (secondsLeft < CERT_CRITICAL_DAYS * 86_400) return 'expires_soon';
  if (secondsLeft < CERT_WARNING_DAYS * 86_400) return 'expiring';
  if (chain === 'incomplete' || mismatch.length > 0) return 'problem';
  return 'ok';
}

const STATUS_ORDER: CertStatus[] = ['expired', 'expires_soon', 'expiring', 'problem', 'ok'];
const JOB_ORDER = ['failed', 'missed', 'slow', 'running', 'working', 'new', 'disabled'];

/** Jobs that renew certificates: certbot's timers and cron lines, acme.sh's. */
const RENEWAL_JOB =
  /^(certbot|certbot-renew|snap\.certbot\.renew)\.timer$|^certbot( \(\d+\))?$|^acme\.sh( \(\d+\))?$/;

function runView(r: {
  started_at: Date | string;
  ended_at: Date | string | null;
  code: number | null;
  result: string;
}): RunView {
  const s = unix(r.started_at)!;
  const e = unix(r.ended_at);
  return {
    startedAt: s,
    endedAt: e,
    seconds: e === null ? null : e - s,
    code: r.code,
    result: r.result,
  };
}

export async function listCertificates(
  db: Database,
  clusterId: string,
  node?: string,
  now = new Date(),
): Promise<CertificateView[]> {
  let q = db
    .selectFrom('certificates')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('current', '=', true);
  if (node !== undefined) q = q.where('node', '=', node);
  const rows = await q.orderBy('not_after').limit(1000).execute();
  // The last renewal seen under each identity.
  let rq = db
    .selectFrom('certificates')
    .select(['node', 'cert_id', 'renewed_days_before', 'first_seen'])
    .where('cluster_id', '=', clusterId)
    .where('renewed_from', 'is not', null);
  if (node !== undefined) rq = rq.where('node', '=', node);
  const renewals = new Map<string, { days: number; at: number }>();
  for (const r of await rq.orderBy('first_seen').limit(5000).execute()) {
    renewals.set(`${r.node}/${r.cert_id}`, {
      days: r.renewed_days_before ?? 0,
      at: unix(r.first_seen)!,
    });
  }
  let jq = db
    .selectFrom('scheduled_jobs')
    .select(['node', 'job_id', 'name', 'state'])
    .where('cluster_id', '=', clusterId)
    .where('gone_at', 'is', null);
  if (node !== undefined) jq = jq.where('node', '=', node);
  const renewers = new Map<string, { id: string; name: string; state: string }>();
  for (const j of await jq.limit(5000).execute()) {
    if (RENEWAL_JOB.test(j.name) && !renewers.has(j.node)) {
      renewers.set(j.node, { id: j.job_id, name: j.name, state: j.state });
    }
  }
  const out = rows.map((r): CertificateView => {
    const notAfter = unix(r.not_after)!;
    const secondsLeft = notAfter - now.getTime() / 1000;
    // Whole days, toward zero: "1 day left", "expired 1 day ago".
    const daysLeft = Math.trunc(secondsLeft / 86_400) || 0;
    const ren = renewals.get(`${r.node}/${r.cert_id}`);
    const eps =
      (r.endpoints as {
        kind: string;
        workload: string;
        port: number;
        proto: string;
        sni?: string;
      }[]) ?? [];
    return {
      id: r.cert_id,
      node: r.node,
      names: r.names,
      subject: r.subject,
      issuer: r.issuer,
      issuerOrg: r.issuer_org,
      notBefore: unix(r.not_before)!,
      notAfter,
      daysLeft,
      status: certStatus(secondsLeft, r.chain, r.name_mismatch),
      chain: r.chain,
      nameMismatch: r.name_mismatch,
      keyType: r.key_type,
      keyBits: r.key_bits,
      fingerprint: r.fingerprint,
      endpoints: eps.map((e) => ({
        kind: e.kind,
        workload: e.workload,
        port: e.port,
        proto: e.proto,
        sni: e.sni ?? null,
      })),
      firstSeen: unix(r.first_seen)!,
      renewedDaysBefore: ren?.days ?? null,
      renewedAt: ren?.at ?? null,
      renewalJob: renewers.get(r.node) ?? null,
    };
  });
  out.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.notAfter - b.notAfter,
  );
  return out;
}

/** Every certificate seen under one identity, newest first (renewals). */
export async function certificateHistory(
  db: Database,
  clusterId: string,
  node: string,
  certId: string,
) {
  const rows = await db
    .selectFrom('certificates')
    .select([
      'fingerprint',
      'not_before',
      'not_after',
      'issuer',
      'serial',
      'first_seen',
      'last_seen',
      'current',
      'renewed_days_before',
    ])
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('cert_id', '=', certId)
    .orderBy('first_seen', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    notBefore: unix(r.not_before)!,
    notAfter: unix(r.not_after)!,
    issuer: r.issuer,
    serial: r.serial,
    firstSeen: unix(r.first_seen)!,
    lastSeen: unix(r.last_seen)!,
    current: r.current,
    renewedDaysBefore: r.renewed_days_before,
  }));
}

export async function listJobs(db: Database, clusterId: string, node?: string): Promise<JobView[]> {
  let q = db
    .selectFrom('scheduled_jobs')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('gone_at', 'is', null);
  if (node !== undefined) q = q.where('node', '=', node);
  const rows = await q.limit(5000).execute();
  // Each job's last run.
  let lq = db
    .selectFrom('job_runs')
    .distinctOn(['node', 'job_id'])
    .select(['node', 'job_id', 'started_at', 'ended_at', 'code', 'result'])
    .where('cluster_id', '=', clusterId);
  if (node !== undefined) lq = lq.where('node', '=', node);
  const last = new Map<string, RunView>();
  for (const r of await lq
    .orderBy('node')
    .orderBy('job_id')
    .orderBy('started_at', 'desc')
    .execute()) {
    last.set(`${r.node}/${r.job_id}`, runView(r));
  }
  const out = rows.map((r) => jobView(r, last.get(`${r.node}/${r.job_id}`) ?? null));
  out.sort(
    (a, b) =>
      JOB_ORDER.indexOf(a.state) - JOB_ORDER.indexOf(b.state) ||
      a.node.localeCompare(b.node) ||
      a.name.localeCompare(b.name),
  );
  return out;
}

type JobRow = Selectable<ScheduledJobs>;

function jobView(r: JobRow, lastRun: RunView | null): JobView {
  return {
    id: r.job_id,
    node: r.node,
    kind: r.kind,
    name: r.name,
    unit: r.unit,
    schedule: r.schedule,
    source: r.source,
    enabled: r.enabled,
    persistent: r.persistent,
    randomDelaySec: r.random_delay_sec,
    nextAt: unix(r.next_at),
    everySec: Number(r.every_sec),
    state: r.state,
    failedStreak: r.failed_streak,
    lastGoodAt: unix(r.last_good_at),
    missedRuns: r.missed_runs,
    missedWhy: r.missed_why,
    missedAt: unix(r.missed_at),
    usualSeconds: r.usual_seconds,
    frequent: r.frequent,
    lastRun,
    updatedAt: unix(r.updated_at)!,
  };
}

/** One job, its runs (newest first) and its hourly counts over the last 30 days. */
export async function jobDetail(db: Database, clusterId: string, node: string, jobId: string) {
  const row = await db
    .selectFrom('scheduled_jobs')
    .selectAll()
    .where('cluster_id', '=', clusterId)
    .where('node', '=', node)
    .where('job_id', '=', jobId)
    .executeTakeFirst();
  if (!row) return null;
  const runs = (
    await db
      .selectFrom('job_runs')
      .select(['started_at', 'ended_at', 'code', 'result'])
      .where('cluster_id', '=', clusterId)
      .where('node', '=', node)
      .where('job_id', '=', jobId)
      .orderBy('started_at', 'desc')
      .limit(100)
      .execute()
  ).map(runView);
  const hours = (
    await db
      .selectFrom('job_run_hours')
      .select(['hour', 'runs', 'failures', 'longest_seconds'])
      .where('cluster_id', '=', clusterId)
      .where('node', '=', node)
      .where('job_id', '=', jobId)
      .orderBy('hour', 'desc')
      .limit(720)
      .execute()
  ).map((h) => ({
    hour: unix(h.hour)!,
    runs: h.runs,
    failures: h.failures,
    longestSeconds: h.longest_seconds,
  }));
  return { job: jobView(row, runs[0] ?? null), runs, hours };
}

export async function coverage(
  db: Database,
  clusterId: string,
  node?: string,
): Promise<CoverageView[]> {
  let q = db
    .selectFrom('inventory_coverage')
    .select(['node', 'received_at', 'certificates', 'jobs'])
    .where('cluster_id', '=', clusterId);
  if (node !== undefined) q = q.where('node', '=', node);
  return (await q.orderBy('node').limit(5000).execute()).map((r) => ({
    node: r.node,
    receivedAt: unix(r.received_at)!,
    certificates: (r.certificates as Record<string, unknown> | null) ?? null,
    jobs: (r.jobs as Record<string, unknown> | null) ?? null,
  }));
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/** Whether an agent version reads certificates and jobs (0.10.0 and later; dev builds do). */
export function agentHasInventory(version: string): boolean {
  const m = VERSION.exec(version);
  if (!m) return true;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 10;
}

/**
 * The agents seen within the last hour that are older than 0.10 ("needs agent 0.10"): a
 * server's own agent, or a cluster's cluster-agent.
 */
export async function agentsNeedingUpgrade(
  db: Database,
  clusterId: string,
  kind: string,
  now = new Date(),
): Promise<{ node: string; version: string }[]> {
  const rows = await db
    .selectFrom('agent_instances')
    .select(['node', 'agent_version', 'mode'])
    .where('cluster_id', '=', clusterId)
    .where('last_seen_at', '>', new Date(now.getTime() - 3_600_000))
    .limit(5000)
    .execute();
  return rows
    .filter((r) => (kind === 'kubernetes' ? r.mode === 'cluster' : r.mode !== 'cluster'))
    .filter((r) => !agentHasInventory(r.agent_version))
    .map((r) => ({ node: r.node, version: r.agent_version }))
    .sort((a, b) => a.node.localeCompare(b.node));
}
