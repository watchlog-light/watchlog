// SPDX-License-Identifier: AGPL-3.0-only
// The overview API (ADR-110): everything the page shows in
// one response.
import { Type, type TSchema } from 'typebox';
import { LikelyCauseSchema, PossibleCauseSchema } from '../causes/schemas.js';
import { IngestFailureSchema } from '../clusters/schemas.js';

const N = Type.Union([Type.Number(), Type.Null()]);
const S = Type.Union([Type.String(), Type.Null()]);
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
/** [unix seconds, value] */
export const Points = Type.Array(Type.Array(N));
const Sev = Type.Union([Type.Literal('critical'), Type.Literal('warning')]);
const PType = Type.Union([
  Type.Literal('crashloop'),
  Type.Literal('oom'),
  Type.Literal('connections'),
  Type.Literal('nodes'),
  Type.Literal('other'),
]);

const Problem = Type.Object({
  id: Type.String(),
  source: Type.Union([Type.Literal('alert'), Type.Literal('object')]),
  severity: Sev,
  type: PType,
  title: Type.String(),
  why: S,
  since: S,
  alertId: S,
  object: Nullable(Type.Object({ kind: Type.String(), namespace: S, name: Type.String() })),
  related: Type.Integer(),
  /** Its likely cause, when one is (ADR-148): the first 20 problems at most. */
  likelyCause: Type.Optional(LikelyCauseSchema),
  /**
   * How sure GET /causes is about this problem (ADR-156), when it was worked out in time:
   * the first 20 problems at most, within 2 s.
   */
  causeState: Type.Optional(
    Type.Union([Type.Literal('likely'), Type.Literal('possible'), Type.Literal('none')], {
      description:
        'likely: likelyCause has it; possible: possibleCauses lists the leads; none: no clear cause. Left out when the cause was not worked out in time',
    }),
  ),
  possibleCauses: Type.Optional(
    Type.Array(PossibleCauseSchema, {
      maxItems: 2,
      description: 'With no likely cause: the first possible ones (GET /causes has them all)',
    }),
  ),
});

const Resource = Type.Object({ usage: N, requests: N, allocatable: N });
const Marker = Type.Object({
  kind: Type.String(),
  target: Type.String(),
  namespace: S,
  details: Type.Record(Type.String(), Type.Unknown()),
  ts: Type.String(),
});
const Top = Type.Object({
  kind: Type.String(),
  namespace: S,
  name: Type.String(),
  usage: Type.Number(),
  request: N,
  watchlog: Type.Boolean(),
  /** In a system namespace (Settings → General); the page hides these by default. */
  system: Type.Boolean(),
});

export const OverviewSchema = Type.Object({
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
  cluster: Type.Object({
    id: Type.String(),
    name: Type.String(),
    /** Ingest failing now (ADR-117): the page says its data is delayed. */
    ingestFailure: Type.Union([IngestFailureSchema, Type.Null()]),
  }),
  range: Type.Integer(),
  step: Type.Integer(),
  facts: Type.Object({
    kubernetesVersion: S,
    /** Docker fleets: the Docker versions the hosts run. */
    dockerVersions: Type.Array(Type.String()),
    nodes: Type.Integer(),
    /** Node agents (or Docker hosts) reporting / expected. */
    agents: Type.Object({ reporting: Type.Integer(), expected: Type.Integer() }),
    clusterAgent: Type.Union([
      Type.Literal('active'),
      Type.Literal('inactive'),
      Type.Literal('missing'),
      Type.Literal('none'),
    ]),
    ebpf: Type.Union([Type.Literal('on'), Type.Literal('partial'), Type.Literal('off')]),
    /** No alert-worker cycle in 2 minutes: health is unknown (ADR-088). */
    alertingRunning: Type.Boolean(),
  }),
  health: Type.Union([
    Type.Literal('healthy'),
    Type.Literal('degraded'),
    Type.Literal('critical'),
    Type.Literal('unknown'),
  ]),
  /** The one list the status strip counts and Needs attention shows. */
  problems: Type.Object({
    items: Type.Array(Problem),
    critical: Type.Integer(),
    warning: Type.Integer(),
    types: Type.Array(
      Type.Object({ type: PType, count: Type.Integer(), severity: Sev, ruleId: S }),
    ),
    silenced: Type.Integer(),
    oldestSince: S,
  }),
  kpis: Type.Object({
    /** Kubernetes: nodes Ready; Docker: hosts reporting. */
    nodes: Type.Object({ ready: Type.Integer(), total: Type.Integer(), series: Points }),
    /** Kubernetes: pods; Docker: containers (unhealthy in `failed`). */
    pods: Type.Object({
      running: Type.Integer(),
      pending: Type.Integer(),
      failed: Type.Integer(),
      total: Type.Integer(),
      series: Points,
    }),
    restarts: Type.Object({ total: N, previous: N, series: Points }),
    /** From the service map's flows; null without eBPF. */
    traffic: Nullable(
      Type.Object({
        connectionsPerSecond: Type.Number(),
        previous: N,
        failedRatio: N,
        p95Seconds: N,
        series: Points,
      }),
    ),
    cpu: Resource,
    memory: Resource,
  }),
  resources: Type.Object({
    cpu: Type.Object({ usage: Points, requests: N, allocatable: N }),
    memory: Type.Object({ usage: Points, requests: N, allocatable: N }),
    network: Type.Object({ received: Points, sent: Points }),
  }),
  /** Change markers in the range, for the resources chart. */
  markers: Type.Array(Marker),
  /** The latest changes (last 7 days), newest first. */
  changes: Type.Array(Marker),
  top: Type.Object({ cpu: Type.Array(Top), memory: Type.Array(Top) }),
  events: Type.Array(
    Type.Object({
      kind: Type.String(),
      namespace: S,
      name: Type.String(),
      reason: Type.String(),
      message: Type.String(),
      count: Type.Integer(),
      lastSeen: Type.String(),
      covered: Type.Boolean(),
      watchlog: Type.Boolean(),
    }),
  ),
  nodes: Type.Array(
    Type.Object({
      name: Type.String(),
      ready: Type.Boolean(),
      roles: Type.Array(Type.String()),
      pods: Type.Integer(),
      cpuRatio: N,
      memoryRatio: N,
    }),
  ),
  /** Pods (Docker: containers) for the heatmap: CPU as a share of the request. */
  pods: Type.Array(
    Type.Object({
      namespace: S,
      name: Type.String(),
      node: S,
      /** CPU now and the request (Docker: the limit), in cores. */
      cpu: N,
      cpuRequest: N,
      cpuRatio: N,
      /** Why the pod is failing (CrashLoopBackOff, OOMKilled, ImagePullBackOff…), else null. */
      failing: S,
      watchlog: Type.Boolean(),
    }),
  ),
});
