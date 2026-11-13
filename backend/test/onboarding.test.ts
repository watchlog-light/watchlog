// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding (ADR-176): the live connection checklist as JSON and as Server-Sent Events,
// the install code and its manifest, the Cloud install commands, the first-week card and
// the page's funnel events.
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { authorisedScope, type QuerySeries } from '../src/lib/victoria.js';
import { requestWithoutCodes } from '../src/lib/redact.js';
import { resolveInstallCode } from '../src/modules/onboarding/install-codes.js';
import {
  installManifest,
  manifestTemplate,
  podMapService,
  splitAgentImage,
} from '../src/modules/onboarding/manifest.js';
import { onboardingStatus } from '../src/modules/onboarding/status.js';
import { podMapCertificates } from '../src/modules/onboarding/x509.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const CLOUD: Partial<Config> = {
  edition: 'cloud',
  cookieSecure: 'always',
  ingestUrl: 'https://ingest.watchlog.example',
  agentImage: 'ghcr.io/watchlog-light/agent:0.6.0',
};
/** Nothing leaves the test: Have I Been Pwned fails open, Turnstile is off. */
const offline = (async () => new Response('offline', { status: 599 })) as typeof fetch;

async function community() {
  ctx = await createTestContext({ publicUrl: 'https://watchlog.example.com' });
  return { c: ctx, cookie: await setupAdmin(ctx.app) };
}

async function cloud(logStream?: { write: (line: string) => void }) {
  ctx = await createTestContext(
    {
      ...CLOUD,
      ...(logStream ? { logLevel: 'info' } : {}),
      accounts: {
        turnstile: {},
        supportEmail: 'support@watchlog.io',
        sampleUrl: 'https://demo.watchlog.io',
      },
    },
    { fetch: offline, ...(logStream ? { logStream } : {}) },
  );
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: 'sara@acme.example', password: 'a long enough password' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = res.cookies.find((x) => x.name === 'wl_session')!.value;
  return { c: ctx, cookie };
}

function api(c: TestContext, cookie: string) {
  return (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    c.app.inject({ method, url: `/api/v1${url}`, cookies: { wl_session: cookie }, payload });
}

function heartbeat(c: TestContext, token: string, body: Record<string, unknown>) {
  return c.app.inject({
    method: 'POST',
    url: '/ingest/v1/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { agent_version: '0.6.0', series: 10, capabilities: {}, ...body },
  });
}

const step = (status: { steps: { id: string }[] }, id: string) =>
  status.steps.find((s) => s.id === id) as Record<string, unknown> | undefined;

describe('the live connection checklist', () => {
  it('waits, then ticks with the heartbeats, in Community too', async () => {
    const { c, cookie } = await community();
    const call = api(c, cookie);
    const created = (await call('POST', '/clusters', { name: 'kind', kind: 'kubernetes' })).json();
    // Community's install commands are 0.5.0's: no kubectl manifest, no Compose.
    expect(Object.keys(created.install)).toEqual(['helm']);

    const url = `/clusters/${created.cluster.id}/onboarding-status`;
    let res = await call('GET', url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    let s = res.json();
    expect(s.steps.map((x: { id: string }) => x.id)).toEqual([
      'agent',
      'clusterAgent',
      'metrics',
      'ebpf',
      'map',
    ]);
    expect(s.steps.every((x: { state: string }) => x.state === 'waiting')).toBe(true);
    expect(s).toMatchObject({ ready: false, complete: false, kind: 'kubernetes' });

    const token = created.token.value;
    for (const node of ['n1', 'n2']) {
      expect(
        (await heartbeat(c, token, { mode: 'node', node, capabilities: { ebpf: 'enabled' } }))
          .statusCode,
      ).toBe(204);
    }
    s = (await call('GET', url)).json();
    expect(step(s, 'agent')).toMatchObject({ state: 'done', nodes: 2 });
    expect(step(s, 'agent')!.since).toEqual(expect.any(String));
    expect(step(s, 'clusterAgent')).toMatchObject({ state: 'waiting' });
    expect(step(s, 'ebpf')).toMatchObject({ state: 'done', enabled: 2, agents: 2 });

    await heartbeat(c, token, { mode: 'cluster', node: 'cluster-agent' });
    s = (await call('GET', url)).json();
    expect(step(s, 'clusterAgent')).toMatchObject({ state: 'done' });
    expect(step(s, 'agent')).toMatchObject({ nodes: 2 });

    // An agent without eBPF: the step says why and how to fix it (ADR-107).
    await heartbeat(c, token, {
      mode: 'node',
      node: 'n3',
      capabilities: {
        ebpf: 'unsupported',
        ebpf_reason: 'kernel 4.19 has no BTF',
        ebpf_cause: 'kernel',
      },
    });
    res = await call('GET', url);
    s = res.json();
    expect(step(s, 'ebpf')).toMatchObject({
      state: 'off',
      enabled: 2,
      agents: 3,
      node: 'n3',
      reason: 'kernel 4.19 has no BTF',
      cause: 'kernel',
      fix: null,
    });
  });

  it('another org, or an unknown cluster, gets 404', async () => {
    const { c, cookie } = await community();
    const res = await api(c, cookie)(
      'GET',
      '/clusters/01a1c446-0000-7000-8000-000000000000/onboarding-status',
    );
    expect(res.statusCode).toBe(404);
  });

  it('counts the first metrics and the map edges as the map draws them', async () => {
    const { c, cookie } = await community();
    const created = (
      await api(c, cookie)('POST', '/clusters', { name: 'hosts', kind: 'docker' })
    ).json();
    await heartbeat(c, created.token.value, {
      mode: 'docker',
      node: 'host-1',
      capabilities: { ebpf: 'enabled' },
    });
    const asked: string[] = [];
    const series = (labels: Record<string, string>, v: number): QuerySeries => ({
      labels,
      points: [[0, v]],
    });
    const victoria = {
      query: async (_scope: unknown, expr: string) => {
        asked.push(expr);
        if (expr.includes('watchlog_node_cpu_count')) return [series({}, 1)];
        if (expr.includes('watchlog_container_memory')) return [series({}, 7)];
        return [
          series(
            {
              compose_project: 'shop',
              compose_service: 'web',
              container: 'shop-web-1',
              dst_kind: 'container',
              dst: 'shop-db-1',
              dst_port: '5432',
            },
            3,
          ),
        ];
      },
    };
    const row = await c.db
      .selectFrom('clusters')
      .selectAll()
      .where('id', '=', created.cluster.id)
      .executeTakeFirstOrThrow();
    const s = await onboardingStatus(
      {
        db: c.db,
        victoria: victoria as never,
        install: { endpoint: 'https://x.example', image: 'ghcr.io/watchlog-light/agent:latest' },
      },
      { ...row, scope: authorisedScope(row.id) },
    );
    expect(s.kind).toBe('docker');
    expect(s.steps.map((x) => x.id)).toEqual(['agent', 'metrics', 'ebpf', 'map']);
    expect(step(s, 'metrics')).toMatchObject({ state: 'done', nodes: 1, containers: 7 });
    expect(step(s, 'map')).toMatchObject({ state: 'done', connections: 1 });
    expect((step(s, 'map')!.services as number) >= 2).toBe(true);
    expect(s).toMatchObject({ ready: true, complete: true });
    expect(asked.some((e) => e.includes('watchlog_flow_connections_total'))).toBe(true);
  });

  it('streams Server-Sent Events: the status now, then each change', async () => {
    const { c, cookie } = await community();
    const created = (
      await api(c, cookie)('POST', '/clusters', { name: 'fleet', kind: 'docker' })
    ).json();
    await c.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = c.app.server.address() as AddressInfo;
    const abort = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/clusters/${created.cluster.id}/onboarding-status`,
      {
        headers: { accept: 'text/event-stream', cookie: `wl_session=${cookie}` },
        signal: abort.signal,
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    const events: { event: string; data: { steps: { id: string; state: string }[] } }[] = [];
    async function next() {
      for (;;) {
        const end = text.indexOf('\n\n');
        if (end >= 0) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) return { event: ev, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        text += new TextDecoder().decode(value);
      }
    }
    events.push(await next());
    expect(events[0]!.event).toBe('status');
    expect(step(events[0]!.data, 'agent')).toMatchObject({ state: 'waiting' });
    await heartbeat(c, created.token.value, { mode: 'docker', node: 'host-1' });
    events.push(await next());
    expect(step(events[1]!.data, 'agent')).toMatchObject({ state: 'done', nodes: 1 });
    abort.abort();
  }, 20_000);
});

describe('the install code and its manifest (Cloud)', () => {
  it('kubectl names the manifest by code; the manifest carries the token and new certificates', async () => {
    const lines: string[] = [];
    const { c, cookie } = await cloud({ write: (l) => void lines.push(l) });
    const call = api(c, cookie);
    const created = (await call('POST', '/clusters', { name: 'kind', kind: 'kubernetes' })).json();
    expect(created.install.helm).toContain(`watchlog.clusterToken=${created.token.value}`);
    expect(created.install.helm).toContain('https://ingest.watchlog.example');
    const m =
      /^kubectl apply -f 'https:\/\/ingest\.watchlog\.example\/install\.yaml\?code=(wl_ic_[A-Za-z0-9_-]{43})'$/.exec(
        created.install.kubectl,
      );
    expect(m, created.install.kubectl).not.toBeNull();
    expect(created.install.kubectl).not.toContain(created.token.value);
    const code = m![1]!;
    const hours = (Date.parse(created.install.installCodeExpiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    // At rest: the code's hash, and the token only encrypted.
    const row = await c.db.selectFrom('install_codes').selectAll().executeTakeFirstOrThrow();
    expect(row.code_hash.toString('hex')).not.toContain(code);
    expect(row.token_ciphertext).not.toContain(created.token.value);

    const res = await c.app.inject({ method: 'GET', url: `/install.yaml?code=${code}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/yaml/);
    expect(res.headers['cache-control']).toBe('no-store');
    const yaml = res.body;
    expect(yaml).toContain(`token: ${Buffer.from(created.token.value).toString('base64')}`);
    expect(yaml).toContain('value: "https://ingest.watchlog.example"');
    expect(yaml).toContain('image: ghcr.io/watchlog-light/agent:0.6.0');
    expect(yaml).toContain('image: ghcr.io/watchlog-light/cluster-agent:0.6.0');
    expect(yaml).toMatch(/kind: Namespace\nmetadata:\n {2}name: watchlog\n/);
    expect(yaml).not.toMatch(/WATCHLOG_INSTALL_|WATCHLOG_PODMAP_(CA|TLS)_/);
    // A new CA and certificate in every manifest, valid for the cluster-agent's service.
    const pem = (key: string, text: string) =>
      Buffer.from(
        new RegExp(`^  ${key.replace('.', '\\.')}: (\\S+)$`, 'm').exec(text)![1]!,
        'base64',
      ).toString();
    const ca = new X509Certificate(pem('ca.crt', yaml));
    const leaf = new X509Certificate(pem('tls.crt', yaml));
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost(podMapService())).toBe(podMapService());
    const again = (await c.app.inject({ method: 'GET', url: `/install.yaml?code=${code}` })).body;
    expect(pem('ca.crt', again)).not.toBe(pem('ca.crt', yaml));
    // The code never reaches the log.
    expect(lines.join('\n')).not.toContain(code);
    expect(lines.join('\n')).toContain('code=****');

    expect(
      (await c.app.inject({ method: 'GET', url: '/install.yaml?code=wl_ic_nope' })).statusCode,
    ).toBe(404);
  });

  it('a token rotation, a revoked token or 24 hours end the code', async () => {
    const { c, cookie } = await cloud();
    const call = api(c, cookie);
    const created = (await call('POST', '/clusters', { name: 'kind', kind: 'kubernetes' })).json();
    const codeOf = (kubectl: string) => /code=(wl_ic_[\w-]+)/.exec(kubectl)![1]!;
    const first = codeOf(created.install.kubectl);
    expect(await resolveInstallCode(c.db, first)).toMatchObject({
      token: created.token.value,
      clusterId: created.cluster.id,
    });
    // 24 hours later.
    expect(await resolveInstallCode(c.db, first, new Date(Date.now() + 86_400_001))).toBeNull();

    const issued = (await call('POST', `/clusters/${created.cluster.id}/tokens`)).json();
    expect(await resolveInstallCode(c.db, first)).toBeNull();
    const second = codeOf(issued.install.kubectl);
    expect((await resolveInstallCode(c.db, second))?.token).toBe(issued.token.value);

    await call('DELETE', `/clusters/${created.cluster.id}/tokens/${issued.token.id}`);
    expect(await resolveInstallCode(c.db, second)).toBeNull();
    expect(
      (await c.app.inject({ method: 'GET', url: `/install.yaml?code=${second}` })).statusCode,
    ).toBe(404);
  });

  it('Docker gets docker run and Compose, no kubectl', async () => {
    const { c, cookie } = await cloud();
    const created = (
      await api(c, cookie)('POST', '/clusters', { name: 'hosts', kind: 'docker' })
    ).json();
    expect(Object.keys(created.install).sort()).toEqual(['compose', 'dockerRun']);
    expect(created.install.compose).toContain(`WATCHLOG_TOKEN: "${created.token.value}"`);
    expect(created.install.compose).toContain(
      'WATCHLOG_ENDPOINT: "https://ingest.watchlog.example"',
    );
    expect(created.install.compose).toContain('image: "ghcr.io/watchlog-light/agent:0.6.0"');
    expect(created.install.compose).toContain('cap_add: [BPF, PERFMON]');
  });

  it('Community has no /install.yaml, no first-week card and no funnel', async () => {
    const { c, cookie } = await community();
    const call = api(c, cookie);
    expect(
      (await c.app.inject({ method: 'GET', url: '/install.yaml?code=wl_ic_x' })).statusCode,
    ).toBe(404);
    expect((await call('GET', '/onboarding/first-week')).statusCode).toBe(404);
    expect((await call('POST', '/funnel', { name: 'install_command_copied' })).statusCode).toBe(
      404,
    );
  });
});

describe('the manifest template', () => {
  it('has each placeholder the backend fills, and the namespace on every namespaced object', () => {
    const t = manifestTemplate();
    expect(t.match(/token: V0FUQ0hMT0dfSU5TVEFMTF9UT0tFTg==/g)).toHaveLength(1);
    for (const p of [
      'WATCHLOG_PODMAP_CA_CRT',
      'WATCHLOG_PODMAP_TLS_CRT',
      'WATCHLOG_PODMAP_TLS_KEY',
    ])
      expect(t.split(p)).toHaveLength(2);
    expect(t).toContain('"WATCHLOG_INSTALL_ENDPOINT"');
    expect(t).toContain('WATCHLOG_INSTALL_REGISTRY/agent:WATCHLOG_INSTALL_TAG');
    const docs = t.split(/^---$/m).filter((d) => /^kind: /m.test(d));
    for (const d of docs) {
      const kind = /^kind: (\w+)/m.exec(d)![1]!;
      if (['Namespace', 'ClusterRole', 'ClusterRoleBinding'].includes(kind)) continue;
      expect(d, kind).toMatch(/^metadata:\n {2}namespace: watchlog$/m);
    }
    expect(podMapService()).toBe('watchlog-agent-cluster-agent.watchlog.svc');
  });

  it('splits agent images and quotes the endpoint', () => {
    expect(splitAgentImage('ghcr.io/watchlog-light/agent:0.6.0')).toEqual({
      registry: 'ghcr.io/watchlog-light',
      tag: '0.6.0',
    });
    expect(splitAgentImage('registry.local:5000/w/agent')).toEqual({
      registry: 'registry.local:5000/w',
      tag: 'latest',
    });
    expect(() => splitAgentImage('busybox')).toThrow();
    const y = installManifest({
      token: 'wl_ct_x',
      endpoint: 'https://a.example/"x"',
      image: 'r.example/agent:1',
    });
    expect(y).toContain('value: "https://a.example/\\"x\\""');
  });

  it('makes a CA and a certificate Go and OpenSSL accept', () => {
    const svc = 'watchlog-agent-cluster-agent.watchlog.svc';
    const c = podMapCertificates(svc, new Date('2026-11-13T00:00:00Z'));
    const ca = new X509Certificate(c.caCrt);
    const leaf = new X509Certificate(c.tlsCrt);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe(`DNS:${svc}, DNS:${svc}.cluster.local`);
    expect(new Date(leaf.validTo).getUTCFullYear()).toBe(2036);
    expect(c.tlsKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });
});

describe('request logs', () => {
  it('mask the value of code= in the URL', () => {
    expect(
      requestWithoutCodes({ method: 'GET', url: '/install.yaml?code=wl_ic_secret&x=1' }).url,
    ).toBe('/install.yaml?code=****&x=1');
    expect(requestWithoutCodes({ method: 'GET', url: '/cb?state=s&code=abc' }).url).toBe(
      '/cb?state=s&code=****',
    );
  });
});

describe('the first-week card (Cloud)', () => {
  it('reads real state, says Free cannot invite, and is dismissed per user', async () => {
    const { c, cookie } = await cloud();
    const call = api(c, cookie);
    let res = await call('GET', '/onboarding/first-week');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      dismissed: false,
      steps: [
        { id: 'channel', done: false, blocked: null },
        { id: 'teammate', done: false, blocked: 'plan-limit' },
        { id: 'application', done: false, blocked: null },
        { id: 'mcp', done: false, blocked: null },
        { id: 'problem', done: false, blocked: null },
      ],
    });
    const ch = await call('POST', '/alert-channels', {
      type: 'slack',
      name: 'Slack',
      settings: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' },
      useForAllRules: true,
    });
    expect(ch.statusCode, ch.body).toBe(201);
    res = await call('GET', '/onboarding/first-week');
    expect(res.json().steps[0]).toEqual({ id: 'channel', done: true, blocked: null });
    const state = await c.db.selectFrom('onboarding_states').selectAll().executeTakeFirstOrThrow();
    expect(state.reported).toEqual(['channel']);

    expect((await call('POST', '/onboarding/first-week/dismiss')).statusCode).toBe(204);
    expect((await call('GET', '/onboarding/first-week')).json().dismissed).toBe(true);
  });

  it('takes only the funnel events the page may send', async () => {
    const { c, cookie } = await cloud();
    const call = api(c, cookie);
    expect(
      (await call('POST', '/funnel', { name: 'install_command_copied', props: { method: 'helm' } }))
        .statusCode,
    ).toBe(204);
    expect((await call('POST', '/funnel', { name: 'signup_completed' })).statusCode).toBe(400);
    expect(
      (
        await call('POST', '/funnel', {
          name: 'install_command_copied',
          props: { method: 'Not a method' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await c.app.inject({
          method: 'POST',
          url: '/api/v1/funnel',
          payload: { name: 'install_command_copied' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
