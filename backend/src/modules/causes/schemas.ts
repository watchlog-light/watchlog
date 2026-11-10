// SPDX-License-Identifier: AGPL-3.0-only
// GET /causes's answer (ADR-148), in the public spec. Codes are open strings: later rules
// add codes, and clients render unknown ones from their facts. Every sentence is a code with
// facts (ADR-147); the dashboard words them through i18n.
import { Type, type TSchema } from 'typebox';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Facts = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]), {
  description: "The sentence's values; every placeholder of the code's sentence is here",
});
const Platform = Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]);

export const ObjectRefSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('pod'),
      Type.Literal('workload'),
      Type.Literal('container'),
      Type.Literal('compose_service'),
      Type.Literal('edge'),
      Type.Literal('application'),
      Type.Literal('alert'),
      Type.Literal('node'),
      Type.Literal('host'),
      Type.Literal('change'),
      Type.Literal('cluster'),
    ]),
    ref: Type.String({
      description:
        'In the form /causes takes for that kind (pod ns/name, workload ns/Kind/name, container host/name, compose_service project/service, edge the map edge id, application and alert their id); node and host: the name; change: the change marker target (Deployment/shop/api, Container/docker-01/shop-api-1)',
    }),
    name: Type.String(),
    platform: Platform,
    workloadKind: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    type: Type.Optional(Type.String({ description: 'An application: postgres, redis, rabbitmq…' })),
  },
  { description: 'What a step or check is about, and where it links to' },
);

const StepSchema = Type.Object({
  object: ObjectRefSchema,
  source: Type.Union(
    [
      Type.Literal('service_map'),
      Type.Literal('kubernetes'),
      Type.Literal('docker'),
      Type.Literal('change_marker'),
      Type.Literal('metrics'),
      Type.Literal('dns'),
      Type.Literal('application'),
    ],
    { description: 'Where the fact comes from' },
  ),
  code: Type.String(),
  facts: Facts,
  at: Nullable(Type.String({ description: 'A moment: a change, a kill' })),
  since: Nullable(Type.String({ description: 'Since when a state lasts' })),
  next: Nullable(
    Type.Union(
      [
        Type.Literal('calls'),
        Type.Literal('because'),
        Type.Literal('consumed_by'),
        Type.Literal('looks_up'),
        Type.Literal('after'),
      ],
      { description: 'How this step leads to the next; null on the last step' },
    ),
  ),
});

const CauseSchema = Type.Object({
  rule: Type.String({ description: 'The catalog rule (ADR-150), e.g. oom_limit' }),
  strength: Type.Union([Type.Literal('likely'), Type.Literal('possible')]),
  code: Type.String(),
  facts: Facts,
  since: Nullable(Type.String({ description: 'When the cause began' })),
  chain: Type.Array(StepSchema, {
    maxItems: 3,
    description: 'The evidence chain: the symptom first, where it starts last',
  }),
});

const CheckSchema = Type.Object({
  topic: Type.Union(
    [
      Type.Literal('self'),
      Type.Literal('events'),
      Type.Literal('changes'),
      Type.Literal('node'),
      Type.Literal('host'),
      Type.Literal('cpu'),
      Type.Literal('dependencies'),
      Type.Literal('dns'),
      Type.Literal('application'),
      Type.Literal('edge'),
    ],
    { description: 'What was looked at' },
  ),
  code: Type.String({ description: 'What was found' }),
  facts: Facts,
  result: Type.Union(
    [
      Type.Literal('explains'),
      Type.Literal('possible'),
      Type.Literal('ok'),
      Type.Literal('not_run'),
      Type.Literal('not_applicable'),
    ],
    {
      description:
        'explains: the likely cause came from it; possible: a possible cause, or something abnormal no rule explains; ok: nothing wrong; not_run: couldn’t check (no data, network flows off); not_applicable',
    },
  ),
  object: Type.Optional(ObjectRefSchema),
});

export const CausesSchema = Type.Object({
  subject: ObjectRefSchema,
  object: Nullable(ObjectRefSchema),
  cluster: Type.Object({ id: Type.String(), name: Type.String(), kind: Platform }),
  state: Type.Union([Type.Literal('likely'), Type.Literal('possible'), Type.Literal('none')], {
    description: 'likely: one cause explains it; possible: leads to check; none: no clear cause',
  }),
  checkedAt: Type.String(),
  symptomSince: Nullable(Type.String()),
  resolvedAt: Nullable(
    Type.String({ description: "A resolved alert: when it resolved (the cause 'was likely')" }),
  ),
  window: Type.Object({ from: Type.String(), to: Type.String() }),
  headline: Type.Object({ code: Type.String(), facts: Facts }),
  causes: Type.Array(CauseSchema, {
    maxItems: 3,
    description: 'Ranked, the top one first; at most one is likely',
  }),
  checks: Type.Array(CheckSchema, { description: 'What we checked' }),
  flowsOff: Nullable(
    Type.Array(
      Type.Object({
        node: Type.String(),
        cause: Nullable(Type.String()),
        reason: Nullable(Type.String()),
      }),
      {
        description:
          'Nodes or hosts under the subject whose agent sees no network flows: dependency checks could not run',
      },
    ),
  ),
});

/**
 * The likely cause on the alert detail, a Needs-attention problem and an application with a
 * finding (ADR-148, ADR-155): GET /causes's top cause, short, only when it is likely.
 */
export const LikelyCauseSchema = Type.Object(
  {
    rule: Type.String({ description: 'The catalog rule (ADR-150), e.g. oom_limit' }),
    code: Type.String(),
    facts: Facts,
    since: Nullable(Type.String({ description: 'When the cause began' })),
    headline: Type.Object(
      { code: Type.String(), facts: Facts },
      { description: "The answer's first sentence (the same as GET /causes's headline)" },
    ),
    subject: Type.String({
      description:
        'GET /causes?cluster=<the cluster id>&subject=<this> gives the whole answer: the evidence chain, any other cause and what was checked',
    }),
  },
  {
    description:
      'The likely cause (ADR-148): only when one cause is likely; left out when causes are only possible, none is clear, or it was not worked out in time',
  },
);

/**
 * A possible cause on a Needs-attention problem with no likely one (ADR-156): the cause's
 * rule, code, facts and start, for the dashboard's one line.
 */
export const PossibleCauseSchema = Type.Object(
  {
    rule: Type.String({ description: 'The catalog rule (ADR-150), e.g. cpu_throttled' }),
    code: Type.String({ description: 'The cause in one line (causes.cause.<code>)' }),
    facts: Facts,
    since: Nullable(Type.String({ description: 'When the cause began' })),
    where: Type.Optional(
      Type.Object(
        {
          code: Type.String({ description: 'The step in one sentence (causes.step.<code>)' }),
          facts: Facts,
          name: Type.String({ description: 'The object the step is about' }),
        },
        {
          description:
            "Where it starts: the last step of the cause's chain, which the dashboard's line shows",
        },
      ),
    ),
  },
  { description: 'A possible cause: a lead to check, not proven' },
);
