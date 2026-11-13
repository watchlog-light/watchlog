// SPDX-License-Identifier: AGPL-3.0-only
// Cloud's egress policy for users' URLs (ADR-181), scenario 15: a webhook channel pointing at
// 169.254.169.254, or at a name that resolves to 10.0.0.1 at send time, is refused at save
// and at send. The resolver is a test one; nothing here asks real DNS or leaves the machine.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EgressPolicy,
  blockReason,
  type ResolvedAddress,
  type Resolver,
} from '../src/lib/egress.js';
import { DeliveryError, HttpClient } from '../src/modules/alerts/channels.js';
import { cloudWorld, seedOrg, type CloudWorld, type SeededOrg } from './isolation/cloud.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';

describe('address classes', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.5.4', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.10.1', 'link-local'],
    ['100.100.100.200', 'metadata'],
    ['100.64.0.1', 'shared (CGNAT)'],
    ['100.127.255.254', 'shared (CGNAT)'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.10', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.99', 'documentation'],
    ['198.18.0.1', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:0:10.0.0.1', 'private'],
    ['::10.0.0.1', 'reserved'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:a00:1::', 'private'],
    ['2002:7f00:1::1', 'loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['2001::1', 'reserved'],
    ['100::1', 'reserved'],
    ['not-an-ip', 'reserved'],
  ])('%s is %s', (address, reason) => {
    expect(blockReason(address)).toBe(reason);
  });

  it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111'])(
    '%s is public',
    (address) => {
      expect(blockReason(address)).toBeNull();
    },
  );
});

describe('the policy', () => {
  const answers = new Map<string, ResolvedAddress[]>([
    ['hooks.example.com', [{ address: '93.184.215.14', family: 4 }]],
    ['internal.example.test', [{ address: '10.0.0.1', family: 4 }]],
    [
      'mixed.example.test',
      [
        { address: '93.184.215.14', family: 4 },
        { address: 'fd00::5', family: 6 },
      ],
    ],
  ]);
  const resolver: Resolver = async (h) => answers.get(h) ?? [];
  const policy = new EgressPolicy(resolver);
  afterAll(() => policy.close());

  it('checks literals, names, and every address a name has', async () => {
    expect((await policy.checkUrl('https://hooks.example.com/x')).ok).toBe(true);
    expect(await policy.checkUrl('http://169.254.169.254/latest/meta-data/')).toMatchObject({
      ok: false,
      reason: 'metadata',
    });
    expect(await policy.checkUrl('http://[::ffff:a9fe:a9fe]/')).toMatchObject({
      ok: false,
      reason: 'metadata',
    });
    // The URL parser turns 2130706433 and 0x7f.1 into 127.0.0.1 before the check.
    expect(await policy.checkUrl('http://2130706433/')).toMatchObject({ reason: 'loopback' });
    expect(await policy.checkUrl('http://0x7f.1/')).toMatchObject({ reason: 'loopback' });
    expect(await policy.checkUrl('http://internal.example.test/hook')).toMatchObject({
      ok: false,
      reason: 'private',
      message: 'internal.example.test resolves to 10.0.0.1, a private address',
    });
    expect(await policy.checkUrl('http://mixed.example.test/')).toMatchObject({
      reason: 'private',
    });
    expect(await policy.checkUrl('http://nowhere.example.test/')).toMatchObject({
      reason: 'unresolved',
    });
    expect(await policy.checkUrl('ftp://hooks.example.com/')).toMatchObject({ reason: 'scheme' });
  });

  it('the connection lookup hands the socket only checked addresses', async () => {
    const lookup = (host: string, all: boolean) =>
      new Promise<unknown>((resolve) => {
        policy.lookup(host, { all }, (err, address, family) =>
          resolve(err ? (err as { code?: string }).code : all ? address : [address, family]),
        );
      });
    expect(await lookup('hooks.example.com', false)).toEqual(['93.184.215.14', 4]);
    expect(await lookup('hooks.example.com', true)).toEqual([
      { address: '93.184.215.14', family: 4 },
    ]);
    expect(await lookup('internal.example.test', true)).toBe('EGRESS_REFUSED');
  });
});

// ---------------------------------------------------------------- send time, real sockets

/** A local HTTP server counting what reaches it. */
async function listen(handler: (req: IncomingMessage) => [number, Record<string, string>?]) {
  const hits: IncomingMessage[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req);
    const [status, headers] = handler(req);
    res.writeHead(status, headers).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, port: (server.address() as AddressInfo).port };
}

describe('at send time', () => {
  let target: Awaited<ReturnType<typeof listen>>;
  let other: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => {
    other = await listen(() => [200]);
    target = await listen((req) =>
      req.url === '/redirect' ? [302, { location: `http://127.0.0.1:${other.port}/x` }] : [200],
    );
  });
  afterAll(() => {
    target.server.close();
    other.server.close();
  });

  it('connects to the address the policy checked, not the one DNS gives later', async () => {
    // "pinned.test" exists only in the test resolver: reaching the server proves the socket
    // used the checked answer. Loopback is let through here for the test's own server.
    const policy = new EgressPolicy(
      async (h) => (h === 'pinned.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
      (a) => (a === '127.0.0.1' ? null : blockReason(a)),
    );
    const http = new HttpClient({}, policy);
    const res = await http.post(`http://pinned.test:${target.port}/hook`, '{}', {}, undefined, {
      userUrl: true,
    });
    expect(res.status).toBe(200);
    expect(target.hits.at(-1)!.headers.host).toBe(`pinned.test:${target.port}`);
    await http.close();
  });

  it('a name that turns internal between the check and the connect is refused (rebinding)', async () => {
    let calls = 0;
    const policy = new EgressPolicy(async () =>
      ++calls === 1
        ? [{ address: '93.184.215.14', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    );
    const http = new HttpClient({}, policy);
    const before = target.hits.length;
    const err = await http
      .post(`http://rebind.test:${target.port}/hook`, '{}', {}, undefined, { userUrl: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as DeliveryError).permanent).toBe(true);
    expect((err as Error).message).toContain('127.0.0.1, a loopback address');
    expect(calls).toBe(2);
    expect(target.hits.length).toBe(before);
    await http.close();
  });

  it('never follows a redirect', async () => {
    const policy = new EgressPolicy(
      async () => [{ address: '127.0.0.1', family: 4 }],
      (a) => (a === '127.0.0.1' ? null : blockReason(a)),
    );
    const http = new HttpClient({}, policy);
    const before = other.hits.length;
    await expect(
      http.post(`http://hop.test:${target.port}/redirect`, '{}', {}, undefined, { userUrl: true }),
    ).rejects.toThrow(/unreachable/);
    expect(other.hits.length).toBe(before);
    await http.close();
  });

  it('an IP literal stored before the policy is refused without connecting', async () => {
    const http = new HttpClient({}, new EgressPolicy(async () => []));
    const before = target.hits.length;
    await expect(
      http.post(`http://127.0.0.1:${target.port}/hook`, '{}', {}, undefined, { userUrl: true }),
    ).rejects.toThrow(`127.0.0.1:${target.port} refused: 127.0.0.1 is a loopback address`);
    expect(target.hits.length).toBe(before);
    await http.close();
  });

  it('without a policy (Community) the same URL is sent', async () => {
    const http = new HttpClient();
    const res = await http.post(`http://127.0.0.1:${target.port}/hook`, '{}', {}, undefined, {
      userUrl: true,
    });
    expect(res.status).toBe(200);
    await http.close();
  });
});

// ---------------------------------------------------------------- scenario 15 through the API

describe('scenario 15: channels in Cloud', () => {
  let w: CloudWorld;
  let A: SeededOrg;
  const answers = new Map<string, string>();
  const resolver: Resolver = async (h) => {
    const a =
      answers.get(h) ??
      (h.endsWith('.example.com')
        ? '93.184.215.14'
        : h.endsWith('.internal.test')
          ? '10.0.0.1'
          : null);
    return a ? [{ address: a, family: a.includes(':') ? 6 : 4 }] : [];
  };

  beforeAll(async () => {
    w = await cloudWorld({ resolve: resolver });
    A = await seedOrg(w, 'zzalpha');
  }, 120_000);
  afterAll(() => w?.close());

  const api = async (method: 'POST' | 'PATCH', url: string, payload: object) =>
    w.app.inject({
      method,
      url: `/api/v1${url}`,
      cookies: { wl_session: await A.session() },
      payload,
    });

  it('refuses metadata, private names and loopback at save, with a plain 400', async () => {
    const cases: [string, Record<string, string>][] = [
      ['webhook', { url: 'http://169.254.169.254/latest/meta-data/' }],
      ['webhook', { url: 'http://localhost.internal.test:8080/hook' }],
      ['webhook', { url: 'http://[::1]/hook' }],
      ['slack', { webhookUrl: 'https://10.1.2.3/services/T/B/x' }],
    ];
    for (const [type, settings] of cases) {
      const res = await api('POST', '/alert-channels', { type, name: 'probe', settings });
      expect(res.statusCode, JSON.stringify(settings)).toBe(400);
      expect(res.json().type).toBe('urn:watchlog:problem:egress-refused');
      expect(res.json().detail).toMatch(/^WatchLog Cloud doesn't send to internal addresses: /);
    }
    const res = await api('POST', '/alert-channels', {
      type: 'webhook',
      name: 'probe',
      settings: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(res.json().detail).toBe(
      "WatchLog Cloud doesn't send to internal addresses: 169.254.169.254 is a metadata address. Use a public URL.",
    );
    const patch = await api('PATCH', `/alert-channels/${A.channelId}`, {
      settings: { url: 'http://metadata.internal.test/' },
    });
    expect(patch.statusCode).toBe(400);
    // Refused means nothing saved: no new channel, the old URL kept.
    const rows = await w.owner
      .selectFrom('alert_channels')
      .select(['name', 'config'])
      .where('org_id', '=', A.orgId)
      .execute();
    expect(rows.map((r) => r.name)).not.toContain('probe');
    expect(rows.map((r) => r.config)).toContainEqual({ url: 'https://zzalpha.example.com/hook' });
  });

  it('a name that resolves to 10.0.0.1 at send time is refused at send', async () => {
    answers.set('rebind.example.com', '93.184.215.14');
    const created = await api('POST', '/alert-channels', {
      type: 'webhook',
      name: 'rebinding',
      settings: { url: 'https://rebind.example.com/hook' },
      useForAllRules: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    answers.set('rebind.example.com', '10.0.0.1');
    const test = await api('POST', `/alert-channels/${created.json().channel.id}/test`, {});
    expect(test.json()).toEqual({
      ok: false,
      error:
        'rebind.example.com refused: rebind.example.com resolves to 10.0.0.1, a private address; WatchLog Cloud sends only to public addresses',
    });
  });
});

describe('Community keeps any http(s) URL (ADR-091)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => closeTestContext(ctx));

  it('saves a webhook to a private address', async () => {
    const cookie = await setupAdmin(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/alert-channels',
      cookies: { wl_session: cookie },
      payload: { type: 'webhook', name: 'lan', settings: { url: 'http://10.0.0.1:9000/hook' } },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
