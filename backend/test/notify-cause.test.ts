// SPDX-License-Identifier: AGPL-3.0-only
// The likely cause in the notifications (v0.4 slice 7, ADR-148, ADR-157): one "Likely cause:"
// line when the answer at fire time is likely, nothing when it is possible, none or not ready
// in 2 s, "Was likely:" on the resolve, and `likelyCause` on the webhook's alert; for every
// channel, from answers recorded on the kind and Docker e2e demos. The alert worker reads
// through its in-process app as a viewer of one org (plugins/service-identity.ts).
import { headlineText } from '@watchlog/cause-words';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids.js';
import { encryptJson } from '../src/lib/secrets.js';
import { internalCallMark } from '../src/lib/internal-call.js';
import {
  HttpClient,
  slackBody,
  telegramText,
  webhookBody,
} from '../src/modules/alerts/channels.js';
import { deliverDue, type DeliveryDeps } from '../src/modules/alerts/delivery.js';
import type { EvaluatorLookup } from '../src/modules/alerts/engine.js';
import {
  NOTIFY_BUDGET_MS,
  notifyCause,
  workerCauses,
  type StoredCause,
  type WorkOut,
} from '../src/modules/alerts/likely-cause.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import { renderMessage } from '../src/modules/alerts/render.js';
import { explain, type CausesAnswer } from '../src/modules/causes/engine.js';
import { CausesService } from '../src/modules/causes/likely.js';
import { parseSubject } from '../src/modules/causes/subject.js';
import { SERVICE_ORG_HEADER } from '../src/plugins/service-identity.js';
import { closeTestContext, createTestContext, setupAdmin, type TestContext } from './helpers.js';
import {
  createOrgCluster,
  insertChannel,
  insertRule,
  silentLog,
  testWorker,
} from './support/alerts.js';
import {
  BEFORE_SLICE_4,
  beforeSlice4,
  recording,
  replay,
  type RecordingName,
} from './support/causes.js';
import { kindCluster } from './support/mcp-fixtures.js';
import {
  TEST_SMTP_URL,
  mailpitMessages,
  mailpitText,
  startMockProviders,
  type MockProviders,
} from './support/mock-providers.js';

async function recorded(name: RecordingName): Promise<CausesAnswer> {
  const rec = recording(name);
  const reader = replay(rec, undefined, beforeSlice4(rec) ? BEFORE_SLICE_4 : undefined);
  return explain(reader, rec.cluster, parseSubject(rec.subject), { now: rec.now });
}

const payload = (over: Partial<MessagePayload> = {}): MessagePayload => ({
  version: 1,
  kind: 'firing',
  severity: 'critical',
  rule: { id: 'r1', key: 'network.connections.failed', name: 'Connections failing' },
  cluster: { id: 'c1', name: 'kind', kind: 'kubernetes' },
  items: [
    {
      alertId: 'a1',
      severity: 'critical',
      labels: { namespace: 'causes-e2e', workload: 'web', workload_kind: 'Deployment' },
      details: { summary: 'web cannot reach api' },
      startedAt: '2026-11-10T21:12:40.000Z',
      firedAt: '2026-11-10T21:13:40.000Z',
      resolvedAt: null,
    },
  ],
  total: 1,
  at: '2026-11-10T21:13:42.000Z',
  ...over,
});

describe('the likely cause, as a message carries it', () => {
  it.each<[RecordingName, string, string, string[]]>([
    [
      'kube-dependency-down',
      'dependency_down',
      'web fails because api was scaled to 0: nothing answers its calls.',
      ['edge_failed', 'no_pods', 'scaled'],
    ],
    [
      'docker-dependency-down',
      'dependency_down',
      'web fails because causes-e2e-api-1 was stopped (exit code 0): nothing answers its calls.',
      ['edge_gone_dns', 'container_stopped'],
    ],
    [
      'kube-cpu-throttle',
      'cpu_throttled',
      'caller is slow because hot is CPU-throttled 57% of the time at its 20m CPU limit: its calls to hot take 235 ms at p95.',
      ['edge_slower', 'cpu_throttled'],
    ],
  ])('%s: the rule, the English headline and the chain, short', async (name, rule, text, chain) => {
    const a = await recorded(name);
    const lc = notifyCause(a)!;
    expect(lc).toMatchObject({ rule, code: a.causes[0]!.code, headline: a.headline, text });
    expect(lc.text).toBe(headlineText(a.headline));
    expect(lc.subject).toBe(`${a.subject.kind}:${a.subject.ref}`);
    expect(lc.chain.map((s) => s.fact)).toEqual(chain);
    for (const [i, s] of lc.chain.entries()) {
      const step = a.causes[0]!.chain[i]!;
      expect(s.subject).toBe(`${step.object.kind}:${step.object.ref}`);
      expect(s.name).toBe(step.object.name);
      expect(s.since ?? null).toBe(step.since);
      expect(s.at ?? null).toBe(step.at);
    }
  });

  it('is left out when the answer is possible or none', async () => {
    const a = await recorded('kube-dependency-down');
    const possible: CausesAnswer = {
      ...a,
      state: 'possible',
      causes: a.causes.map((c) => ({ ...c, strength: 'possible' as const })),
    };
    expect(notifyCause(possible)).toBeUndefined();
    expect(notifyCause({ ...a, state: 'none', causes: [] })).toBeUndefined();
  });
});

describe('every channel says it in one line (ADR-148)', () => {
  const with_ = async (name: RecordingName, over: Partial<MessagePayload> = {}) => {
    const lc = notifyCause(await recorded(name))!;
    const p = payload(over);
    return { lc, p: { ...p, items: p.items.map((i) => ({ ...i, likelyCause: lc })) } };
  };

  it.each<[RecordingName, MessagePayload['cluster']]>([
    ['kube-dependency-down', { id: 'c1', name: 'kind', kind: 'kubernetes' }],
    ['docker-dependency-down', { id: 'c2', name: 'docker', kind: 'docker' }],
  ])('%s: email, Slack, Telegram and the webhook', async (name, cluster) => {
    const { lc, p } = await with_(name, { cluster });
    const m = renderMessage(p, 'https://watchlog.example.com');
    const line = `Likely cause: ${lc.text}`;
    // Email (plain text): under the facts, before the link.
    const lines = m.text.split('\n');
    const at = lines.indexOf(line);
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe(m.items[0]!.context);
    expect(lines[at + 1]).toBe(m.items[0]!.link);
    // Slack: in the item's section, escaped.
    const s = slackBody(m, p) as { attachments: { blocks: { text?: { text: string } }[] }[] };
    expect(s.attachments[0]!.blocks[1]!.text!.text.split('\n')).toContain(
      line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
    // Telegram: HTML, escaped.
    expect(telegramText(m).split('\n')).toContain(
      line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    );
    // Webhook: the alert's likelyCause, the short form with the text and the chain.
    const w = webhookBody(p, m, Date.parse(p.at)) as { alerts: Record<string, unknown>[] };
    expect(w.alerts[0]!.likelyCause).toEqual(lc);
  });

  it('the resolve says "Was likely:"; a flapping message and one without a cause say nothing', async () => {
    const { lc, p } = await with_('kube-dependency-down', { kind: 'resolved' });
    const resolved = renderMessage(p);
    expect(resolved.text.split('\n')).toContain(`Was likely: ${lc.text}`);
    expect(resolved.text).not.toContain('Likely cause:');
    const flapping = renderMessage({ ...p, kind: 'flapping' });
    expect(flapping.text).not.toMatch(/Likely cause:|Was likely:/);
    const plain = payload();
    const m = renderMessage(plain, 'https://watchlog.example.com');
    expect(m.items[0]!.cause).toBeNull();
    expect(m.text).not.toMatch(/Likely cause:|Was likely:/);
    expect(JSON.stringify(slackBody(m, plain))).not.toContain('Likely cause');
    expect(telegramText(m)).not.toContain('Likely cause');
  });

  it('the webhook is additive: the same keys as before, likelyCause only when there is one', async () => {
    const before = [
      'id',
      'severity',
      'labels',
      'title',
      'why',
      'summary',
      'started_at',
      'fired_at',
      'resolved_at',
      'link',
    ];
    const plain = payload();
    const w = webhookBody(plain, renderMessage(plain), Date.parse(plain.at)) as {
      alerts: Record<string, unknown>[];
    };
    expect(Object.keys(w)).toEqual([
      'version',
      'event',
      'severity',
      'rule',
      'cluster',
      'alerts',
      'total',
      'alerts_link',
      'sent_at',
    ]);
    expect(Object.keys(w.alerts[0]!)).toEqual(before);
    const { p } = await with_('docker-dependency-down');
    const c = webhookBody(p, renderMessage(p), Date.parse(p.at)) as {
      version: number;
      alerts: Record<string, unknown>[];
    };
    expect(c.version).toBe(1);
    expect(Object.keys(c.alerts[0]!)).toEqual([...before, 'likelyCause']);
    // In this order (and the chain's steps in theirs), also once the stored message, jsonb
    // with sorted keys, is sent.
    const sorted = JSON.parse(JSON.stringify(p), (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    ) as MessagePayload;
    const again = webhookBody(sorted, renderMessage(sorted), Date.parse(p.at)) as typeof c;
    const shape = (lc: unknown) => {
      const o = lc as { chain: object[] };
      return [Object.keys(o), ...o.chain.map((x) => Object.keys(x))];
    };
    expect(shape(again.alerts[0]!.likelyCause)).toEqual(shape(c.alerts[0]!.likelyCause));
    expect(Object.keys(c.alerts[0]!.likelyCause as object)).toEqual([
      'rule',
      'code',
      'facts',
      'since',
      'headline',
      'subject',
      'text',
      'chain',
    ]);
  });
});

// ---- Delivery, against the test database, the mock providers and Mailpit ----

const KEY = Buffer.alloc(32, 9);
let ctx: TestContext;
let mock: MockProviders;
let http: HttpClient;

const depsWith = (causes?: WorkOut): DeliveryDeps => ({
  db: ctx.db,
  secretKey: KEY,
  http,
  settings: async () => ({
    publicUrl: 'https://watchlog.example.com',
    telegramApiUrl: mock.url,
    smtp: { transport: TEST_SMTP_URL, from: 'WatchLog <alerts@watchlog.test>' },
  }),
  log: silentLog,
  ...(causes ? { causes } : {}),
});

async function fourChannels(orgId: string, recipient: string) {
  return [
    await insertChannel(
      ctx.db,
      orgId,
      'slack',
      {},
      encryptJson(KEY, { webhookUrl: `${mock.url}/slack/T1/B1/x` }),
    ),
    await insertChannel(
      ctx.db,
      orgId,
      'telegram',
      { chatId: 4242, botName: 'watchlog_test_bot' },
      encryptJson(KEY, { botToken: '123:abc' }),
    ),
    await insertChannel(ctx.db, orgId, 'email', { recipients: [recipient] }),
    await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` }),
  ];
}

/** One alert that fires, then resolves, on a fake clock, delivered each cycle. */
async function episode(orgId: string, deps: DeliveryDeps, kind: 'kubernetes' | 'docker') {
  let firing = true;
  const lookup: EvaluatorLookup = () => ({
    kinds: [kind],
    evaluate: async () =>
      firing
        ? [
            {
              fingerprint: 'edge:web>api',
              severity: 'critical',
              labels: (kind === 'kubernetes'
                ? { namespace: 'causes-e2e', workload: 'web', workload_kind: 'Deployment' }
                : { node: 'docker-01', container: 'causes-e2e-web-1' }) as Record<string, string>,
              details: { summary: 'web cannot reach api' },
            },
          ]
        : [],
  });
  const clock = { now: Date.now() };
  const worker = testWorker(ctx.db, clock, lookup);
  const times: number[] = [];
  const step = async () => {
    await worker.runCycle();
    const t = Date.now();
    await deliverDue(deps, clock.now);
    times.push(Date.now() - t);
    clock.now += 30_000;
  };
  await step();
  await step();
  firing = false;
  for (let i = 0; i < 3; i++) await step();
  await worker.stop();
  return { times };
}

describe('delivery with the likely cause (ADR-157)', () => {
  beforeEach(async () => {
    ctx = await createTestContext();
    mock = await startMockProviders();
    http = new HttpClient();
  });
  afterEach(async () => {
    await http.close();
    await mock.close();
    await closeTestContext(ctx);
  });

  it.each<[RecordingName, 'kubernetes' | 'docker']>([
    ['kube-dependency-down', 'kubernetes'],
    ['docker-dependency-down', 'docker'],
  ])(
    '%s: worked out once when it fires; every channel says "Likely cause", then "Was likely"',
    async (name, kind) => {
      const answer = await recorded(name);
      const text = headlineText(answer.headline)!;
      const { orgId } = await createOrgCluster(ctx.db, kind);
      const recipient = `oncall-${newId()}@example.com`;
      await insertRule(ctx.db, orgId, {
        name: 'Connections failing',
        severity: 'critical',
        channel_ids: await fourChannels(orgId, recipient),
      });
      const asked: string[] = [];
      const workOut: WorkOut = async (o, jobs) => {
        asked.push(...jobs.map((j) => `${o}:${JSON.stringify(j.subject)}`));
        return jobs.map(() => answer);
      };
      await episode(orgId, depsWith(workOut), kind);

      // Once per alert, though four channels send it.
      expect(asked).toHaveLength(1);
      const state = await ctx.db.selectFrom('alert_states').selectAll().executeTakeFirstOrThrow();
      expect(asked[0]).toBe(`${orgId}:${JSON.stringify({ kind: 'alert', id: state.id })}`);
      const kept = state.cause as unknown as StoredCause;
      expect(kept).toMatchObject({ state: 'likely', likely: { text } });
      expect(state.cause_at).not.toBeNull();

      const fire = `Likely cause: ${text}`;
      const was = `Was likely: ${text}`;
      const slack = mock.to('/slack').map((r) => JSON.stringify(r.json));
      const telegram = mock
        .to('/bot123:abc/sendMessage')
        .map((r) => (r.json as { text: string }).text);
      const hooks = mock
        .to('/webhook')
        .map((r) => r.json as { event: string; alerts: { likelyCause?: unknown }[] });
      const esc = (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      expect(slack).toHaveLength(2);
      expect(slack[0]).toContain(JSON.stringify(esc(fire)).slice(1, -1));
      expect(slack[1]).toContain(JSON.stringify(esc(was)).slice(1, -1));
      expect(telegram[0]).toContain(esc(fire));
      expect(telegram[1]).toContain(esc(was));
      expect(hooks.map((h) => h.event)).toEqual(['firing', 'resolved']);
      expect(hooks.map((h) => h.alerts[0]!.likelyCause)).toEqual([kept.likely, kept.likely]);
      const mails = await mailpitMessages(recipient);
      expect(mails).toHaveLength(2);
      const bodies = await Promise.all(mails.map((m) => mailpitText(m.ID)));
      expect(bodies.find((b) => b.includes('CRITICAL'))).toContain(fire);
      expect(bodies.find((b) => b.includes('RESOLVED'))).toContain(was);
      // The stored message is what was sent, so a retry says the same.
      const rows = await ctx.db.selectFrom('notifications').select(['kind', 'payload']).execute();
      expect(
        rows.every(
          (r) => (r.payload as unknown as MessagePayload).items[0]!.likelyCause?.text === text,
        ),
      ).toBe(true);
    },
  );

  it('possible, none, or not ready within 2 s: the messages go without it, on time', async () => {
    const a = await recorded('kube-dependency-down');
    const possible: CausesAnswer = {
      ...a,
      state: 'possible',
      causes: a.causes.map((c) => ({ ...c, strength: 'possible' as const })),
    };
    const none: CausesAnswer = { ...a, state: 'none', causes: [] };
    // A slow reader: each answer takes 3 s, past the budget (a real CausesService).
    const slow = new CausesService({
      explainFn: (() =>
        new Promise((resolve) => setTimeout(() => resolve(a), 3_000))) as unknown as typeof explain,
    });
    const late: WorkOut = (o, jobs) =>
      slow.answers({ get: async () => ({}) as never }, o, jobs, { budgetMs: NOTIFY_BUDGET_MS });
    for (const [label, workOut] of [
      ['possible', async (_o: string, jobs: unknown[]) => jobs.map(() => possible)],
      ['none', async (_o: string, jobs: unknown[]) => jobs.map(() => none)],
      ['late', late],
    ] as [string, WorkOut][]) {
      await ctx.db.deleteFrom('notifications').execute();
      await ctx.db.deleteFrom('alert_states').execute();
      await ctx.db.deleteFrom('alert_rules').execute();
      mock.requests.length = 0;
      const { orgId } = await createOrgCluster(ctx.db);
      const ch = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
      await insertRule(ctx.db, orgId, { severity: 'critical', channel_ids: [ch] });
      const { times } = await episode(orgId, depsWith(workOut), 'kubernetes');
      const hooks = mock.to('/webhook').map((r) => r.body);
      expect(hooks, label).toHaveLength(2);
      expect(
        hooks.some((b) => b.includes('likelyCause')),
        label,
      ).toBe(false);
      const s = await ctx.db.selectFrom('alert_states').selectAll().executeTakeFirstOrThrow();
      expect((s.cause as unknown as StoredCause).state, label).toBe(label);
      // Never late: the firing message waited at most the budget.
      expect(Math.max(...times), label).toBeLessThan(NOTIFY_BUDGET_MS + 1_000);
    }
  }, 30_000);

  it('a message to an alert without channels or delivery without causes: nothing is worked out', async () => {
    const { orgId } = await createOrgCluster(ctx.db);
    const ch = await insertChannel(ctx.db, orgId, 'webhook', { url: `${mock.url}/webhook` });
    await insertRule(ctx.db, orgId, { severity: 'critical', channel_ids: [ch] });
    await episode(orgId, depsWith(), 'kubernetes');
    expect(mock.to('/webhook').some((r) => r.body.includes('likelyCause'))).toBe(false);
    const s = await ctx.db.selectFrom('alert_states').selectAll().executeTakeFirstOrThrow();
    expect(s.cause_at).toBeNull();
  });

  it('the alert detail says which message carried the likely cause (withCause)', async () => {
    const cookie = await setupAdmin(ctx.app);
    const org = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    const clusterId = newId();
    await ctx.db
      .insertInto('clusters')
      .values({ id: clusterId, org_id: org.id, name: 'kind', kind: 'kubernetes' })
      .execute();
    const ch = await insertChannel(ctx.db, org.id, 'webhook', { url: `${mock.url}/webhook` });
    const other = await insertChannel(ctx.db, org.id, 'webhook', { url: `${mock.url}/webhook2` });
    const rule = await insertRule(ctx.db, org.id, {
      severity: 'critical',
      channel_ids: [ch, other],
    });
    const answer = await recorded('kube-dependency-down');
    await episode(
      org.id,
      depsWith(async (_o, jobs) => jobs.map(() => answer)),
      'kubernetes',
    );
    const s = await ctx.db
      .selectFrom('alert_states')
      .select('id')
      .where('rule_id', '=', rule)
      .executeTakeFirstOrThrow();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/alerts/${s.id}`,
      cookies: { wl_session: cookie },
    });
    expect(res.statusCode).toBe(200);
    const notes = res.json().notifications as { kind: string; withCause?: boolean }[];
    expect(notes.map((n) => [n.kind, n.withCause])).toEqual([
      ['firing', true],
      ['firing', true],
      ['resolved', true],
      ['resolved', true],
    ]);
  });
});

describe("the alert worker's reads: a viewer of one org, in-process only (ADR-157)", () => {
  afterEach(async () => {
    if (ctx) await closeTestContext(ctx);
  });

  it('reads its org through the public read API, nothing else', async () => {
    ctx = await createTestContext({}, { serviceReads: true });
    const cookie = await setupAdmin(ctx.app);
    const kube = await kindCluster(ctx, cookie);
    const mine = await ctx.db.selectFrom('orgs').select('id').executeTakeFirstOrThrow();
    const theirs = await createOrgCluster(ctx.db, 'kubernetes', 'theirs');
    const as = (orgId: string, url: string, method: 'GET' | 'POST' = 'GET', mark = true) =>
      ctx.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { [SERVICE_ORG_HEADER]: orgId, ...(mark ? internalCallMark() : {}) },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
    const clusters = (await as(mine.id, '/clusters')).json().clusters as { id: string }[];
    expect(clusters.map((c) => c.id)).toEqual([kube.id]);
    // Another org's cluster is not found, as for any member of this org.
    expect((await as(mine.id, `/clusters/${theirs.clusterId}/overview`)).statusCode).toBe(404);
    expect(((await as(theirs.orgId, '/clusters')).json().clusters as unknown[]).length).toBe(1);
    // Without the in-process mark, or for an org that doesn't exist: refused.
    expect((await as(mine.id, '/clusters', 'GET', false)).statusCode).toBe(403);
    expect((await as(newId(), '/clusters')).statusCode).toBe(403);
    expect((await as('not-an-id', '/clusters')).statusCode).toBe(403);
    // Only what a read token may: no change, no route outside the public API.
    expect((await as(mine.id, '/alert-channels', 'POST')).statusCode).toBe(403);
    expect((await as(mine.id, '/users')).statusCode).toBe(403);
    // Probable cause through it: the answer for an alert of the org.
    const alertId = newId();
    const ruleId = await insertRule(ctx.db, mine.id, { rule_key: 'k8s.pod.crashloop' });
    await ctx.db
      .insertInto('alert_states')
      .values({
        id: alertId,
        org_id: mine.id,
        rule_id: ruleId,
        cluster_id: kube.id,
        fingerprint: 'f',
        state: 'firing',
        severity: 'critical',
        labels: JSON.stringify({ namespace: 'causes-e2e', pod: 'nowhere-1' }),
        started_at: new Date(Date.now() - 60_000),
        fired_at: new Date(),
      })
      .execute();
    const work = workerCauses(ctx.app, new CausesService());
    const cluster = { id: kube.id, name: 'kind', kind: 'kubernetes' as const };
    const [a] = await work(mine.id, [{ cluster, subject: { kind: 'alert', id: alertId } }]);
    expect(a?.subject).toMatchObject({ kind: 'alert', ref: alertId });
    // Asked as the other org, the same alert is no answer.
    const [b] = await work(theirs.orgId, [{ cluster, subject: { kind: 'alert', id: alertId } }]);
    expect(b).toBeUndefined();
  });

  it('the backend that serves the API ignores the header', async () => {
    ctx = await createTestContext();
    const mine = await createOrgCluster(ctx.db);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/clusters',
      headers: { [SERVICE_ORG_HEADER]: mine.orgId, ...internalCallMark() },
    });
    expect(res.statusCode).toBe(401);
  });
});
