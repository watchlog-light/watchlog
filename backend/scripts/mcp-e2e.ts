// SPDX-License-Identifier: AGPL-3.0-only
// The MCP server end to end with real clients (v0.2 slice 6, ADR-127): run by
// deploy/test/k8s/mcp-e2e.sh against a WatchLog with a kind cluster and a Docker host
// reporting (deploy/test/demo-up.sh). It makes an API token, then:
//   - the SDK client, in the 2026-07-28 and the 2025 protocol generations: the tools are
//     listed and read-only, get_problems names the crash-looping and OOM-killed pods and
//     containers, get_pod gives their exit codes;
//   - Claude Desktop's path: `npx mcp-remote` over stdio, as claude_desktop_config.json
//     runs it, with the token in an environment variable;
//   - Claude Code (`claude -p`, when installed and CLAUDE is not 0), once per kind of
//     cluster with "What's wrong with my clusters?": which tools it called, and whether
//     its answer names the real problems. Transcripts go to WATCHLOG_E2E_OUT;
//   - Cursor when its `cursor-agent` CLI is installed (skipped otherwise);
//   - revoking the token stops the next call.
// The token is revoked at the end whatever happens. It never appears in the output.
//
// `mcp-e2e.ts causes` (run by deploy/test/causes-e2e.sh mcp, v0.4 slice 5, ADR-148): the
// probable cause over MCP against the triggered scenarios of causes-e2e.sh (its SCENARIOS
// table, the rows that are on): explain_problem gives each scenario's expected top cause,
// likely; get_problems carries it as likelyCause on the scenario's problems; explain_alert's
// causes agree with them; on the kind cluster and the Docker host.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const BASE = (process.env.WATCHLOG_URL ?? 'http://localhost:4080').replace(/\/+$/, '');
const OUT = process.env.WATCHLOG_E2E_OUT ?? join(tmpdir(), 'watchlog-mcp-e2e');
/** Pinned: the newest release at least two weeks old when this was written. */
const MCP_REMOTE = 'mcp-remote@0.15.2';
const QUESTION = "What's wrong with my clusters?";
const TOOLS = 14;

interface Cluster {
  id: string;
  name: string;
  kind: 'kubernetes' | 'docker';
  status: string;
  lastSeenAt: string | null;
}

const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}
const skip = (name: string, why: string) => console.log(`SKIP ${name} — ${why}`);

async function session(): Promise<string> {
  if (process.env.WATCHLOG_E2E_COOKIE) return `wl_session=${process.env.WATCHLOG_E2E_COOKIE}`;
  const email = process.env.WATCHLOG_E2E_EMAIL;
  const password = process.env.WATCHLOG_E2E_PASSWORD;
  if (!email || !password) {
    throw new Error('set WATCHLOG_E2E_EMAIL and WATCHLOG_E2E_PASSWORD (or WATCHLOG_E2E_COOKIE)');
  }
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in: ${res.status}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('wl_session='));
  if (!cookie) throw new Error('sign-in: no session cookie');
  return cookie.split(';')[0]!;
}

async function api<T>(cookie: string, method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A cluster of a kind that reported in the last 5 minutes (or the one named in env). */
function pick(clusters: Cluster[], kind: Cluster['kind'], wanted?: string): Cluster {
  const fresh = (c: Cluster) => !!c.lastSeenAt && Date.now() - Date.parse(c.lastSeenAt) < 300_000;
  const c = clusters.find((x) => x.kind === kind && (wanted ? x.name === wanted : fresh(x)));
  if (!c || !fresh(c)) {
    throw new Error(
      `no ${kind} cluster reporting${wanted ? ` named ${wanted}` : ''}: run deploy/test/demo-up.sh first`,
    );
  }
  return c;
}

async function httpClient(token: string, mode: 'legacy' | { pin: string }) {
  const client = new Client(
    { name: 'watchlog-mcp-e2e', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  client: Client,
  name: string,
  args: Json,
): Promise<{ isError: boolean; data: Json }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  return { isError: res.isError === true, data: JSON.parse(text) as Json };
}

/** The objects get_problems names, by type: "crashloop" → ["crashloop", …]. */
function problemNames(data: Json): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of (data.problems ?? []) as Json[]) {
    const name = (p.object?.name ?? p.object?.pod ?? p.object?.container) as string | undefined;
    if (name) (out[p.type as string] ??= []).push(name);
  }
  return out;
}

/** The checks every client runs: the tools, and the real problems of both clusters. */
async function contract(label: string, client: Client, kube: Cluster, docker: Cluster) {
  const { tools } = await client.listTools();
  check(`${label}: ${TOOLS} tools`, tools.length === TOOLS, `${tools.length}`);
  check(
    `${label}: every tool read-only`,
    tools.every((t) => t.annotations?.readOnlyHint === true),
  );

  const k = await call(client, 'get_problems', { cluster: kube.name });
  const kn = Object.values(problemNames(k.data)).flat();
  check(
    `${label}: Kubernetes problems name the crash-looping pod`,
    kn.includes('crashloop'),
    kn.join(', '),
  );
  check(`${label}: Kubernetes problems name the OOM-killed pod`, kn.includes('oom'));
  const pod = await call(client, 'get_pod', {
    cluster: kube.name,
    namespace: 'wl-test',
    name: 'oom',
  });
  const term = pod.data.pod?.lastTermination ?? pod.data.containers?.[0]?.lastTermination;
  check(
    `${label}: get_pod gives the OOM kill and its exit code`,
    term?.reason === 'OOMKilled' && term?.exitCode === 137,
    JSON.stringify(term),
  );

  const d = await call(client, 'get_problems', { cluster: docker.name });
  const dn = problemNames(d.data);
  const all = Object.values(dn).flat();
  check(
    `${label}: Docker problems name the restarting container`,
    all.includes('fx-crashloop'),
    all.join(', '),
  );
  check(
    `${label}: Docker problems name the OOM-killed container`,
    (dn.oom ?? []).includes('fx-oom'),
  );
  const ctr = await call(client, 'get_pod', { cluster: docker.name, name: 'fx-oom' });
  check(
    `${label}: get_pod gives the container's OOM kill and exit code`,
    ctr.data.container?.oomKilled === true && ctr.data.container?.exitCode === 137,
    JSON.stringify({ oom: ctr.data.container?.oomKilled, exit: ctr.data.container?.exitCode }),
  );
}

/** One `claude -p` run, its tool calls and answer, saved as a transcript. */
async function claudeCode(token: string, cluster: Cluster, expect: string[]) {
  mkdirSync(OUT, { recursive: true });
  const config = join(OUT, `.mcp-${process.pid}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        watchlog: {
          type: 'http',
          url: `${BASE}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  const focus = `This test session looks at one cluster: answer about the ${cluster.kind === 'docker' ? 'Docker fleet' : 'Kubernetes cluster'} named "${cluster.name}" only.`;
  const started = Date.now();
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'claude',
        [
          '-p',
          QUESTION,
          '--mcp-config',
          config,
          '--strict-mcp-config',
          '--tools',
          '',
          '--allowedTools',
          'mcp__watchlog',
          '--append-system-prompt',
          focus,
          '--output-format',
          'stream-json',
          '--verbose',
          '--no-session-persistence',
        ],
        { cwd: OUT, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.stderr.on('data', (b) => (stderr += b));
      const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      });
    });
    const events = out
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Json);
    const calls: { name: string; input: Json }[] = [];
    for (const e of events) {
      if (e.type !== 'assistant') continue;
      for (const c of (e.message?.content ?? []) as Json[]) {
        if (c.type === 'tool_use')
          calls.push({ name: String(c.name).replace(/^mcp__watchlog__/, ''), input: c.input });
      }
    }
    const result = events.find((e) => e.type === 'result') ?? {};
    const answer = String(result.result ?? '');
    const lower = answer.toLowerCase();
    const named = expect.filter((n) => lower.includes(n.toLowerCase()));
    const file = join(OUT, `claude-code-${cluster.kind}.md`);
    writeFileSync(
      file,
      [
        `# Claude Code and WatchLog MCP: ${cluster.kind}`,
        '',
        `- **Question:** ${QUESTION}`,
        `- **Focus (appended system prompt):** ${focus}`,
        `- **Claude Code:** ${spawnSync('claude', ['--version']).stdout.toString().trim()}`,
        `- **When:** ${new Date(started).toISOString()}, ${((Date.now() - started) / 1000).toFixed(0)} s, ${result.num_turns ?? '?'} turns`,
        `- **Tools called (${calls.length}):**`,
        ...calls.map((c, i) => `  ${i + 1}. \`${c.name}\` ${JSON.stringify(c.input)}`),
        `- **Expected in the answer:** ${expect.join(', ')}; **found:** ${named.join(', ') || 'none'}`,
        '',
        '## Answer',
        '',
        answer,
        '',
      ].join('\n'),
    );
    console.log(`     transcript: ${file}`);
    check(
      `Claude Code (${cluster.kind}): called get_problems`,
      calls.some((c) => c.name === 'get_problems'),
      calls.map((c) => c.name).join(' → '),
    );
    check(
      `Claude Code (${cluster.kind}): the answer names the real problems`,
      named.length === expect.length,
      `${named.join(', ')} of ${expect.join(', ')}`,
    );
  } finally {
    rmSync(config, { force: true });
  }
}

/** A tool call; waits out the per-token rate limit (60 calls a minute) and calls again. */
async function paced(client: Client, name: string, args: Json) {
  for (;;) {
    const r = await call(client, name, args);
    const wait = r.isError ? Number(r.data.retryAfterSeconds) : NaN;
    if (!Number.isFinite(wait)) return r;
    console.log(`     (rate limited: waiting ${wait} s)`);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
  }
}

const CATALOG = new Set([
  'dependency_down',
  'bad_change',
  'oom_limit',
  'crash_exit',
  'image_pull',
  'unschedulable',
  'node_or_host',
  'application_finding',
  'connection_refused',
  'dns_nxdomain',
  'cpu_throttled',
  'job_failed',
]);

/**
 * Whether a get_problems item is about a scenario's object: the alert's labels or the
 * problem's object name the workload (kind), the container or Compose service (Docker),
 * or the monitored service.
 */
function about(p: Json, kind: Cluster['kind'], subject: string): boolean {
  const [k, ref] = [
    subject.slice(0, subject.indexOf(':')),
    subject.slice(subject.indexOf(':') + 1),
  ];
  const o = (p.object ?? {}) as Json;
  if (k === 'application') return o.service_name === ref;
  const parts = ref.split('/');
  const last = parts[parts.length - 1]!;
  if (kind === 'kubernetes') {
    const ns = parts[0];
    if (o.namespace !== ns) return false;
    return o.workload === last || (o.kind === 'Pod' && String(o.name).startsWith(`${last}-`));
  }
  const names = k === 'compose_service' ? [`${parts[0]}-${last}-1`] : [last];
  return names.includes(o.container) || (o.kind === 'Container' && names.includes(o.name));
}

async function causesMain() {
  const rows = (process.env.SCENARIOS ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r.length === 7 && r[6] === 'on');
  const only = (process.env.MCP_E2E_SCENARIOS ?? '').split(/\s+/).filter(Boolean);
  const chosen = only.length ? rows.filter((r) => only.includes(r[0]!)) : rows;
  if (!chosen.length) throw new Error('no scenario to check (SCENARIOS from causes-e2e.sh)');
  const cookie = await session();
  const { clusters } = await api<{ clusters: Cluster[] }>(cookie, 'GET', '/clusters');
  const kube = pick(clusters, 'kubernetes', process.env.WATCHLOG_E2E_KUBE);
  const docker = pick(clusters, 'docker', process.env.WATCHLOG_E2E_DOCKER);
  console.log(`WatchLog ${BASE}: Kubernetes "${kube.name}", Docker "${docker.name}"`);
  const created = await api<{ value: string; token: { id: string; prefix: string } }>(
    cookie,
    'POST',
    '/api-tokens',
    { name: 'mcp-e2e causes', expiresInDays: 30 },
  );
  try {
    const client = await httpClient(created.value, { pin: '2026-07-28' });
    const { tools } = await client.listTools();
    check(
      `${TOOLS} tools, explain_problem among them`,
      tools.length === TOOLS && tools.some((t) => t.name === 'explain_problem'),
      `${tools.length}`,
    );
    const problems = new Map<string, Json[]>();
    for (const c of [kube, docker]) {
      const r = await paced(client, 'get_problems', { cluster: c.name });
      const items = (r.data.problems ?? []) as Json[];
      problems.set(c.kind, items);
      const withCause = items.filter((p) => p.likelyCause);
      check(
        `get_problems (${c.kind}): every likelyCause is a catalog rule with its headline, and every problem with one has a subject`,
        !r.isError &&
          withCause.length > 0 &&
          withCause.every(
            (p) =>
              CATALOG.has(p.likelyCause.rule) &&
              typeof p.likelyCause.headline?.code === 'string' &&
              typeof p.subject === 'string',
          ),
        `${withCause.length} of ${items.length} with a likely cause`,
      );
    }
    for (const [scenario, plats, kCause, dCause, kSubj, dSubj] of chosen) {
      for (const kind of plats!.split(',') as Cluster['kind'][]) {
        const [expected, subject, c] =
          kind === 'kubernetes' ? [kCause!, kSubj!, kube] : [dCause!, dSubj!, docker];
        const label = `${scenario} on ${kind}`;
        const e = await paced(client, 'explain_problem', { cluster: c.name, subject });
        const top = (e.data.causes ?? [])[0] as Json | undefined;
        check(
          `${label}: explain_problem ${subject} → ${expected} (likely)`,
          !e.isError &&
            e.data.state === 'likely' &&
            top?.rule === expected &&
            top?.strength === 'likely' &&
            typeof top?.means === 'string',
          e.isError
            ? JSON.stringify(e.data).slice(0, 200)
            : `${e.data.state}: ${top?.rule ?? 'none'} ${top?.strength ?? ''}, headline ${e.data.headline?.code}, ${e.data.checks?.length} checks`,
        );
        const mine = (problems.get(kind) ?? []).filter((p) => about(p, kind, subject));
        if (!mine.length) {
          skip(`${label}: get_problems`, 'no Needs-attention problem about it');
          continue;
        }
        const hit = mine.find((p) => p.likelyCause?.rule === expected);
        check(
          `${label}: get_problems carries likelyCause ${expected}`,
          !!hit,
          mine.map((p) => `${p.subject}: ${p.likelyCause?.rule ?? 'none'}`).join(', '),
        );
        const alerted = mine.filter((p) => p.alertId && p.likelyCause);
        for (const p of alerted.slice(0, 2)) {
          const x = await paced(client, 'explain_alert', { alertId: p.alertId });
          const xt = (x.data.causes?.causes ?? [])[0] as Json | undefined;
          check(
            `${label}: explain_alert's causes agree with get_problems (${p.likelyCause.rule})`,
            !x.isError && x.data.causes?.state === 'likely' && xt?.rule === p.likelyCause.rule,
            `${x.data.causes?.state}: ${xt?.rule ?? 'none'}`,
          );
        }
      }
    }
    await client.close();
  } finally {
    await api(cookie, 'DELETE', `/api-tokens/${created.token.id}`).catch((e) =>
      console.log(`could not revoke the token: ${String(e)}`),
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  const cookie = await session();
  const { clusters } = await api<{ clusters: Cluster[] }>(cookie, 'GET', '/clusters');
  const kube = pick(clusters, 'kubernetes', process.env.WATCHLOG_E2E_KUBE);
  const docker = pick(clusters, 'docker', process.env.WATCHLOG_E2E_DOCKER);
  console.log(`WatchLog ${BASE}: Kubernetes "${kube.name}", Docker "${docker.name}"`);
  const created = await api<{ value: string; token: { id: string; prefix: string } }>(
    cookie,
    'POST',
    '/api-tokens',
    {
      name: 'mcp-e2e',
      expiresInDays: 30,
    },
  );
  const token = created.value;
  let revoked = false;
  const revoke = async () => {
    if (revoked) return;
    revoked = true;
    await api(cookie, 'DELETE', `/api-tokens/${created.token.id}`);
  };
  console.log(`token ${created.token.prefix}… (revoked at the end)`);
  try {
    // 1. The SDK client, both protocol generations.
    for (const [label, mode, version] of [
      ['SDK 2026-07-28', { pin: '2026-07-28' }, '2026-07-28'],
      ['SDK 2025', 'legacy', '2025-11-25'],
    ] as const) {
      const client = await httpClient(token, mode);
      check(
        `${label}: negotiated ${version}`,
        client.getNegotiatedProtocolVersion() === version,
        client.getNegotiatedProtocolVersion(),
      );
      await contract(label, client, kube, docker);
      await client.close();
    }

    // 2. Claude Desktop's path: mcp-remote over stdio, the token in the environment.
    const remote = new Client({ name: 'claude-desktop-path', version: '1.0.0' });
    await remote.connect(
      new StdioClientTransport({
        command: 'npx',
        args: [
          '-y',
          MCP_REMOTE,
          `${BASE}/mcp`,
          '--transport',
          'http-only',
          '--header',
          'Authorization: Bearer ${WATCHLOG_TOKEN}',
        ],
        env: { ...(process.env as Record<string, string>), WATCHLOG_TOKEN: token },
        stderr: 'ignore',
      }),
    );
    await contract(`mcp-remote (${MCP_REMOTE})`, remote, kube, docker);
    await remote.close();

    // 3. Claude Code, one run per kind.
    if (process.env.CLAUDE === '0') skip('Claude Code', 'CLAUDE=0');
    else if (spawnSync('claude', ['--version']).status !== 0)
      skip('Claude Code', 'no `claude` CLI');
    else {
      await claudeCode(token, kube, ['crashloop', 'oom']);
      await claudeCode(token, docker, ['fx-crashloop', 'fx-oom']);
    }

    // 4. Cursor, when its CLI is there.
    if (spawnSync('cursor-agent', ['--version']).status === 0) {
      skip('Cursor', 'cursor-agent found, but its MCP setup is not scripted here yet');
    } else skip('Cursor', 'no cursor-agent CLI on this machine');

    // 5. Revoking stops the next call.
    const client = await httpClient(token, { pin: '2026-07-28' });
    await revoke();
    const after = await client.callTool({ name: 'list_clusters', arguments: {} }).then(
      () => 'answered',
      (e: Error) => e.message,
    );
    check('revoked token: the next call fails', after !== 'answered', after.slice(0, 80));
    await client.close().catch(() => {});
  } finally {
    await revoke().catch((e) => console.log(`could not revoke the token: ${String(e)}`));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

(process.argv[2] === 'causes' ? causesMain() : main()).catch((err: unknown) => {
  console.error(`mcp-e2e: ${(err as Error).message}`);
  process.exit(1);
});
