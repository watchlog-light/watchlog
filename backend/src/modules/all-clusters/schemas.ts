// SPDX-License-Identifier: AGPL-3.0-only
// GET /overview/all (ADR-226): the whole "All clusters and fleets" page in one response.
import { Type } from 'typebox';
import { ProblemItemSchema } from '../overview/schemas.js';
import { RowSchema } from '../anomaly/routes.js';

const N = Type.Union([Type.Number(), Type.Null()]);
const S = Type.Union([Type.String(), Type.Null()]);
const DateTime = Type.String({ format: 'date-time' });
const Kind = Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]);

const ClusterRef = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  kind: Kind,
});

const Place = Type.Object({
  cluster: ClusterRef,
  problemId: Type.String({ description: "The problem's id on that cluster's own Overview" }),
  alertId: S,
});

const problemFields = Object.fromEntries(
  Object.entries(ProblemItemSchema.properties).filter(([k]) => k !== 'id' && k !== 'related'),
) as Omit<typeof ProblemItemSchema.properties, 'id' | 'related'>;
const ProblemRow = Type.Object({
  ...problemFields,
  id: Type.String(),
  places: Type.Array(Place, {
    minItems: 1,
    description:
      'Where it is open: more than one when the same problem is in several clusters or fleets (same alert rule, same workload name, started within 30 minutes of each other)',
  }),
});

const ClusterRow = Type.Object({
  ...ClusterRef.properties,
  status: Type.Union([
    Type.Literal('critical'),
    Type.Literal('warning'),
    Type.Literal('healthy'),
    Type.Literal('waiting'),
  ]),
  version: Type.Union([Type.String(), Type.Null()], {
    description: "Kubernetes: the nodes' kubelet version (major.minor); null for fleets",
  }),
  hosts: Type.Integer({ description: 'Nodes or servers whose agent reported within 7 days' }),
  reporting: Type.Object({ live: Type.Integer(), total: Type.Integer() }),
  sources: Type.Union([
    Type.Object({
      services: Type.Integer(),
      processGroups: Type.Integer(),
      containers: Type.Integer(),
      applications: Type.Array(Type.String(), {
        description: 'Integration types monitored there (postgres, redis…)',
      }),
    }),
    Type.Null(),
  ]),
  cpu: Type.Object({
    now: N,
    points: Type.Array(Type.Array(N), { description: '[unix seconds, ratio]' }),
  }),
  memory: N,
  problems: Type.Object({ critical: Type.Integer(), warning: Type.Integer() }),
  whatChanged: Type.Union([Type.Integer(), Type.Null()], {
    description: 'What changed in the last 24 hours; null while it is still learning',
  }),
  alerts: Type.Integer({ description: 'Alert notifications sent or failed in the range' }),
});

const Channel = Type.Object({ id: Type.String(), name: Type.String(), type: Type.String() });

export const AllClustersSchema = Type.Object({
  range: Type.Integer(),
  step: Type.Integer(),
  ranges: Type.Array(Type.Integer(), { description: 'The ranges this org may ask for' }),
  kind: Type.Union([Type.Literal('all'), Kind]),
  counts: Type.Object({ all: Type.Integer(), kubernetes: Type.Integer(), server: Type.Integer() }),
  hosts: Type.Object({
    nodes: Type.Integer(),
    servers: Type.Integer(),
    notReporting: Type.Integer(),
  }),
  clusters: Type.Array(ClusterRow),
  problems: Type.Array(ProblemRow),
  lastResolved: Type.Union([
    Type.Object({
      title: Type.String(),
      cluster: ClusterRef,
      resolvedAt: DateTime,
      durationSeconds: Type.Integer(),
    }),
    Type.Null(),
  ]),
  resolvedThisWeek: Type.Integer(),
  whatChanged: Type.Object({
    rows: Type.Array(Type.Object({ ...RowSchema.properties, cluster: ClusterRef })),
    total: Type.Integer(),
    learning: Type.Array(Type.Object({ ...ClusterRef.properties, until: S })),
  }),
  alertsSent: Type.Object({
    total: Type.Integer(),
    channels: Type.Array(
      Type.Object({ ...Channel.properties, sent: Type.Integer(), failed: Type.Integer() }),
    ),
  }),
  housekeeping: Type.Object({
    latestVersion: Type.String(),
    oldAgents: Type.Array(
      Type.Object({
        cluster: ClusterRef,
        count: Type.Integer(),
        versions: Type.Array(Type.String()),
      }),
    ),
    failingChannels: Type.Array(Type.Object({ ...Channel.properties, since: DateTime, error: S })),
    deliveringChannels: Type.Array(Channel),
    noChannel: Type.Array(ClusterRef),
    ebpfOff: Type.Array(
      Type.Object({
        cluster: ClusterRef,
        count: Type.Integer(),
        reasons: Type.Array(Type.String()),
      }),
    ),
  }),
});
