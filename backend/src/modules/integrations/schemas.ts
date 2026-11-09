// SPDX-License-Identifier: AGPL-3.0-only
// Where a monitored service runs, as the API accepts it (SPEC §4.12): a Kubernetes
// workload, a Compose service or a container on a Docker host, or an address.
import { Type } from 'typebox';

export const Name = Type.String({ minLength: 1, maxLength: 253 });
const K8sName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$',
});
export const DockerName = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$',
});
const Port = Type.Integer({ minimum: 1, maximum: 65535 });

export const TargetSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('workload'),
      namespace: K8sName,
      workload_kind: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z]+$' }),
      workload: K8sName,
      port: Port,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('compose'),
      host: DockerName,
      compose_project: DockerName,
      compose_service: DockerName,
      port: Port,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('container'), host: DockerName, container: DockerName, port: Port },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('address'),
      // host:port, a name or an IPv4 address, or [IPv6]:port.
      address: Type.String({
        maxLength: 260,
        pattern: '^(\\[[0-9a-fA-F:.]+\\]|[A-Za-z0-9][A-Za-z0-9.-]*):[0-9]{1,5}$',
      }),
    },
    { additionalProperties: false },
  ),
]);
