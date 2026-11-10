// SPDX-License-Identifier: AGPL-3.0-only
// The likely cause in the notifications (ADR-148, ADR-157). When an alert fires, the worker
// asks probable cause about it (GET /causes's answer for `alert:<id>`) with a 2 s budget, just
// before its firing message goes out, and keeps the answer with the alert: the cause it had
// when it fired. A likely cause adds one line to the message ("Likely cause: …"), and the
// webhook an object; possible, none and an answer not ready in time add nothing, and the
// message is never held back for it. The resolve message says "Was likely: …" from the same
// stored answer, so it repeats what the firing message said.
import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { headlineText } from '@watchlog/cause-words';
import type { Database } from '../../db/index.js';
import type { Notifications } from '../../db/types.js';
import { internalCallMark } from '../../lib/internal-call.js';
import { SERVICE_ORG_HEADER } from '../../plugins/service-identity.js';
import type { CausesAnswer } from '../causes/engine.js';
import {
  likelyCause,
  NO_CAUSE_HEADER,
  type CausesService,
  type ListJob,
} from '../causes/likely.js';
import type { Facts, Sentence } from '../causes/types.js';
import { ApiReader } from '../mcp/reader.js';
import type { MessagePayload } from './outbox.js';

/** ADR-148: the cause is worked out within 2 s, else the message goes without it. */
export const NOTIFY_BUDGET_MS = 2_000;

/** One step of the likely cause's chain, short (the webhook's `chain`). */
export interface NotifyStep {
  /** The step's object as GET /causes takes it (`workload:causes-e2e/Deployment/api`). */
  subject: string;
  name: string;
  /** The step's code (causes.step.<code>): `edge_failed`, `no_pods`, `scaled`. */
  fact: string;
  facts: Facts;
  /** A state that lasts began, or a moment (a change, a kill): one of them, when known. */
  since?: string;
  at?: string;
}

/**
 * The likely cause as a message carries it: ADR-155's short form, its headline in English
 * (`text`, the line's words) and the chain, short.
 */
export interface NotifyCause {
  rule: string;
  code: string;
  facts: Facts;
  since: string | null;
  headline: Sentence;
  subject: string;
  text: string;
  chain: NotifyStep[];
}

/** What was found when the alert fired, kept with it (alert_states.cause). */
export interface StoredCause {
  /** likely, possible, none; `late` when no answer came within the budget. */
  state: CausesAnswer['state'] | 'late';
  /** How long working it out took, ms. */
  ms: number;
  likely?: NotifyCause;
}

/** An answer's likely cause as a message carries it; undefined unless likely (and worded). */
export function notifyCause(a: CausesAnswer): NotifyCause | undefined {
  const lc = likelyCause(a);
  const top = a.causes.find((c) => c.strength === 'likely');
  if (!lc || !top) return undefined;
  const text = headlineText(lc.headline);
  if (!text) return undefined;
  return {
    rule: lc.rule,
    code: lc.code,
    facts: lc.facts,
    since: lc.since,
    headline: lc.headline,
    subject: lc.subject,
    text,
    chain: top.chain.map((s) => ({
      subject: `${s.object.kind}:${s.object.ref}`,
      name: s.object.name,
      fact: s.code,
      facts: s.facts,
      ...(s.since ? { since: s.since } : {}),
      ...(s.at ? { at: s.at } : {}),
    })),
  };
}

/** Answers for some alerts of one org, within a budget (undefined: none in time). */
export type WorkOut = (orgId: string, jobs: ListJob[]) => Promise<(CausesAnswer | undefined)[]>;

/**
 * The worker's way to ask: its in-process app (buildApp with `serviceReads`) read as a viewer
 * of the org (plugins/service-identity.ts), marked in-process, and without causes in the
 * answers it reads, as the backend's own reads are.
 */
export function workerCauses(
  app: FastifyInstance,
  service: CausesService,
  budgetMs = NOTIFY_BUDGET_MS,
): WorkOut {
  return (orgId, jobs) => {
    const reader = new ApiReader(app, {
      [SERVICE_ORG_HEADER]: orgId,
      ...internalCallMark(),
      [NO_CAUSE_HEADER]: '1',
    });
    return service.answers(reader, orgId, jobs, { budgetMs });
  };
}

/** Kinds whose message gets the line: the firing ones, and the resolve ("Was likely"). */
const CARRIES = new Set(['firing', 'escalated', 'renotify', 'resolved']);
/** Kinds that work the cause out when the alert has none yet: the alert fires (or escalates). */
const WORKS_OUT = new Set(['firing', 'escalated']);

export interface CauseLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Before claimed messages are sent: works out the cause of each alert that fires in them and
 * has none yet (each org within the budget, orgs side by side), keeps it with the alert, and
 * puts the likely ones on the messages' items (in memory and in the stored payload, so a
 * retry says the same). Never throws: a message goes without the line rather than late.
 */
export async function attachCauses(
  db: Database,
  workOut: WorkOut,
  rows: Selectable<Notifications>[],
  log: CauseLog,
  now = Date.now(),
): Promise<void> {
  const carrying = rows.filter((r) => CARRIES.has(r.kind));
  if (!carrying.length) return;
  const payloadOf = (r: Selectable<Notifications>) => r.payload as unknown as MessagePayload;
  const ids = [...new Set(carrying.flatMap((r) => payloadOf(r).items.map((i) => i.alertId)))];
  try {
    const states = await db
      .selectFrom('alert_states')
      .select(['id', 'org_id', 'state', 'cause', 'cause_at'])
      .where('id', 'in', ids)
      .execute();
    const byId = new Map(states.map((s) => [s.id, s]));

    // Work out what's missing: alerts firing now, in a message that fires.
    const wanted = new Map<string, { orgId: string; jobs: ListJob[] }>();
    for (const r of carrying.filter((x) => WORKS_OUT.has(x.kind))) {
      const p = payloadOf(r);
      for (const it of p.items) {
        const s = byId.get(it.alertId);
        if (!s || s.cause_at !== null || s.state !== 'firing') continue;
        const w = wanted.get(s.org_id) ?? { orgId: s.org_id, jobs: [] };
        if (!w.jobs.some((j) => j.subject.kind === 'alert' && j.subject.id === it.alertId)) {
          w.jobs.push({
            cluster: { ...p.cluster, kind: p.cluster.kind as 'kubernetes' | 'docker' },
            subject: { kind: 'alert', id: it.alertId },
          });
        }
        wanted.set(s.org_id, w);
      }
    }
    await Promise.all(
      [...wanted.values()].map(async ({ orgId, jobs }) => {
        const began = Date.now();
        const answers = await workOut(orgId, jobs).catch((err: Error) => {
          log.warn({ err: err.message }, 'likely causes could not be worked out');
          return jobs.map(() => undefined);
        });
        const ms = Date.now() - began;
        await Promise.all(
          jobs.map(async (j, i) => {
            const a = answers[i];
            const likely = a && notifyCause(a);
            const stored: StoredCause = {
              state: a ? a.state : 'late',
              ms,
              ...(likely ? { likely } : {}),
            };
            const id = (j.subject as { id: string }).id;
            // The first answer kept stays: two workers sending to two channels agree.
            await db
              .updateTable('alert_states')
              .set({ cause: JSON.stringify(stored), cause_at: new Date(now) })
              .where('id', '=', id)
              .where('cause_at', 'is', null)
              .execute();
          }),
        );
        log.info(
          {
            org: orgId,
            alerts: jobs.length,
            likely: answers.filter((a) => a?.state === 'likely').length,
            late: answers.filter((a) => !a).length,
            ms,
          },
          'likely causes worked out for firing alerts',
        );
      }),
    );

    // Put what is kept on each message's items.
    const kept = await db
      .selectFrom('alert_states')
      .select(['id', 'cause'])
      .where('id', 'in', ids)
      .where('cause_at', 'is not', null)
      .execute();
    const likelyOf = new Map(
      kept.flatMap((k) => {
        const c = k.cause as StoredCause | null;
        return c?.likely ? [[k.id, c.likely] as const] : [];
      }),
    );
    for (const r of carrying) {
      const p = payloadOf(r);
      let changed = false;
      const items = p.items.map((it) => {
        const lc = likelyOf.get(it.alertId);
        if (!lc || it.likelyCause) return it;
        changed = true;
        return { ...it, likelyCause: lc };
      });
      if (!changed) continue;
      const next: MessagePayload = { ...p, items };
      r.payload = next as unknown as Selectable<Notifications>['payload'];
      await db
        .updateTable('notifications')
        .set({ payload: JSON.stringify(next) })
        .where('id', '=', r.id)
        .execute();
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'likely causes left out of the messages');
  }
}
