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

export const ClusterSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  kind: Type.Union([Type.Literal('kubernetes'), Type.Literal('docker')]),
  status: Type.Union([Type.Literal('pending'), Type.Literal('active'), Type.Literal('inactive')]),
  nodeCount: Type.Integer({ minimum: 0 }),
  agentVersion: Nullable(Type.String()),
  firstSeenAt: Nullable(DateTime),
  lastSeenAt: Nullable(DateTime),
  createdAt: DateTime,
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
  dockerRun: Type.Optional(Type.String({ description: 'docker run command for each Docker host' })),
  helm: Type.Optional(
    Type.String({ description: 'helm install command for a Kubernetes cluster (ADR-059)' }),
  ),
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
