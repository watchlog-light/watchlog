// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  agentImage,
  dockerRecreateCommand,
  dockerRunCommand,
  helmInstallCommand,
  helmUpgradeCommand,
  shellQuote,
} from '../src/modules/clusters/install.js';
import {
  agentContainer,
  agentEbpf,
  type AgentCapabilities,
} from '../src/modules/servicemap/ebpf-fix.js';

const TOKEN = `wl_ct_${'A'.repeat(20)}-_${'z'.repeat(21)}`;

describe('dockerRunCommand', () => {
  const cmd = dockerRunCommand({
    token: TOKEN,
    endpoint: 'https://watchlog.example.com',
    image: 'ghcr.io/watchlog-light/agent:latest',
  });

  it('runs as uid 0 with only BPF and PERFMON for eBPF flows (ADR-105)', () => {
    expect(cmd).toContain('--user 0:65532 --cap-drop ALL --cap-add BPF --cap-add PERFMON');
    expect(cmd).toContain('--security-opt no-new-privileges');
    expect(cmd.match(/--cap-add/g)).toHaveLength(2);
    expect(cmd).not.toMatch(/--privileged|SYS_ADMIN|SYS_PTRACE|NET_ADMIN/);
  });

  it('mounts host paths read-only', () => {
    expect(cmd).toContain('-v /var/run/docker.sock:/var/run/docker.sock:ro');
    expect(cmd).toContain('-v /proc:/host/proc:ro');
    expect(cmd).toContain('-v /sys:/host/sys:ro');
    expect(cmd).toContain('-v /:/host/root:ro,rslave');
  });

  it('passes the token and endpoint and runs docker mode', () => {
    expect(cmd).toContain(`-e WATCHLOG_TOKEN=${TOKEN}`);
    expect(cmd).toContain('-e WATCHLOG_ENDPOINT=https://watchlog.example.com');
    expect(cmd.trimEnd().endsWith('ghcr.io/watchlog-light/agent:latest --mode=docker')).toBe(true);
  });

  it('is valid POSIX shell', () => {
    expect(() => execFileSync('sh', ['-n', '-c', cmd])).not.toThrow();
  });

  it('quotes unusual endpoint values safely', () => {
    const quoted = dockerRunCommand({
      token: TOKEN,
      endpoint: "http://host/it's $(rm -rf /)",
      image: 'img',
    });
    expect(quoted).toContain(`-e WATCHLOG_ENDPOINT='http://host/it'"'"'s $(rm -rf /)'`);
    expect(() => execFileSync('sh', ['-n', '-c', quoted])).not.toThrow();
  });
});

describe('shellQuote and agentImage', () => {
  it('leaves safe values unquoted', () => {
    expect(shellQuote('https://a.example:8080/x')).toBe('https://a.example:8080/x');
    expect(shellQuote('a b')).toBe("'a b'");
  });

  it('pins release versions and uses latest for development builds', () => {
    expect(agentImage('ghcr.io/watchlog-light/agent', '2.1.0')).toBe(
      'ghcr.io/watchlog-light/agent:2.1.0',
    );
    expect(agentImage('ghcr.io/watchlog-light/agent', '0429ac6-dirty')).toBe(
      'ghcr.io/watchlog-light/agent:latest',
    );
  });
});

describe('eBPF fix commands (ADR-107)', () => {
  const docker = {
    endpoint: 'https://watchlog.example.com',
    image: 'ghcr.io/watchlog-light/agent:latest',
  };

  it('upgrades the reported release keeping its values; the umbrella chart prefixes values', () => {
    expect(helmUpgradeCommand({ release: 'watchlog-dev/kind-demo', chart: 'watchlog-agent' })).toBe(
      [
        'helm upgrade kind-demo deploy/helm/watchlog-agent \\',
        '  --namespace watchlog-dev --reuse-values',
      ].join('\n'),
    );
    const umbrella = helmUpgradeCommand({
      release: 'watchlog/watchlog',
      chart: 'watchlog',
      set: ['agent.networkFlows.enabled=true'],
    });
    expect(umbrella).toContain('helm dependency build deploy/helm/watchlog && \\');
    expect(umbrella).toContain('--set watchlog-agent.agent.networkFlows.enabled=true');
    expect(() => execFileSync('sh', ['-n', '-c', umbrella])).not.toThrow();
  });

  it('uses the published chart of a release, without a dependency build', () => {
    const agent = helmUpgradeCommand({
      release: 'watchlog/agents',
      chart: 'watchlog-agent',
      version: '0.1.0',
    });
    expect(agent).toContain(
      'helm upgrade agents oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.1.0 \\',
    );
    const umbrella = helmUpgradeCommand({ release: 'w/w', chart: 'watchlog', version: '0.1.0' });
    expect(umbrella).not.toContain('dependency build');
    expect(umbrella).toContain('oci://ghcr.io/watchlog-light/charts/watchlog --version 0.1.0');
    expect(
      helmInstallCommand({ token: TOKEN, endpoint: 'https://w.example.com', version: '0.1.0' }),
    ).toContain(
      'helm install watchlog-agent oci://ghcr.io/watchlog-light/charts/watchlog-agent --version 0.1.0',
    );
    // Development builds install from the checkout.
    expect(
      helmInstallCommand({ token: TOKEN, endpoint: 'https://w', version: '0.0.0-dev' }),
    ).toContain('helm install watchlog-agent deploy/helm/watchlog-agent');
  });

  it('has placeholders and says how to find them when the release is unknown or invalid', () => {
    for (const release of [undefined, 'ns/rel; rm -rf /']) {
      const cmd = helmUpgradeCommand({ release });
      expect(cmd).toContain('# Find the release and namespace: helm list -A | grep watchlog');
      expect(cmd).toContain('helm upgrade <release> deploy/helm/watchlog-agent');
      expect(cmd).not.toContain('rm -rf');
    }
  });

  it('re-creates a Docker agent with its own token and a new volume', () => {
    const cmd = dockerRecreateCommand(docker);
    expect(cmd).toContain('docker rm -f watchlog-agent && \\');
    expect(cmd).toContain('  -e WATCHLOG_TOKEN \\');
    expect(cmd).toContain('-v watchlog-agent-state:/var/lib/watchlog-agent');
    expect(() => execFileSync('sh', ['-n', '-c', cmd])).not.toThrow();
  });

  it('keeps the name of an agent container that is not called watchlog-agent', () => {
    const cmd = dockerRecreateCommand({ ...docker, name: 'watchlog-agent-dev' });
    expect(cmd).toContain("'{{range .Config.Env}}{{println .}}{{end}}' watchlog-agent-dev |");
    expect(cmd).toContain('docker rm -f watchlog-agent-dev && \\');
    expect(cmd).toContain('docker run -d --name watchlog-agent-dev ');
  });

  it("finds the agent's container by the reported ID, else the only agent image", () => {
    const containers = [
      { uid: 'a'.repeat(64), name: 'watchlog-agent-dev', image: 'watchlog-agent:dev' },
      {
        uid: 'b'.repeat(64),
        name: 'watchlog-backend-1',
        image: 'ghcr.io/watchlog-light/backend:latest',
      },
      { uid: 'c'.repeat(64), name: 'nginx', image: 'nginx:1.29-alpine' },
    ];
    expect(agentContainer(containers)).toBe('watchlog-agent-dev');
    const two = [
      ...containers,
      { uid: 'd'.repeat(64), name: 'old', image: 'ghcr.io/watchlog-light/agent:latest' },
    ];
    expect(agentContainer(two)).toBeUndefined();
    expect(agentContainer(two, 'd'.repeat(64))).toBe('old');
  });

  it('turns causes into fixes: config sets the value, kernel and load have none', () => {
    const fix = (mode: string, caps: AgentCapabilities) => agentEbpf('n1', mode, caps, docker);
    const k8s = { helm_release: 'watchlog-dev/kind-demo', helm_chart: 'watchlog-agent' };
    expect(fix('node', { ebpf: 'enabled' })).toMatchObject({ cause: null, fix: null });
    expect(fix('node', { ebpf: 'disabled', ebpf_cause: 'config', ...k8s }).fix).toContain(
      '--set agent.networkFlows.enabled=true',
    );
    expect(fix('node', { ebpf: 'unsupported', ebpf_cause: 'permission', ...k8s }).fix).toContain(
      'helm upgrade kind-demo',
    );
    expect(fix('node', { ebpf: 'unsupported', ebpf_cause: 'kernel' })).toMatchObject({
      cause: 'kernel',
      fix: null,
    });
    expect(fix('node', { ebpf: 'unsupported', ebpf_cause: 'load' }).fix).toBeNull();
    // Agents from before Phase 4 report "disabled" and nothing else.
    expect(fix('node', { ebpf: 'disabled' })).toMatchObject({ cause: 'outdated' });
    expect(fix('node', { ebpf: 'disabled' }).fix).toContain('helm upgrade <release>');
    expect(fix('docker', { ebpf: 'disabled' }).fix).toContain('docker rm -f watchlog-agent');
  });
});
