// SPDX-License-Identifier: AGPL-3.0-only
// The push snippets of Add a source and the docs are run, not just shown (1.0.3): each
// language's snippet, exactly as @watchlog/snippets writes it, is run by its own runtime against
// a real backend on a local port, and the value it sent is read back. A runtime that isn't
// installed skips its test (the name says which). The /metrics examples for each language's
// Prometheus library need that library installed, so they are parsed only (where a parser is
// at hand): their names were checked against each library's documentation.
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPOSE_LANGS,
  exposeSnippet,
  PUSH_LANGS,
  PUSH_RUNNERS,
  pushProgram,
  pushSnippet,
  type PushLang,
} from '../../packages/snippets/index.js';
import { newId } from '../src/lib/ids.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

const has = (cmd: string) => spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
/**
 * Runs a program without stopping this process: the backend it talks to lives here too.
 */
const run = (command: string, args: string[], cwd: string, timeout = 120_000) =>
  new Promise<{ status: number; out: string }>((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout, encoding: 'utf8', env: { ...process.env, GO111MODULE: 'off' } },
      (err, stdout, stderr) =>
        resolve({
          status: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          out: `${stdout}${stderr}`,
        }),
    );
  });
const COMMAND: Record<PushLang, string> = {
  curl: 'curl',
  cron: 'curl',
  node: 'node',
  python: 'python3',
  php: 'php',
  go: 'go',
};

let ctx: TestContext;
let cookie: string;
let endpoint: string;
let clusterId: string;
let token: { id: string; value: string };
let dir: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await setupAdmin(ctx.app);
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  endpoint = `http://127.0.0.1:${address.port}`;
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/clusters',
    cookies: { wl_session: cookie },
    payload: { name: 'servers', kind: 'server' },
  });
  clusterId = made.json().cluster.id;
  await ctx.db
    .insertInto('agent_instances')
    .values({
      id: newId(),
      cluster_id: clusterId,
      node: 'web-1',
      mode: 'docker',
      agent_version: '1.0.3',
      last_seen_at: new Date(),
    })
    .execute();
  const t = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/clusters/${clusterId}/own-metrics/tokens`,
    cookies: { wl_session: cookie },
    payload: { name: 'my first metrics' },
  });
  token = t.json();
  dir = mkdtempSync(join(tmpdir(), 'watchlog-snippets-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeTestContext(ctx);
});

const received = async () =>
  (
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/clusters/${clusterId}/own-metrics/tokens/${token.id}/received?since=0`,
      cookies: { wl_session: cookie },
    })
  ).json().received as { name: string; value: number; owner: { kind: string; name: string } };

describe('each push snippet, run by its own runtime against a real backend', () => {
  for (const lang of PUSH_LANGS) {
    it.skipIf(!has(COMMAND[lang]))(
      `${lang}: sends one value, which arrives for the server it names`,
      async () => {
        const name = `orders_${lang}_total`;
        const value = String(PUSH_LANGS.indexOf(lang) + 2);
        const o = { endpoint, token: token.value, name, value, owner: { server: 'web-1' } };
        const [file, command, ...args] = PUSH_RUNNERS[lang] as [string, string, ...string[]];
        const path = join(dir, file);
        writeFileSync(path, pushProgram(lang, o));
        // What is run is what the page shows (plus, for PHP and Go, the lines around it).
        expect(pushProgram(lang, o)).toContain(pushSnippet(lang, o).split('\n').at(-1)!.trim());
        const ran = await run(command, [...args, path], dir);
        expect(ran.status, `${lang}: ${ran.out}`).toBe(0);
        const got = await received();
        expect(got).toMatchObject({
          name,
          value: Number(value),
          owner: { kind: 'server', name: 'web-1' },
        });
      },
      150_000,
    );
  }

  it('a wrong token is refused with 401, as the page’s checklist says', async () => {
    if (!has('curl')) return;
    const o = { endpoint, token: 'wl_mt_not_a_token', name: 'orders_total', value: 1, owner: null };
    const path = join(dir, 'bad.sh');
    writeFileSync(
      path,
      pushProgram('curl', o).replace('curl -sS', 'curl -sS -o /dev/null -w "%{http_code}"'),
    );
    const ran = await run('bash', [path], dir, 30_000);
    expect(ran.out.trim()).toBe('401');
  });
});

describe('each /metrics example parses in its language, where its parser is installed', () => {
  const PARSE: Record<
    string,
    { cmd: string; file: string; args: string[]; wrap?: (s: string) => string }
  > = {
    node: { cmd: 'node', file: 'expose.cjs', args: ['--check'] },
    python: { cmd: 'python3', file: 'expose.py', args: ['-m', 'py_compile'] },
    go: {
      cmd: 'gofmt',
      file: 'expose.go',
      args: ['-e', '-l'],
      wrap: (s) => `package main\n\n${s}\n`,
    },
    php: { cmd: 'php', file: 'expose.php', args: ['-l'], wrap: (s) => `<?php\n${s}\n` },
  };
  for (const lang of EXPOSE_LANGS) {
    const p = PARSE[lang];
    it.skipIf(!p || !has(p.cmd))(`${lang}: one counter on a /metrics page`, () => {
      const code = exposeSnippet(lang);
      expect(code).toContain('orders');
      const path = join(dir, p!.file);
      writeFileSync(path, p!.wrap ? p!.wrap(code) : `${code}\n`);
      const run = spawnSync(p!.cmd, [...p!.args, path], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(run.status, `${lang}: ${run.stderr || run.stdout}`).toBe(0);
    });
  }
});
