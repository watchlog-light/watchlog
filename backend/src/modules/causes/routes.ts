// SPDX-License-Identifier: AGPL-3.0-only
// GET /causes (ADR-148): the probable cause of an alert, a workload, a pod, a container, a
// Compose service, a service-map edge or an application. Reads as the caller, through the
// public API in-process (gather.ts), and keeps each answer 15 s per subject.
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import type { Database } from '../../db/index.js';
import { sendProblem } from '../../lib/problem.js';
import { requireUser } from '../../plugins/auth.js';
import { PUBLIC_TAG } from '../../openapi/public.js';
import { ProblemSchema } from '../auth/schemas.js';
import { clusterForOrg } from '../clusters/service.js';
import { causeReader, CausesService } from './likely.js';
import { AmbiguousError, NotFoundError } from './resolve.js';
import { CausesSchema } from './schemas.js';
import { parseSubject, SUBJECT_FORMS, SUBJECT_MAX, SubjectError, type Subject } from './subject.js';

export const causesRoutes: FastifyPluginAsyncTypebox<{
  db: Database;
  /** The answer cache GET /causes shares with the `likelyCause` fields (ADR-155). */
  causes?: CausesService;
}> = async (app, { db, causes = new CausesService() }) => {
  const signedIn = requireUser();

  app.get(
    '/causes',
    {
      preHandler: signedIn,
      schema: {
        summary:
          'Probable cause of an alert, workload, pod, container, Compose service, edge or application',
        description: `Ranked probable causes (likely or possible, never a score), each with its evidence chain, and what was checked (ADR-146 to ADR-148). ${SUBJECT_FORMS}. Answers are kept 15 s per subject.`,
        tags: ['causes', PUBLIC_TAG],
        querystring: Type.Object({
          cluster: Type.String({ format: 'uuid', description: 'The cluster or Docker fleet id' }),
          subject: Type.String({
            minLength: 3,
            maxLength: SUBJECT_MAX,
            description: SUBJECT_FORMS,
          }),
        }),
        response: {
          200: CausesSchema,
          400: ProblemSchema,
          401: ProblemSchema,
          404: ProblemSchema,
        },
      },
    },
    async (request, reply) => {
      let subject: Subject;
      try {
        subject = parseSubject(request.query.subject);
      } catch (err) {
        if (err instanceof SubjectError) return sendProblem(reply, 400, err.message);
        throw err;
      }
      const orgId = request.user!.org.id;
      const row = await clusterForOrg(db, orgId, request.query.cluster);
      if (!row) return sendProblem(reply, 404, 'Cluster not found');
      const cluster = { id: row.id, name: row.name, kind: row.kind as 'kubernetes' | 'docker' };
      try {
        return await causes.answer(causeReader(app, request), orgId, cluster, subject);
      } catch (err) {
        if (err instanceof NotFoundError) return sendProblem(reply, 404, err.message);
        if (err instanceof AmbiguousError) return sendProblem(reply, 400, err.message);
        throw err;
      }
    },
  );
};
