// SPDX-License-Identifier: AGPL-3.0-only
// The command that starts the integrations collector on a Docker host (ADR-131), run by
// bash as shown, against a stand-in `docker`: it takes the token and the endpoint from
// the host's agent container, falls back to the Public URL, and stops with a message
// when it has neither.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dockerCollectorCommand } from '../src/modules/clusters/install.js';

const dir = mkdtempSync(join(tmpdir(), 'wl-collector-cmd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the command with a `docker` whose agent container has these variables. */
function run(
  command: string,
  agentEnv: string[],
  agentImage = 'ghcr.io/watchlog-light/agent:demo',
): { out: string; code: number } {
  const docker = join(dir, 'docker');
  writeFileSync(
    docker,
    [
      '#!/usr/bin/env bash',
      'case "$1" in',
      `  inspect) case "$*" in *Config.Image*) echo '${agentImage}' ;; *) printf '%s\\n' ${agentEnv.map((e) => `'${e}'`).join(' ')} ;; esac ;;`,
      '  rm) exit 0 ;;',
      '  run) echo "endpoint=$WATCHLOG_ENDPOINT token=$WATCHLOG_TOKEN args=${*: -2}" ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(docker, 0o755);
  try {
    const out = execFileSync('bash', ['-c', command], {
      env: { PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { status: number; stderr: string };
    return { out: e.stderr, code: e.status };
  }
}

const image = 'ghcr.io/watchlog-light/integrations:0.3.0';

describe('the Docker collector command', () => {
  it("reports where the host's agent reports, with its token", () => {
    const cmd = dockerCollectorCommand({
      fallback: 'https://watchlog.example.com',
      image,
      host: 'docker-01',
    });
    const r = run(cmd, [
      'PATH=/usr/bin',
      'WATCHLOG_TOKEN=wl_ct_abc',
      'WATCHLOG_ENDPOINT=http://192.168.5.2:4080',
    ]);
    expect(r).toEqual({
      code: 0,
      // The host's agent runs the :demo build: the collector runs the same.
      out: `endpoint=http://192.168.5.2:4080 token=wl_ct_abc args=ghcr.io/watchlog-light/integrations:demo --mode=docker\n`,
    });
  });

  it("runs the server's image when the agent's isn't a WatchLog agent image", () => {
    const cmd = dockerCollectorCommand({ fallback: null, image, host: 'docker-01' });
    const r = run(cmd, ['WATCHLOG_TOKEN=t', 'WATCHLOG_ENDPOINT=http://x:4080'], 'myrepo/custom:1');
    expect(r.out).toContain(`args=${image} --mode=docker`);
  });

  it('falls back to the Public URL when the agent has no endpoint set', () => {
    const cmd = dockerCollectorCommand({
      fallback: 'https://watchlog.example.com',
      image,
      host: 'docker-01',
    });
    expect(run(cmd, ['WATCHLOG_TOKEN=wl_ct_abc']).out).toContain(
      'endpoint=https://watchlog.example.com token=wl_ct_abc',
    );
  });

  it('stops and says what to set when there is neither', () => {
    const cmd = dockerCollectorCommand({ fallback: null, image, host: 'docker-01' });
    const r = run(cmd, ['WATCHLOG_TOKEN=wl_ct_abc']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('set the Public URL in Settings → General');
    expect(r.out).not.toContain('endpoint=');
  });
});
