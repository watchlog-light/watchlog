// SPDX-License-Identifier: AGPL-3.0-only
// list_certificates and list_scheduled_jobs (0.10.0, ADR-224): a cluster's or Server fleet's
// certificates (expiry, problems, where served, renewals) and scheduled jobs (systemd timers,
// cron, Kubernetes CronJobs) with their state's reasons. Read through the API (ADR-128).
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { name, text } from '../output.js';
import { ClusterArg, defineTool, describe, summary } from './common.js';

const MAX = 50;

interface ApiCertificate {
  id: string;
  node: string;
  names: string[];
  issuer: string;
  issuerOrg: string;
  notAfter: number;
  daysLeft: number;
  status: string;
  chain: string;
  nameMismatch: string[];
  endpoints: { kind: string; workload: string; port: number; sni: string | null }[];
  renewedDaysBefore: number | null;
  renewalJob: { name: string; state: string } | null;
}

interface ApiJob {
  id: string;
  node: string;
  kind: string;
  name: string;
  schedule: string;
  enabled: boolean;
  nextAt: number | null;
  state: string;
  failedStreak: number;
  lastGoodAt: number | null;
  missedRuns: number;
  missedWhy: string | null;
  usualSeconds: number | null;
  lastRun: {
    startedAt: number;
    seconds: number | null;
    code: number | null;
    result: string;
  } | null;
}

const iso = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);
const ServerArg = Type.Optional(
  Type.String({ minLength: 1, maxLength: 253, description: 'Servers: one server.' }),
);

export const listCertificatesTool = defineTool({
  name: 'list_certificates',
  title: 'List the TLS certificates of a cluster or Server fleet',
  description: describe(
    "The certificates WatchLog reads from what TLS ports present (never a key or a Secret), worst first: expired, expiring within 3 or 14 days, a name mismatch or an incomplete chain. Each with its names, issuer, days left, where it is served (a server's service or process group and port; a Kubernetes Service or Ingress host) and whether it was seen renewing.",
    `At most ${MAX}; narrow with server (Servers) or status.`,
    'Example question: "Which certificates expire this month?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      server: ServerArg,
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal('expired'),
            Type.Literal('expires_soon'),
            Type.Literal('expiring'),
            Type.Literal('problem'),
            Type.Literal('ok'),
          ],
          { description: 'Only certificates in this state.' },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.server ?? a.status ?? ''),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    const { certificates, agentsWithout } = await api.get<{
      certificates: ApiCertificate[];
      agentsWithout: { node: string; version: string }[];
    }>(`/clusters/${cluster.id}/certificates`, args.server ? { node: args.server } : {});
    const all = certificates.filter((c) => !args.status || c.status === args.status);
    return {
      body: {
        cluster: clusterField(cluster),
        agentsOlderThan010: agentsWithout.slice(0, 20).map((a) => name(a.node)),
      },
      list: {
        key: 'certificates',
        items: all.slice(0, MAX).map((c) => ({
          id: c.id,
          ...(c.node ? { server: name(c.node) } : {}),
          names: c.names.slice(0, 10).map((n) => name(n)),
          issuer: text(c.issuerOrg || c.issuer, 200),
          expires: iso(c.notAfter),
          daysLeft: c.daysLeft,
          status: c.status,
          chain: c.chain,
          nameMismatch: c.nameMismatch.slice(0, 10).map((n) => name(n)),
          servedAt: c.endpoints.slice(0, 10).map((e) => ({
            kind: text(e.kind, 32),
            workload: name(e.workload),
            port: e.port,
            sni: e.sni ? name(e.sni) : null,
          })),
          renewedDaysBeforeExpiry: c.renewedDaysBefore,
          renewalJob: c.renewalJob
            ? { name: name(c.renewalJob.name), state: c.renewalJob.state }
            : null,
        })),
        total: all.length,
        noun: 'certificates',
        narrow: 'Narrow with server or status.',
      },
    };
  },
});

export const listScheduledJobsTool = defineTool({
  name: 'list_scheduled_jobs',
  title: 'List the scheduled jobs of a cluster or Server fleet',
  description: describe(
    "systemd timers and cron jobs on servers, and CronJobs in Kubernetes, problems first: failed (exit code, failures in a row, the last good run), missed (a run expected and none started, told apart from the server being off), slow (far longer than usual). A cron job's name is derived from its command; its command line and arguments are never sent.",
    `At most ${MAX}; narrow with server (Servers) or state.`,
    'Example question: "Did last night\'s backup run?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      server: ServerArg,
      state: Type.Optional(
        Type.Union(
          [
            Type.Literal('failed'),
            Type.Literal('missed'),
            Type.Literal('slow'),
            Type.Literal('running'),
            Type.Literal('working'),
            Type.Literal('new'),
            Type.Literal('disabled'),
          ],
          { description: 'Only jobs in this state.' },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.server ?? a.state ?? ''),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    const { jobs, agentsWithout } = await api.get<{
      jobs: ApiJob[];
      agentsWithout: { node: string; version: string }[];
    }>(`/clusters/${cluster.id}/scheduled-jobs`, args.server ? { node: args.server } : {});
    const all = jobs.filter((j) => !args.state || j.state === args.state);
    return {
      body: {
        cluster: clusterField(cluster),
        agentsOlderThan010: agentsWithout.slice(0, 20).map((a) => name(a.node)),
      },
      list: {
        key: 'jobs',
        items: all.slice(0, MAX).map((j) => ({
          id: j.id,
          ...(j.node ? { server: name(j.node) } : {}),
          kind: j.kind,
          name: name(j.name),
          schedule: text(j.schedule, 128),
          enabled: j.enabled,
          state: j.state,
          failedInARow: j.failedStreak,
          lastGoodRun: iso(j.lastGoodAt),
          missedRuns: j.missedRuns,
          missedWhy: j.missedWhy,
          usualSeconds: j.usualSeconds === null ? null : Math.round(j.usualSeconds),
          lastRun: j.lastRun
            ? {
                started: iso(j.lastRun.startedAt),
                seconds: j.lastRun.seconds,
                exitCode: j.lastRun.code,
                result: j.lastRun.result,
              }
            : null,
          nextRun: iso(j.nextAt),
        })),
        total: all.length,
        noun: 'scheduled jobs',
        narrow: 'Narrow with server or state.',
      },
    };
  },
});
