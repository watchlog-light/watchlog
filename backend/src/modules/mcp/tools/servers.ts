// SPDX-License-Identifier: AGPL-3.0-only
// get_server and list_workloads (ADR-207): a server of a Server fleet with its workloads of
// the three sources (systemd services, process groups, containers), and every workload of a
// cluster, Kubernetes or Servers. Read through the API like every tool (ADR-128).
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { name, text, ToolError } from '../output.js';
import { ClusterArg, defineTool, describe, NameArg, NamespaceArg, summary } from './common.js';

const MAX_WORKLOADS = 50;

interface ApiServerWorkload {
  id: string;
  source: 'service' | 'process' | 'container';
  name: string;
  unit: string | null;
  note: string | null;
  state: string;
  problem: { kind: string; severity: string; code: number | null } | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  instances: number | null;
  ports: number[];
  restarts24h: number | null;
  system: boolean;
  server?: string;
}

interface ApiServer {
  name: string;
  status: string;
  agentVersion: string | null;
  servicesAvailable: boolean;
  os: string | null;
  kernel: string | null;
  systemd: string | null;
  docker: string | null;
  cores: number | null;
  memoryBytes: number | null;
  cpuUtilization: number | null;
  memoryUtilization: number | null;
  diskUtilization: number | null;
  problemCount: number;
}

const round = (v: number | null, d = 3) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function workloadField(w: ApiServerWorkload) {
  return {
    id: text(w.id, 300),
    source: w.source,
    name: name(w.name),
    ...(w.server ? { server: name(w.server) } : {}),
    unit: w.unit ? name(w.unit) : null,
    groupedBy: w.note ? text(w.note, 64) : null,
    state: text(w.state, 128),
    problem: w.problem
      ? { kind: w.problem.kind, severity: w.problem.severity, exitCode: w.problem.code }
      : null,
    cpuCores: round(w.cpuCores),
    memoryBytes: w.memoryBytes === null ? null : Math.round(w.memoryBytes),
    memoryLimitBytes: w.memoryLimitBytes === null ? null : Math.round(w.memoryLimitBytes),
    instances: w.instances,
    ports: w.ports.slice(0, 10),
    restarts24h: w.restarts24h === null ? null : Math.round(w.restarts24h),
  };
}

export const getServerTool = defineTool({
  name: 'get_server',
  title: 'Get a server and its workloads',
  description: describe(
    'One server of a Server fleet: its OS, kernel, systemd and Docker versions, CPU, memory and disk use, and every workload on it: systemd services, process groups (pm2 apps, PHP-FPM pools, scripts and binaries in any language) and containers.',
    `Returns problems first (failed, crash-looping, OOM-killed), then the busiest, at most ${MAX_WORKLOADS}; the OS's own services are left out unless includeSystem is true. For one workload's exits and probable cause, explain_problem or the workload page.`,
    'Example question: "What runs on app-1 and is anything crash-looping?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      name: NameArg('The server name, as get_problems or list_workloads names it.'),
      includeSystem: Type.Optional(
        Type.Boolean({ description: "Include the OS's own services (ssh, cron, journald…)." }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.name),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind !== 'server') {
      throw new ToolError(
        'This is a Kubernetes cluster: servers belong to Server fleets.',
        'Use get_node for a Kubernetes node.',
        {},
      );
    }
    const base = `/clusters/${cluster.id}/servers/${encodeURIComponent(args.name)}`;
    const [detail, list] = await Promise.all([
      api.get<{ server: ApiServer }>(base),
      api.get<{ workloads: ApiServerWorkload[] }>(`${base}/workloads`),
    ]).catch(async () => {
      const { servers } = await api.get<{ servers: { name: string }[] }>(
        `/clusters/${cluster.id}/servers`,
      );
      throw new ToolError('No server with this name.', 'Pass one of the servers listed.', {
        name: name(args.name),
        servers: servers.slice(0, 20).map((s) => name(s.name)),
      });
    });
    const s = detail.server;
    const all = list.workloads.filter((w) => args.includeSystem || !w.system);
    return {
      body: {
        cluster: clusterField(cluster),
        server: {
          name: name(s.name),
          status: s.status,
          agentVersion: text(s.agentVersion, 64),
          servicesAndProcesses: s.servicesAvailable,
          os: text(s.os, 128),
          kernel: text(s.kernel, 128),
          systemd: text(s.systemd, 32),
          docker: text(s.docker, 32),
          cores: s.cores,
          memoryBytes: s.memoryBytes,
          cpuUtilization: round(s.cpuUtilization),
          memoryUtilization: round(s.memoryUtilization),
          diskUtilization: round(s.diskUtilization),
          workloadsWithProblems: s.problemCount,
        },
      },
      list: {
        key: 'workloads',
        items: all.slice(0, MAX_WORKLOADS).map(workloadField),
        total: all.length,
        noun: 'workloads',
        narrow: 'Problems first, then the busiest; list_workloads filters by source.',
      },
    };
  },
});

interface ApiKubeWorkload {
  kind: string;
  namespace: string;
  name: string;
  desired: number | null;
  ready: number | null;
  health: string;
  restarts: number;
  cpuCores: number | null;
  memoryBytes?: number | null;
  problem: { severity: string; title?: string } | null;
}

export const listWorkloadsTool = defineTool({
  name: 'list_workloads',
  title: 'List the workloads of a cluster or Server fleet',
  description: describe(
    "Every workload of one cluster, problems first. Kubernetes: Deployments, StatefulSets, DaemonSets, Jobs and CronJobs, with ready against desired and restarts. Servers: each server's systemd services, process groups and containers (the OS's own services left out), with the server they run on.",
    `At most ${MAX_WORKLOADS}; narrow with namespace (Kubernetes), server or source (Servers: service, process or container).`,
    'Example question: "Which services are failing across our servers?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      namespace: NamespaceArg('Kubernetes: one namespace.'),
      server: Type.Optional(
        Type.String({ minLength: 1, maxLength: 253, description: 'Servers: one server.' }),
      ),
      source: Type.Optional(
        Type.Union([Type.Literal('service'), Type.Literal('process'), Type.Literal('container')], {
          description: 'Servers: one source of workloads.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.server ?? a.namespace ?? ''),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'server') {
      const { workloads = [] } = await api.get<{ workloads?: ApiServerWorkload[] }>(
        `/clusters/${cluster.id}/servers`,
        { workloads: '1' },
      );
      const all = workloads.filter(
        (w) =>
          !w.system &&
          (!args.server || w.server === args.server) &&
          (!args.source || w.source === args.source),
      );
      return {
        body: { cluster: clusterField(cluster) },
        list: {
          key: 'workloads',
          items: all.slice(0, MAX_WORKLOADS).map(workloadField),
          total: all.length,
          noun: 'workloads',
          narrow: 'Narrow with server or source; get_server shows one server.',
        },
      };
    }
    const { workloads } = await api.get<{ workloads: ApiKubeWorkload[] }>(
      `/clusters/${cluster.id}/workloads`,
      args.namespace ? { namespaces: args.namespace } : {},
    );
    const rank = (w: ApiKubeWorkload) =>
      w.problem ? (w.problem.severity === 'critical' ? 0 : 1) : 2;
    const all = [...workloads].sort(
      (a, b) => rank(a) - rank(b) || (b.cpuCores ?? 0) - (a.cpuCores ?? 0),
    );
    return {
      body: { cluster: clusterField(cluster) },
      list: {
        key: 'workloads',
        items: all.slice(0, MAX_WORKLOADS).map((w) => ({
          kind: text(w.kind, 32),
          namespace: name(w.namespace),
          name: name(w.name),
          ready: w.ready,
          desired: w.desired,
          health: w.health,
          restarts: w.restarts,
          cpuCores: round(w.cpuCores),
          problem: w.problem
            ? { severity: w.problem.severity, title: text(w.problem.title ?? null, 200) }
            : null,
        })),
        total: all.length,
        noun: 'workloads',
        narrow: 'Narrow with namespace; get_workload shows one.',
      },
    };
  },
});
