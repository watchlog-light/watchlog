// SPDX-License-Identifier: AGPL-3.0-only
import { Type } from 'typebox';

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const DateTime = Type.String({ format: 'date-time' });

/** DNS-label style: lowercase letters, digits and dashes, 1–63 characters. */
export const ClusterName = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$',
});

export const ClusterIdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const TokenParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  tokenId: Type.String({ format: 'uuid' }),
});

/** Ingest failing now (ADR-117): data from this cluster is delayed or lost. */
export const IngestFailureSchema = Type.Object({
  since: DateTime,
  lastErrorAt: DateTime,
  endpoints: Type.Array(
    Type.Object({
      endpoint: Type.Union([
        Type.Literal('write'),
        Type.Literal('heartbeat'),
        Type.Literal('objects'),
        Type.Literal('events'),
      ]),
      status: Type.Integer(),
      message: Type.String(),
      failures: Type.Integer({ minimum: 0 }),
    }),
  ),
});

/**
 * A kind as an input (ADR-207): `server`, `kubernetes`, or `docker`, the 0.8 name of a
 * Server fleet, accepted as an alias through 1.x. Answers always say `server`.
 */
export const ClusterKindInput = Type.Union(
  [Type.Literal('kubernetes'), Type.Literal('server'), Type.Literal('docker')],
  { description: '`docker` is an alias of `server` (WatchLog 0.8 and earlier)' },
);
export const normalizeKind = (k: 'kubernetes' | 'server' | 'docker'): 'kubernetes' | 'server' =>
  k === 'docker' ? 'server' : k;

export const ClusterSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
  status: Type.Union([Type.Literal('pending'), Type.Literal('active'), Type.Literal('inactive')]),
  nodeCount: Type.Integer({ minimum: 0 }),
  agentVersion: Nullable(Type.String()),
  firstSeenAt: Nullable(DateTime),
  lastSeenAt: Nullable(DateTime),
  createdAt: DateTime,
  ingestFailure: Type.Union([IngestFailureSchema, Type.Null()]),
  /** A node or server agent here is older than this WatchLog, or of unknown version (ADR-227). */
  updateAvailable: Type.Boolean(),
});

export const TokenSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  prefix: Type.String(),
  createdAt: DateTime,
  revokedAt: Nullable(DateTime),
});

export const IssuedTokenSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  prefix: Type.String(),
  value: Type.String({ description: 'Shown once; store it securely' }),
  createdAt: DateTime,
});

export const InstallSchema = Type.Object({
  dockerRun: Type.Optional(
    Type.String({ description: 'docker run command for each server, when not installing on it' }),
  ),
  script: Type.Optional(
    Type.String({ description: "A server's one-command install: the install script (ADR-209)" }),
  ),
  deb: Type.Optional(Type.String({ description: 'The deb install, on a release build' })),
  rpm: Type.Optional(Type.String({ description: 'The rpm install, on a release build' })),
  helm: Type.Optional(
    Type.String({ description: 'helm install command for a Kubernetes cluster (ADR-059)' }),
  ),
  kubectl: Type.Optional(
    Type.String({
      description:
        'Cloud: kubectl apply of the manifest behind an install code valid 24 hours (ADR-176)',
    }),
  ),
  compose: Type.Optional(
    Type.String({ description: 'Cloud: the Docker agent as a Compose service (ADR-176)' }),
  ),
  installCodeExpiresAt: Type.Optional(DateTime),
});

export const ClusterListSchema = Type.Object({ clusters: Type.Array(ClusterSchema) });
export const ClusterDetailSchema = Type.Object({
  cluster: ClusterSchema,
  tokens: Type.Array(TokenSchema),
});
export const CreateClusterResponseSchema = Type.Object({
  cluster: ClusterSchema,
  token: IssuedTokenSchema,
  install: InstallSchema,
});
export const IssueTokenResponseSchema = Type.Object({
  token: IssuedTokenSchema,
  install: InstallSchema,
});

const Method = Type.Union([
  Type.Literal('script'),
  Type.Literal('deb'),
  Type.Literal('rpm'),
  Type.Literal('docker'),
]);

/** GET /clusters/:id/agents (ADR-227). */
export const ClusterAgentsSchema = Type.Object({
  latest: Type.String({ description: "This WatchLog's version: what the agents update to" }),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('server')]),
  agents: Type.Array(
    Type.Object({
      host: Type.String(),
      version: Type.String(),
      method: Type.Union([Method, Type.Null()], {
        description: 'Servers from 0.11.1: how the agent was installed; null when unknown',
      }),
      updateAvailable: Type.Boolean(),
      active: Type.Boolean(),
      lastSeenAt: DateTime,
    }),
  ),
  outOfDate: Type.Integer({ minimum: 0 }),
  helm: Type.Union([
    Type.Object({
      command: Type.String(),
      known: Type.Boolean({ description: 'The release and namespace are the cluster’s own' }),
      chart: Type.Union([Type.Literal('watchlog'), Type.Literal('watchlog-agent')]),
    }),
    Type.Null(),
  ]),
  server: Type.Union([
    Type.Object({
      commands: Type.Object({
        script: Type.Optional(Type.String()),
        deb: Type.Optional(Type.String()),
        rpm: Type.Optional(Type.String()),
        docker: Type.Optional(Type.String()),
      }),
      method: Type.Union([Method, Type.Null()]),
      loop: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
});
