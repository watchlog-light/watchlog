// SPDX-License-Identifier: AGPL-3.0-only
// Install commands shown when a cluster or token is created: `docker run` for Docker
// fleets (ADR-023, ADR-105: BPF and PERFMON only, read-only mounts) and `helm install` of
// the agent chart for Kubernetes (ADR-059); and the upgrade commands that fix an agent
// without eBPF (ADR-107).
import type { FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { SettingsService } from '../settings/service.js';

/** Charts in a repository checkout, for development builds. */
export const CHART_PATHS: Record<string, string> = {
  'watchlog-agent': 'deploy/helm/watchlog-agent',
  watchlog: 'deploy/helm/watchlog',
};
/** Where releases publish the charts (.github/workflows/release.yml). */
export const CHART_REGISTRY = 'oci://ghcr.io/watchlog-light/charts';

const RELEASE = /^\d+\.\d+\.\d+$/;

/**
 * A chart as helm arguments: the published chart of this release, or the checkout's
 * chart for development builds (the watchlog chart then needs its dependency built).
 */
export function chartSource(chart: 'watchlog-agent' | 'watchlog', version?: string) {
  if (version && RELEASE.test(version)) {
    return { ref: `${CHART_REGISTRY}/${chart} --version ${version}`, prepare: undefined };
  }
  const path = CHART_PATHS[chart]!;
  return {
    ref: path,
    prepare: chart === 'watchlog' ? `helm dependency build ${path} && \\` : undefined,
  };
}

/** Names the token variable instead of a value: `-e WATCHLOG_TOKEN` takes it from the shell. */
export const TOKEN_FROM_ENV = Symbol('token from the environment');

export interface InstallOptions {
  token: string | typeof TOKEN_FROM_ENV;
  /** Base URL the agent pushes to, e.g. https://watchlog.example.com */
  endpoint: string;
  image: string;
  /** Container name; watchlog-agent unless an existing agent has another. */
  name?: string;
}

/** Quotes a value for POSIX shells. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function dockerRunCommand({
  token,
  endpoint,
  image,
  name = 'watchlog-agent',
}: InstallOptions): string {
  return [
    `docker run -d --name ${shellQuote(name)} --restart unless-stopped \\`,
    '  --pid host \\',
    // eBPF network flows (ADR-105): uid 0 with only BPF and PERFMON; group 65532 owns
    // the data volume; root owns the Docker socket.
    '  --user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON \\',
    '  --security-opt no-new-privileges \\',
    '  -v /var/run/docker.sock:/var/run/docker.sock:ro \\',
    '  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro,rslave \\',
    // A new name since Phase 4 (ADR-107): volumes of earlier installs are 0755 and owned
    // by uid 65532, which uid 0 without DAC_OVERRIDE cannot write.
    '  -v watchlog-agent-state:/var/lib/watchlog-agent \\',
    token === TOKEN_FROM_ENV
      ? '  -e WATCHLOG_TOKEN \\'
      : `  -e WATCHLOG_TOKEN=${shellQuote(token)} \\`,
    `  -e WATCHLOG_ENDPOINT=${shellQuote(endpoint)} \\`,
    `  ${shellQuote(image)} --mode=docker`,
  ].join('\n');
}

/** Agent image matching the backend release, or `latest` for development builds. */
export function agentImage(registry: string, backendVersion: string): string {
  const tag = /^\d+\.\d+\.\d+$/.test(backendVersion) ? backendVersion : 'latest';
  return `${registry}:${tag}`;
}

/** Installs the agent chart: the published one for releases, the checkout's otherwise. */
export function helmInstallCommand({
  token,
  endpoint,
  version,
}: {
  token: string;
  endpoint: string;
  /** The backend's version: a release installs the chart published with it. */
  version?: string;
}): string {
  // The node agent's read-only hostPath mounts need the privileged PodSecurity level;
  // the command creates and labels the namespace so it works where PodSecurity
  // enforces baseline or restricted (ADR-070 as accepted).
  return [
    'kubectl create namespace watchlog && \\',
    'kubectl label namespace watchlog pod-security.kubernetes.io/enforce=privileged && \\',
    `helm install watchlog-agent ${chartSource('watchlog-agent', version).ref} \\`,
    '  --namespace watchlog \\',
    `  --set watchlog.endpoint=${shellQuote(endpoint)} \\`,
    `  --set watchlog.clusterToken=${shellQuote(token)}`,
  ].join('\n');
}

export interface HelmUpgrade {
  /** namespace/release as the chart reports it, or unknown for charts before Phase 4. */
  release?: string;
  /** watchlog-agent, or watchlog when the agents are its subchart. */
  chart?: string;
  /** Agent chart values to set, e.g. agent.networkFlows.enabled=true. */
  set?: string[];
  /** The backend's version (see chartSource). */
  version?: string;
}

/**
 * Upgrades a release to the chart in the checkout, keeping its values: the chart turns
 * eBPF on for values from before Phase 4 (ADR-107). Without a known release the command
 * has placeholders and says how to find them.
 */
export function helmUpgradeCommand({ release, chart, set = [], version }: HelmUpgrade): string {
  const [namespace, name] =
    release && /^[a-z0-9.-]+\/[a-z0-9.-]+$/.test(release) ? release.split('/') : [];
  const umbrella = chart === 'watchlog';
  const source = chartSource(umbrella ? 'watchlog' : 'watchlog-agent', version);
  const lines = [
    ...(name ? [] : ['# Find the release and namespace: helm list -A | grep watchlog']),
    ...(source.prepare ? [source.prepare] : []),
    `helm upgrade ${name ?? '<release>'} ${source.ref} \\`,
    `  --namespace ${namespace ?? '<namespace>'} --reuse-values${set.length ? ' \\' : ''}`,
    ...set.map(
      (v, i) =>
        `  --set ${umbrella ? 'watchlog-agent.' : ''}${v}${i < set.length - 1 ? ' \\' : ''}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * Re-creates the Docker agent with the current install command, keeping the name and
 * token of the running container.
 */
export function dockerRecreateCommand({
  endpoint,
  image,
  name = 'watchlog-agent',
}: {
  endpoint: string;
  image: string;
  name?: string;
}) {
  const c = shellQuote(name);
  return [
    `export WATCHLOG_TOKEN="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${c} | sed -n 's/^WATCHLOG_TOKEN=//p')" && \\`,
    `docker rm -f ${c} && \\`,
    dockerRunCommand({ token: TOKEN_FROM_ENV, endpoint, image, name }),
  ].join('\n');
}

/**
 * Starts the integrations collector on a Docker host (ADR-131, ADR-134), with the token
 * and the endpoint of the agent already running there: the collector reports where that
 * agent does, which the host can reach (the browser's address may be `localhost`).
 * `fallback`, the ingest or Public URL, is used when the agent has no endpoint set; with
 * neither, the command stops and says so. The image is the agent's with /integrations
 * for /agent (same registry and tag), else `image`. Host network, uid 0 with every capability
 * dropped, read-only, and /etc/watchlog/secrets mounted read-only for passwords kept in
 * files. Running it again replaces it.
 */
export function dockerCollectorCommand({
  fallback,
  image,
  host,
  agent = 'watchlog-agent',
}: {
  fallback: string | null;
  image: string;
  host: string;
  agent?: string;
}): string {
  const env = (name: string) =>
    `"$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${shellQuote(agent)} | sed -n 's/^${name}=//p')"`;
  const missing = fallback
    ? `export WATCHLOG_ENDPOINT="\${WATCHLOG_ENDPOINT:-${fallback.replace(/["$`\\]/g, '\\$&')}}" && \\`
    : `: "\${WATCHLOG_ENDPOINT:?the ${agent} container has no WATCHLOG_ENDPOINT: set the Public URL in Settings → General}" && \\`;
  // The collector image next to the agent's (same registry and tag), else the server's.
  const sameAsAgent = `"$(docker inspect --format '{{.Config.Image}}' ${shellQuote(agent)} | sed -n 's#/agent\\([:@]\\)#/integrations\\1#p')"`;
  return [
    `export WATCHLOG_TOKEN=${env('WATCHLOG_TOKEN')} WATCHLOG_ENDPOINT=${env('WATCHLOG_ENDPOINT')} && \\`,
    missing,
    `image=${sameAsAgent} && \\`,
    'docker rm -f watchlog-integrations 2>/dev/null; \\',
    'docker run -d --name watchlog-integrations --restart unless-stopped \\',
    '  --network host --user 0:0 --cap-drop ALL --read-only \\',
    '  --tmpfs /var/lib/watchlog-integrations --security-opt no-new-privileges \\',
    '  -v /etc/watchlog/secrets:/etc/watchlog/secrets:ro \\',
    '  -e WATCHLOG_TOKEN -e WATCHLOG_ENDPOINT \\',
    `  -e WATCHLOG_HOSTNAME=${shellQuote(host)} \\`,
    `  "\${image:-${image.replace(/["$`\\]/g, '\\$&')}}" --mode=docker`,
  ].join('\n');
}

/** The collector's image next to the agent's: same registry and tag. */
export function integrationsImage(agent: string): string {
  return agent.replace(/\/agent(?=[:@]|$)/, '/integrations');
}

/** Where agents push to and which image they run, for install and upgrade commands. */
export function installTarget(config: Config, settings: SettingsService) {
  return {
    image: config.agentImage ?? agentImage('ghcr.io/watchlog-light/agent', config.version),
    version: config.version,
    /** The ingest or Public URL when one is set: what a host can reach for sure. */
    async configuredEndpoint(): Promise<string | null> {
      const base = config.ingestUrl ?? (await settings.publicUrl()).value;
      return base ? base.replace(/\/+$/, '') : null;
    },
    async endpointFor(request: FastifyRequest): Promise<string> {
      const base =
        config.ingestUrl ??
        (await settings.publicUrl()).value ??
        `${request.protocol}://${request.host}`;
      return base.replace(/\/+$/, '');
    },
  };
}
