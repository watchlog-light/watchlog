// SPDX-License-Identifier: AGPL-3.0-only
// Docker API fixtures shaped like the real responses captured in the Lima test VM.
export const FLEET = {
  id: '01a18f42-06e7-7078-a01a-ea39c791d699',
  name: 'acceptance',
  kind: 'docker',
  status: 'active',
  nodeCount: 1,
  agentVersion: '1.0.0',
  firstSeenAt: null,
  lastSeenAt: null,
  createdAt: '2026-10-31T00:00:00Z',
};
export const HOST = {
  name: 'lima-watchlog-test',
  status: 'active',
  lastSeenAt: '2026-10-31T00:26:29Z',
  agentVersion: 'slice7',
  dockerVersion: '29.9.2',
  os: 'linux',
  arch: 'arm64',
  kernelVersion: '6.8.0-142-generic',
  containers: { total: 7, running: 6, stopped: 1, unhealthy: 1 },
  cpuUtilization: 0.0912,
  memoryUtilization: 0.1472,
  diskUtilization: 0.1746,
  load1: 0.68,
  cpu: { usageCores: 0.36, cores: 4 },
  memory: { usageBytes: 0.1472 * 6e9, totalBytes: 6e9 },
  bootTime: 1793400000,
  disks: [{ mount: '/', utilization: 0.1746, sizeBytes: 31e9 }],
  cpuSeries: [
    [1793403000, 0.08],
    [1793403060, 0.09],
  ],
  memorySeries: [
    [1793403000, 0.14],
    [1793403060, 0.15],
  ],
};
export const container = (name: string, extra: object = {}) => ({
  id: name.padEnd(64, 'a'),
  name,
  host: HOST.name,
  image: 'redis:7-alpine',
  state: 'running',
  status: 'Up 5 minutes',
  health: null,
  restartCount: 0,
  exitCode: 0,
  oomKilled: false,
  createdAt: 1793400000,
  startedAt: '2026-10-31T00:00:00Z',
  ports: [],
  composeProject: null,
  composeService: null,
  sizeRw: null,
  cpuCores: 0.0065,
  memoryBytes: 3424256,
  memoryLimitBytes: null,
  cpuLimitCores: null,
  restarting: false,
  stateError: null,
  finishedAt: null,
  healthDetail: null,
  problem: null,
  restartsInRange: null,
  cpuSeries: [],
  watchlog: false,
  ...extra,
});

// Bad-state containers as the API returns them for the agent fixtures captured on the
// Lima VM (fx-unhealthy, fx-oom, fx-crashloop; probe output already redacted).
const probe = (s: string, exitCode = 1) => ({
  start: `2026-10-31T06:20:${s}.665Z`,
  end: `2026-10-31T06:20:${s}.696Z`,
  exitCode,
  output: "wget: can't connect to remote host (127.0.0.1): Connection refused",
});
export const UNHEALTHY_DETAIL = {
  status: 'unhealthy',
  failingStreak: 3,
  since: '2026-10-31T06:20:16.696Z',
  sinceEstimated: false,
  probes: [probe('06'), probe('11'), probe('16')],
  check: {
    command:
      "wget -qO- --header 'Authorization: Bearer ***' http://admin:***@127.0.0.1:9/health || exit 1",
    shell: true,
    intervalS: 5,
    timeoutS: 3,
    startPeriodS: 2,
    retries: 3,
  },
};
export const UNHEALTHY = container('fx-unhealthy', {
  image: 'busybox:1.37',
  health: 'unhealthy',
  healthDetail: UNHEALTHY_DETAIL,
});
export const OOM = container('fx-oom', {
  image: 'busybox:1.37',
  state: 'exited',
  status: 'Exited (137) 2 minutes ago',
  exitCode: 137,
  oomKilled: true,
  finishedAt: '2026-10-31T06:20:04.881Z',
  memoryLimitBytes: 33554432,
  cpuCores: null,
  memoryBytes: null,
});
export const CRASHLOOP = container('fx-crashloop', {
  image: 'busybox:1.37',
  state: 'restarting',
  restarting: true,
  restartCount: 4,
  exitCode: 2,
  finishedAt: '2026-10-31T06:20:17.968Z',
  cpuCores: null,
  memoryBytes: null,
});
export const CONTAINERS = [
  container('demo-cache-1', {
    composeProject: 'demo',
    composeService: 'cache',
    memoryLimitBytes: 134217728,
  }),
  container('demo-web-1', {
    composeProject: 'demo',
    composeService: 'web',
    health: 'healthy',
    ports: [{ publicPort: 8081, privatePort: 80, protocol: 'tcp' }],
  }),
  container('fx-crashloop', {
    state: 'restarting',
    restartCount: 32,
    cpuCores: null,
    memoryBytes: null,
    problem: {
      severity: 'critical',
      kind: 'Restarting',
      title: 'fx-crashloop keeps restarting',
      reason: 'exited with code 2 · 32 restarts',
      alertId: null,
    },
  }),
  container('fx-unhealthy', {
    health: 'unhealthy',
    problem: {
      severity: 'warning',
      kind: 'Unhealthy',
      title: 'fx-unhealthy container is unhealthy',
      reason: null,
      alertId: null,
    },
  }),
];
