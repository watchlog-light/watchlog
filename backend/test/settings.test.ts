// SPDX-License-Identifier: AGPL-3.0-only
// Settings made in the UI (alerts redesign, ADR-093): the public address.
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN } from './helpers.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  TEST_SMTP_URL,
  mailpitMessages,
  startMockProviders,
  type MockProviders,
} from './support/mock-providers.js';
import {
  closeTestContext,
  createTestContext,
  createUserSession,
  setupAdmin,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let cookie: string;
const api = (method: string, url: string, payload?: object, as = cookie) =>
  ctx.app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    cookies: { wl_session: as },
    ...(payload ? { payload } : {}),
  });

afterEach(() => closeTestContext(ctx));

describe('public address (Settings → General)', () => {
  it('is stored from the UI, checked, and used for links and install commands', async () => {
    ctx = await createTestContext({ publicUrl: undefined });
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/general')).json()).toEqual({
      publicUrl: null,
      publicUrlSource: 'none',
    });
    expect((await api('GET', '/alerting/status')).json().publicUrlConfigured).toBe(false);

    expect((await api('PUT', '/settings/general', { publicUrl: 'ftp://x' })).statusCode).toBe(400);
    const saved = await api('PUT', '/settings/general', {
      publicUrl: 'https://watchlog.acme.dev/',
    });
    expect(saved.json()).toEqual({ publicUrl: 'https://watchlog.acme.dev', publicUrlSource: 'db' });
    expect((await api('GET', '/alerting/status')).json().publicUrlConfigured).toBe(true);

    const created = await api('POST', '/clusters', { name: 'hosts', kind: 'docker' });
    expect(created.json().install.dockerRun).toContain('https://watchlog.acme.dev');

    const viewer = await createUserSession(ctx.db, {
      role: 'viewer',
      orgId: (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id,
    });
    expect(
      (await api('PUT', '/settings/general', { publicUrl: null }, viewer.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await api('PUT', '/settings/general', { publicUrl: null })).json().publicUrlSource,
    ).toBe('none');
  });

  it("is read-only when the server's environment sets it", async () => {
    ctx = await createTestContext({ publicUrl: 'https://from-env.example.com' });
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/general')).json()).toEqual({
      publicUrl: 'https://from-env.example.com',
      publicUrlSource: 'env',
    });
    const res = await api('PUT', '/settings/general', { publicUrl: 'https://other.example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("Set by the server's environment; change it there");
  });
});

describe('system namespaces (Settings → General)', () => {
  it('starts from the default list, can be changed by admins and reset', async () => {
    ctx = await createTestContext();
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/namespaces')).json()).toEqual({
      system: ['kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage'],
      watchlog: true,
      isDefault: true,
    });
    expect(
      (await api('PUT', '/settings/namespaces', { system: ['Not A Namespace'] })).statusCode,
    ).toBe(400);
    const saved = await api('PUT', '/settings/namespaces', {
      system: ['kube-system', 'istio-system', 'kube-system'],
      watchlog: false,
    });
    expect(saved.json()).toEqual({
      system: ['istio-system', 'kube-system'],
      watchlog: false,
      isDefault: false,
    });
    const viewer = await createUserSession(ctx.db, {
      role: 'viewer',
      orgId: (await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow()).id,
    });
    expect(
      (await api('PUT', '/settings/namespaces', { system: null }, viewer.cookie)).statusCode,
    ).toBe(403);
    expect((await api('PUT', '/settings/namespaces', { system: null })).json().isDefault).toBe(
      true,
    );
  });
});

describe('email server (SMTP) from the UI', () => {
  // The test Mailpit's SMTP port (WATCHLOG_TEST_SMTP_URL), never a fixed one.
  const SMTP = new URL(TEST_SMTP_URL);
  const MAILPIT = {
    host: SMTP.hostname,
    port: Number(SMTP.port),
    security: 'none',
    username: '',
    from: 'WatchLog <alerts@acme.test>',
  };

  it('is saved, tested against the real server and used by email channels', async () => {
    ctx = await createTestContext({ smtp: undefined });
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/smtp')).json()).toEqual({ smtp: null });
    expect((await api('GET', '/alerting/status')).json().smtpConfigured).toBe(false);

    const test = await api('POST', '/settings/smtp/test', MAILPIT);
    expect(test.json()).toMatchObject({ ok: true, to: ADMIN.email, error: null });
    const mails = await mailpitMessages(ADMIN.email);
    expect(mails.at(-1)!.Subject).toBe('WatchLog test email');

    expect((await api('PUT', '/settings/smtp', MAILPIT)).json().smtp).toMatchObject({
      host: MAILPIT.host,
      port: MAILPIT.port,
      source: 'db',
      passwordSet: false,
    });
    expect((await api('GET', '/alerting/status')).json().smtpConfigured).toBe(true);

    // An email channel now only needs recipients.
    const to = `team-${Date.now()}@example.com`;
    const ch = await api('POST', '/alert-channels', {
      type: 'email',
      name: 'Team',
      settings: { recipients: [to] },
    });
    expect((await api('POST', `/alert-channels/${ch.json().channel.id}/test`)).json()).toEqual({
      ok: true,
      error: null,
    });
    expect((await mailpitMessages(to))[0]!.Subject).toMatch(/^\[TEST\]/);
  });

  it('keeps the password write-only and encrypted', async () => {
    ctx = await createTestContext({ smtp: undefined });
    cookie = await setupAdmin(ctx.app);
    const saved = await api('PUT', '/settings/smtp', {
      ...MAILPIT,
      username: 'alerts@acme.test',
      password: 'super-secret-k2fa',
    });
    expect(saved.body).not.toContain('super-secret');
    expect(saved.json().smtp).toMatchObject({ passwordSet: true, passwordEnds: 'k2fa' });
    const row = await ctx.db
      .selectFrom('server_settings')
      .selectAll()
      .where('key', '=', 'smtp')
      .executeTakeFirstOrThrow();
    expect(row.secret).toMatch(/^v1:/);
    expect(JSON.stringify(row)).not.toContain('super-secret');
    // Saving without a password keeps the stored one; an empty one removes it.
    expect(
      (await api('PUT', '/settings/smtp', { ...MAILPIT, username: 'alerts@acme.test' })).json().smtp
        .passwordEnds,
    ).toBe('k2fa');
    expect(
      (await api('PUT', '/settings/smtp', { ...MAILPIT, password: '' })).json().smtp.passwordSet,
    ).toBe(false);
  });

  it("returns the server's real error when a test fails", async () => {
    ctx = await createTestContext({ smtp: undefined });
    cookie = await setupAdmin(ctx.app);
    const closed = (await api('POST', '/settings/smtp/test', { ...MAILPIT, port: 1 })).json();
    expect(closed).toMatchObject({ ok: false });
    expect(closed.error).toMatch(/ECONNREFUSED/);
    const tls = (await api('POST', '/settings/smtp/test', { ...MAILPIT, security: 'tls' })).json();
    expect(tls.ok).toBe(false);
    expect(tls.error).toMatch(/SSL|TLS|wrong version|socket/i);
    expect((await api('POST', '/settings/smtp/test')).statusCode).toBe(400);
  });

  it("is read-only when the server's environment sets it", async () => {
    ctx = await createTestContext({
      smtp: {
        url: 'smtp://alerts%40acme.dev:pw@mail.acme.dev:587',
        from: 'WatchLog <alerts@acme.dev>',
      },
    });
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/smtp')).json().smtp).toEqual({
      host: 'mail.acme.dev',
      port: 587,
      security: 'starttls',
      username: 'alerts@acme.dev',
      from: 'WatchLog <alerts@acme.dev>',
      passwordSet: true,
      passwordEnds: null,
      source: 'env',
    });
    expect((await api('PUT', '/settings/smtp', MAILPIT)).statusCode).toBe(409);
    expect((await api('DELETE', '/settings/smtp')).statusCode).toBe(409);
  });
});

describe('Telegram: reachability and proxy (ADR-093)', () => {
  let mock: MockProviders;
  let proxy: Server;
  let proxied: string[];

  async function startProxy() {
    proxied = [];
    proxy = createServer((req, res) => {
      const target = new URL(req.url ?? '');
      proxied.push(target.pathname);
      const up = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  }

  afterEach(async () => {
    await mock?.close();
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
  });

  it('says clearly when Telegram cannot be reached, and the proxy from Settings fixes it', async () => {
    mock = await startMockProviders();
    ctx = await createTestContext({ telegramApiUrl: 'http://127.0.0.1:59999', proxy: {} });
    cookie = await setupAdmin(ctx.app);
    const down = (await api('GET', '/settings/telegram/reachability')).json();
    expect(down.reachable).toBe(false);
    expect(down.error).toMatch(/ECONNREFUSED/);
    const create = await api('POST', '/alert-channels', {
      type: 'telegram',
      name: 'On-call',
      settings: { botToken: '123456:ABCdefGhIJKlmNoPQRstuVWXyz' },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().type).toBe('urn:watchlog:problem:telegram-unreachable');
    expect(create.json().detail).toMatch(/^WatchLog cannot reach Telegram from this server/);
    await closeTestContext(ctx);

    // Through the proxy set in the UI, Telegram's calls (and only those) go out.
    const proxyUrl = await startProxy();
    ctx = await createTestContext({ telegramApiUrl: mock.url, proxy: {} });
    cookie = await setupAdmin(ctx.app);
    expect((await api('PUT', '/settings/telegram', { proxyUrl: 'ftp://x' })).statusCode).toBe(400);
    expect((await api('PUT', '/settings/telegram', { proxyUrl })).json()).toEqual({
      proxyUrl,
      source: 'db',
    });
    expect((await api('GET', '/settings/telegram/reachability')).json()).toEqual({
      reachable: true,
      error: null,
    });
    const ok = await api('POST', '/alert-channels', {
      type: 'telegram',
      name: 'On-call',
      settings: { botToken: '123456:ABCdefGhIJKlmNoPQRstuVWXyz' },
    });
    expect(ok.statusCode).toBe(201);
    expect(proxied).toContain('/bot123456:ABCdefGhIJKlmNoPQRstuVWXyz/getMe');
  });

  it("is read-only when the server's environment sets a proxy", async () => {
    ctx = await createTestContext({ proxy: { https: 'http://corp-proxy:3128' } });
    cookie = await setupAdmin(ctx.app);
    expect((await api('GET', '/settings/telegram')).json()).toEqual({
      proxyUrl: 'http://corp-proxy:3128',
      source: 'env',
    });
    expect((await api('PUT', '/settings/telegram', { proxyUrl: null })).statusCode).toBe(409);
  });
});
