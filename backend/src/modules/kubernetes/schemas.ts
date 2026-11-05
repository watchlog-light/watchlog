// SPDX-License-Identifier: AGPL-3.0-only
// Response schemas of the Kubernetes read API (SPEC §8.1); shapes in views.ts.
import { Type, type TSchema } from 'typebox';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const NullableString = Nullable(Type.String());
const NullableNumber = Nullable(Type.Number());

const Resources = {
  cpuRequestCores: Type.Number(),
  cpuLimitCores: NullableNumber,
  memoryRequestBytes: Type.Number(),
  memoryLimitBytes: NullableNumber,
};

const LastTerminationSchema = Nullable(
  Type.Object({
    container: Type.String(),
    reason: Type.String(),
    exitCode: Type.Integer(),
    finishedAt: NullableString,
  }),
);

export const PodSchema = Type.Object({
  namespace: Type.String(),
  name: Type.String(),
  node: NullableString,
  phase: Type.String(),
  /** As `kubectl get pods` shows it: CrashLoopBackOff, OOMKilled, Terminating, … */
  status: Type.String(),
  ready: Type.Boolean(),
  readyContainers: Type.Integer(),
  totalContainers: Type.Integer(),
  restarts: Type.Integer(),
  qosClass: NullableString,
  ip: NullableString,
  workloadKind: NullableString,
  workload: NullableString,
  createdAt: NullableString,
  startedAt: NullableString,
  lastTermination: LastTerminationSchema,
  /** Why the pod is failing now (CrashLoopBackOff, OOMKilled, ImagePullBackOff…), else null. */
  failing: NullableString,
  ...Resources,
  cpuCores: NullableNumber,
  memoryBytes: NullableNumber,
});

export const ContainerSchema = Type.Object({
  name: Type.String(),
  init: Type.Boolean(),
  image: Type.String(),
  ready: Type.Boolean(),
  state: Type.String(),
  reason: NullableString,
  message: NullableString,
  exitCode: Nullable(Type.Integer()),
  restartCount: Type.Integer(),
  startedAt: NullableString,
  lastTermination: Nullable(
    Type.Object({ reason: Type.String(), exitCode: Type.Integer(), finishedAt: NullableString }),
  ),
  cpuRequestCores: NullableNumber,
  cpuLimitCores: NullableNumber,
  memoryRequestBytes: NullableNumber,
  memoryLimitBytes: NullableNumber,
  cpuCores: NullableNumber,
  memoryBytes: NullableNumber,
});

export const EventSchema = Type.Object({
  type: Type.String(),
  reason: Type.String(),
  message: Type.String(),
  count: Type.Integer(),
  firstSeen: Type.String(),
  lastSeen: Type.String(),
  namespace: NullableString,
  involvedKind: Type.String(),
  involvedName: Type.String(),
  reportingController: NullableString,
  /** Docker: the host the event happened on. */
  host: NullableString,
});

export const NodeSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('Ready'), Type.Literal('NotReady'), Type.Literal('Unknown')]),
  roles: Type.Array(Type.String()),
  unschedulable: Type.Boolean(),
  taints: Type.Array(Type.String()),
  kubeletVersion: NullableString,
  osImage: NullableString,
  kernelVersion: NullableString,
  architecture: NullableString,
  containerRuntime: NullableString,
  internalIp: NullableString,
  createdAt: NullableString,
  cpu: Type.Object({
    usageCores: NullableNumber,
    requestsCores: Type.Number(),
    allocatableCores: NullableNumber,
  }),
  memory: Type.Object({
    usageBytes: NullableNumber,
    requestsBytes: Type.Number(),
    allocatableBytes: NullableNumber,
  }),
  diskUtilization: NullableNumber,
  pods: Type.Object({ count: Type.Integer(), capacity: NullableNumber }),
  conditions: Type.Array(
    Type.Object({
      type: Type.String(),
      status: Type.String(),
      reason: NullableString,
      message: NullableString,
      since: NullableString,
      bad: Type.Boolean(),
    }),
  ),
  agent: Type.Object({
    status: Type.Union([Type.Literal('active'), Type.Literal('inactive'), Type.Literal('missing')]),
    version: NullableString,
    /** ADR-051: verified | unverified; null before the first heartbeat. */
    kubeletTls: NullableString,
    lastSeenAt: NullableString,
  }),
});

const Series = Type.Array(Type.Array(NullableNumber));

/** A pod as a heatmap cell: CPU against its request, failing marked. */
export const HeatPodSchema = Type.Object({
  namespace: Type.String(),
  name: Type.String(),
  cpu: NullableNumber,
  cpuRequest: NullableNumber,
  cpuRatio: NullableNumber,
  failing: NullableString,
});

/** A node as the Nodes page shows it (ADR-111). */
export const NodeRowSchema = Type.Object({
  ...NodeSchema.properties,
  /** When the node last became Ready (it resets on a reboot). */
  readySince: NullableString,
  /** When the node booted (Unix seconds), from agents that report it. */
  bootTime: NullableNumber,
  /** Every mounted filesystem the agent reports, fullest first. */
  disks: Type.Array(
    Type.Object({ mount: Type.String(), utilization: Type.Number(), sizeBytes: NullableNumber }),
  ),
  cpuSeries: Series,
  memorySeries: Series,
  /** Its pods for the heatmap (only with ?heat=1). */
  heat: Type.Optional(Type.Array(HeatPodSchema)),
});

export const WorkloadSchema = Type.Object({
  kind: Type.String(),
  namespace: Type.String(),
  name: Type.String(),
  desired: NullableNumber,
  ready: NullableNumber,
  updated: NullableNumber,
  health: Type.Union([
    Type.Literal('healthy'),
    Type.Literal('progressing'),
    Type.Literal('degraded'),
    Type.Literal('failed'),
    Type.Literal('suspended'),
  ]),
  pods: Type.Integer(),
  restarts: Type.Integer(),
  images: Type.Array(Type.String()),
  createdAt: NullableString,
  lastRolloutAt: NullableString,
  schedule: NullableString,
  lastScheduleAt: NullableString,
  ...Resources,
  cpuCores: NullableNumber,
  memoryBytes: NullableNumber,
});

/** A workload as the Workloads page lists it (ADR-111). */
export const WorkloadRowSchema = Type.Object({
  ...WorkloadSchema.properties,
  /** What is wrong, worded as the alert texts' "why" line; null when healthy. */
  problem: Nullable(
    Type.Object({
      severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
      reason: Type.String(),
      alertId: NullableString,
    }),
  ),
  /** One entry per active pod: ready, starting (not ready yet) or failing. */
  podStates: Type.Array(
    Type.Union([Type.Literal('ready'), Type.Literal('starting'), Type.Literal('failing')]),
  ),
  /** Container restarts within the selected range (from metrics). */
  restartsInRange: NullableNumber,
  /** CPU in cores over the selected range, for the sparkline. */
  cpuSeries: Type.Array(Type.Array(NullableNumber)),
  /** In a system namespace (Settings → General). */
  system: Type.Boolean(),
  /** CronJob: the newest run. */
  lastRun: Nullable(
    Type.Object({
      result: Type.Union([
        Type.Literal('succeeded'),
        Type.Literal('failed'),
        Type.Literal('running'),
      ]),
      at: NullableString,
    }),
  ),
});

export const AttentionSchema = Type.Object({
  severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
  kind: Type.String(),
  objectKind: Type.String(),
  namespace: NullableString,
  name: Type.String(),
  detail: Type.String(),
  since: NullableString,
});

export const MarkerSchema = Type.Object({
  kind: Type.String(),
  target: Type.String(),
  namespace: NullableString,
  details: Type.Record(Type.String(), Type.Unknown()),
  ts: Type.String(),
});
