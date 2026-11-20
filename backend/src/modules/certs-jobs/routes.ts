// SPDX-License-Identifier: AGPL-3.0-only
// Applications' Certificates and Scheduled jobs tabs (0.10.0, ADR-221, ADR-224): read-only,
// bounded routes per cluster or fleet (a server's, with ?node=) and per object.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import {
  agentsNeedingUpgrade,
  certificateHistory,
  coverage,
  jobDetail,
  listCertificates,
  listJobs,
  runsLastDay,
} from './service.js';

const N = Type.Union([Type.Number(), Type.Null()]);
const S = Type.Union([Type.String(), Type.Null()]);
const Params = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Hex16 = Type.String({ pattern: '^[0-9a-f]{16}$' });
/** A server's name in a Server fleet; omitted (or '') for a Kubernetes cluster's own. */
const NodeQuery = Type.Object({ node: Type.Optional(Type.String({ maxLength: 253 })) });
const Loose = Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]);

const CoverageS = Type.Object({
  node: Type.String(),
  receivedAt: Type.Number(),
  certificates: Loose,
  jobs: Loose,
});
const AgentsS = Type.Array(Type.Object({ node: Type.String(), version: Type.String() }), {
  description: 'Agents older than 0.10 seen in the last hour: they send no certificates or jobs',
});

const CertificateS = Type.Object({
  id: Type.String(),
  node: Type.String(),
  names: Type.Array(Type.String()),
  subject: Type.String(),
  issuer: Type.String(),
  issuerOrg: Type.String(),
  notBefore: Type.Number(),
  notAfter: Type.Number(),
  daysLeft: Type.Number(),
  status: Type.Union([
    Type.Literal('expired'),
    Type.Literal('expires_soon'),
    Type.Literal('expiring'),
    Type.Literal('problem'),
    Type.Literal('ok'),
  ]),
  chain: Type.String(),
  nameMismatch: Type.Array(Type.String()),
  keyType: Type.String(),
  keyBits: Type.Number(),
  fingerprint: Type.String(),
  endpoints: Type.Array(
    Type.Object({
      kind: Type.String(),
      workload: Type.String(),
      port: Type.Number(),
      proto: Type.String(),
      sni: S,
    }),
  ),
  firstSeen: Type.Number(),
  renewedDaysBefore: N,
  renewedAt: N,
  renewalJob: Type.Union([
    Type.Object({ id: Type.String(), name: Type.String(), state: Type.String() }),
    Type.Null(),
  ]),
});

const RunS = Type.Object({
  startedAt: Type.Number(),
  endedAt: N,
  seconds: N,
  code: N,
  result: Type.String(),
});

const JobS = Type.Object({
  id: Type.String(),
  node: Type.String(),
  kind: Type.String(),
  name: Type.String(),
  unit: Type.String(),
  schedule: Type.String(),
  source: Type.String(),
  enabled: Type.Boolean(),
  persistent: Type.Boolean(),
  randomDelaySec: Type.Number(),
  nextAt: N,
  everySec: Type.Number(),
  state: Type.String(),
  failedStreak: Type.Number(),
  lastGoodAt: N,
  missedRuns: Type.Number(),
  missedWhy: S,
  missedAt: N,
  usualSeconds: N,
  frequent: Type.Boolean(),
  lastRun: Type.Union([RunS, Type.Null()]),
  updatedAt: Type.Number(),
});

/** A job in the list: with its last 14 runs, newest first (the table's small bars). */
const JobRowS = Type.Object({ ...JobS.properties, recent: Type.Array(RunS) });

export const certsJobsRoutes: FastifyPluginAsyncTypebox<{ db: Database }> = async (app, { db }) => {
  const signedIn = requireUser();
  const errors = { 401: ProblemSchema, 404: ProblemSchema };

  app.get(
    '/clusters/:id/certificates',
    {
      preHandler: signedIn,
      schema: {
        summary: "A cluster's or fleet's certificates, worst first, with what wasn't covered",
        tags: ['applications', PUBLIC_TAG],
        params: Params,
        querystring: NodeQuery,
        response: {
          200: Type.Object({
            certificates: Type.Array(CertificateS),
            coverage: Type.Array(CoverageS),
            agentsWithout: AgentsS,
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const node = request.query.node;
      return {
        certificates: await listCertificates(db, cluster.id, node),
        coverage: await coverage(db, cluster.id, node),
        agentsWithout: await agentsNeedingUpgrade(db, cluster.id, cluster.kind),
      };
    },
  );

  app.get(
    '/clusters/:id/certificates/:certId',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One certificate: where it is served, and every one seen under its names',
        tags: ['applications', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }), certId: Hex16 }),
        querystring: NodeQuery,
        response: {
          200: Type.Object({
            certificate: CertificateS,
            history: Type.Array(
              Type.Object({
                fingerprint: Type.String(),
                notBefore: Type.Number(),
                notAfter: Type.Number(),
                issuer: Type.String(),
                serial: Type.String(),
                firstSeen: Type.Number(),
                lastSeen: Type.Number(),
                current: Type.Boolean(),
                renewedDaysBefore: N,
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const node = request.query.node ?? '';
      const cert = (await listCertificates(db, cluster.id, node)).find(
        (c) => c.id === request.params.certId,
      );
      if (!cert) return sendProblem(reply, 404, 'Certificate not found');
      return {
        certificate: cert,
        history: await certificateHistory(db, cluster.id, node, cert.id),
      };
    },
  );

  app.get(
    '/clusters/:id/scheduled-jobs',
    {
      preHandler: signedIn,
      schema: {
        summary: "A cluster's or fleet's scheduled jobs (timers, cron, CronJobs), worst first",
        tags: ['applications', PUBLIC_TAG],
        params: Params,
        querystring: NodeQuery,
        response: {
          200: Type.Object({
            jobs: Type.Array(JobRowS),
            /** Runs that ended in the last 24 hours, and how many failed. */
            lastDay: Type.Object({ runs: Type.Number(), failures: Type.Number() }),
            coverage: Type.Array(CoverageS),
            agentsWithout: AgentsS,
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const node = request.query.node;
      return {
        jobs: await listJobs(db, cluster.id, node),
        lastDay: await runsLastDay(db, cluster.id, node),
        coverage: await coverage(db, cluster.id, node),
        agentsWithout: await agentsNeedingUpgrade(db, cluster.id, cluster.kind),
      };
    },
  );

  app.get(
    '/clusters/:id/scheduled-jobs/:jobId',
    {
      preHandler: signedIn,
      schema: {
        summary: 'One scheduled job: its state, its last 100 runs and its runs per hour',
        tags: ['applications', PUBLIC_TAG],
        params: Type.Object({ id: Type.String({ format: 'uuid' }), jobId: Hex16 }),
        querystring: NodeQuery,
        response: {
          200: Type.Object({
            job: JobS,
            runs: Type.Array(RunS),
            hours: Type.Array(
              Type.Object({
                hour: Type.Number(),
                runs: Type.Number(),
                failures: Type.Number(),
                longestSeconds: Type.Number(),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (request, reply) => {
      const cluster = await clusterForOrg(db, request.user!.org.id, request.params.id);
      if (!cluster) return sendProblem(reply, 404, 'Cluster not found');
      const detail = await jobDetail(
        db,
        cluster.id,
        request.query.node ?? '',
        request.params.jobId,
      );
      if (!detail) return sendProblem(reply, 404, 'Scheduled job not found');
      return detail;
    },
  );
};
