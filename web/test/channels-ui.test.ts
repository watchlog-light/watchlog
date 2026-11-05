// SPDX-License-Identifier: AGPL-3.0-only
// Settings → Alert channels (alerts redesign items 3 and 4): the email server, Telegram's
// guided setup and the other channel cards.
import { flushPromises, mount } from '@vue/test-utils';
import type { AlertChannel } from '@watchlog/api-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChannelSettings from '@/components/alerts/ChannelSettings.vue';
import { useAuthStore } from '@/stores/auth';
import { mockFetch, USER, type Routes } from './fetch-mock';
import { createPlugins } from './helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const BASE: Routes = {
  'GET /api/v1/settings/general': {
    status: 200,
    body: { publicUrl: 'https://w.example', publicUrlSource: 'db' },
  },
  'GET /api/v1/settings/telegram': { status: 200, body: { proxyUrl: null, source: 'none' } },
  'GET /api/v1/settings/telegram/reachability': {
    status: 200,
    body: { reachable: true, error: null },
  },
  'GET /api/v1/settings/smtp': { status: 200, body: { smtp: null } },
};
const channel = (over: Partial<AlertChannel>): AlertChannel => ({
  id: '01a19300-0000-7000-8000-0000000000cc',
  type: 'webhook',
  name: 'Bridge',
  config: {},
  secrets: {},
  verifiedAt: null,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  ruleCount: 0,
  ...over,
});

async function mountChannels(routes: Routes) {
  const { calls } = mockFetch({ ...BASE, ...routes });
  const p = await createPlugins('/settings?tab=channels');
  useAuthStore().user = USER;
  const w = mount(ChannelSettings, {
    attachTo: document.body,
    global: { plugins: [p.router, p.i18n, p.pinia] },
  });
  await flushPromises();
  return { w, calls };
}

describe('email server (SMTP) card', () => {
  it('tests the settings before saving and shows the server error, then saves', async () => {
    const { w, calls } = await mountChannels({
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
      'POST /api/v1/settings/smtp/test': [
        {
          status: 200,
          body: {
            ok: false,
            to: USER.email,
            ms: 812,
            error: 'Invalid login: 535 5.7.8 Username and Password not accepted',
          },
        },
        { status: 200, body: { ok: true, to: USER.email, ms: 1234, error: null } },
      ],
      'PUT /api/v1/settings/smtp': {
        status: 200,
        body: {
          smtp: {
            host: 'smtp.gmail.com',
            port: 587,
            security: 'starttls',
            username: 'alerts@acme.dev',
            from: 'WatchLog <alerts@acme.dev>',
            passwordSet: true,
            passwordEnds: 'k2fa',
            source: 'db',
          },
        },
      },
    } as Routes);
    const card = w.get('[data-testid="smtp-card"]');
    expect(card.text()).toContain('Not set up');
    const inputs = card.findAll('input:not([type="radio"])');
    await inputs[0]!.setValue('smtp.gmail.com');
    await inputs[2]!.setValue('alerts@acme.dev');
    await inputs[3]!.setValue('app-password-k2fa');
    await inputs[4]!.setValue('WatchLog <alerts@acme.dev>');
    await card.get('[data-testid="smtp-test"]').trigger('click');
    await flushPromises();
    expect(card.get('[data-testid="smtp-result"]').text()).toBe(
      'Test failed: Invalid login: 535 5.7.8 Username and Password not accepted',
    );
    await card.get('[data-testid="smtp-test"]').trigger('click');
    await flushPromises();
    expect(card.get('[data-testid="smtp-result"]').text()).toBe(
      `Test email delivered to ${USER.email} in 1.2 s`,
    );
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      security: 'starttls',
      username: 'alerts@acme.dev',
      from: 'WatchLog <alerts@acme.dev>',
      password: 'app-password-k2fa',
    });
    expect(card.text()).toContain('Stored encrypted · ends in …k2fa');
    expect((card.find('input[type="password"]').element as HTMLInputElement).value).toBe('');
    w.unmount();
  });

  it("shows the environment's server read-only, without variable names", async () => {
    const { w } = await mountChannels({
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
      'GET /api/v1/settings/smtp': {
        status: 200,
        body: {
          smtp: {
            host: 'mail.acme.dev',
            port: 587,
            security: 'starttls',
            username: 'a',
            from: 'W <a@acme.dev>',
            passwordSet: true,
            passwordEnds: null,
            source: 'env',
          },
        },
      },
    });
    const card = w.get('[data-testid="smtp-card"]');
    expect(card.text()).toContain("Set by the server's environment");
    expect(card.find('[data-testid="smtp-save"]').exists()).toBe(false);
    expect(
      card
        .findAll('input:not([type="radio"])')
        .every((i) => i.attributes('readonly') !== undefined),
    ).toBe(true);
    expect(w.text()).not.toMatch(/WATCHLOG_|SMTP_URL/);
    w.unmount();
  });
});

describe('Telegram guided setup (ADR-093)', () => {
  it('says at step 1 when this server cannot reach Telegram and opens the proxy setting', async () => {
    const { w } = await mountChannels({
      'GET /api/v1/alert-channels': { status: 200, body: { channels: [] } },
      'GET /api/v1/settings/telegram/reachability': {
        status: 200,
        body: { reachable: false, error: 'api.telegram.org unreachable: UND_ERR_CONNECT_TIMEOUT' },
      },
    });
    const card = w.get('[data-testid="telegram-card"]');
    expect(card.get('[data-testid="telegram-unreachable"]').text()).toContain(
      'This server cannot reach Telegram (api.telegram.org unreachable: UND_ERR_CONNECT_TIMEOUT)',
    );
    expect(card.get('[data-testid="telegram-proxy-toggle"]').attributes('aria-expanded')).toBe(
      'true',
    );
    w.unmount();
  });

  it('pastes the token, shows the link with a countdown and connects by itself', async () => {
    const created = channel({
      id: '01a19300-0000-7000-8000-0000000000ee',
      type: 'telegram',
      name: 'Telegram',
      config: { botName: 'acme_watchlog_bot', connected: false },
    });
    const { w, calls } = await mountChannels({
      'GET /api/v1/alert-channels': [
        { status: 200, body: { channels: [] } },
        { status: 200, body: { channels: [created] } },
        {
          status: 200,
          body: {
            channels: [
              { ...created, config: { ...created.config, connected: true, chatName: 'On-call' } },
            ],
          },
        },
      ],
      'POST /api/v1/alert-channels': {
        status: 201,
        body: {
          channel: created,
          connect: {
            link: 'https://t.me/acme_watchlog_bot?start=abc123',
            expiresAt: new Date(Date.now() + 581_000).toISOString(),
          },
        },
      },
    } as Routes);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const card = w.get('[data-testid="telegram-card"]');
    await card.get('input[type="password"]').setValue('7712345678:AAHexampletoken');
    await card.get('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      type: 'telegram',
      settings: { botToken: '7712345678:AAHexampletoken' },
      useForAllRules: true,
    });
    expect(card.get('[data-testid="telegram-link"]').attributes('href')).toBe(
      'https://t.me/acme_watchlog_bot?start=abc123',
    );
    expect(card.text()).toContain('Open t.me/acme_watchlog_bot and press Start');
    await vi.advanceTimersByTimeAsync(1000);
    expect(card.get('[data-testid="telegram-countdown"]').text()).toMatch(
      /Link expires in 9:[34]\d/,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    expect(card.get('[data-testid="telegram-connected"]').text()).toBe('Connected to On-call.');
    w.unmount();
  });
});

describe('Slack and webhook cards', () => {
  it('adds a webhook, shows its signing secret once, and sends a test', async () => {
    const hook = channel({ config: { url: 'https://hooks.example.com/x' } });
    const { w, calls } = await mountChannels({
      'GET /api/v1/alert-channels': [
        { status: 200, body: { channels: [] } },
        { status: 200, body: { channels: [hook] } },
        { status: 200, body: { channels: [hook] } },
      ],
      'POST /api/v1/alert-channels': {
        status: 201,
        body: { channel: hook, signingSecret: 'whsec-shown-once-123456' },
      },
      [`POST /api/v1/alert-channels/${hook.id}/test`]: {
        status: 200,
        body: { ok: false, error: 'Webhook answered 404: gone' },
      },
    } as Routes);
    await w.get('[data-testid="add-webhook"]').trigger('click');
    const form = w.get('[data-testid="add-webhook-form"]');
    const inputs = form.findAll('input[type="text"]');
    await inputs[0]!.setValue('https://hooks.example.com/x');
    await inputs[1]!.setValue('Bridge');
    await form.trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      type: 'webhook',
      name: 'Bridge',
      settings: { url: 'https://hooks.example.com/x' },
      useForAllRules: true,
    });
    expect(w.get('[data-testid="signing-secret"]').text()).toContain('whsec-shown-once-123456');
    await w
      .findAll('[data-testid="signing-secret"] button')
      .find((b) => b.text() === 'Done')!
      .trigger('click');
    await flushPromises();
    await w.get('[data-testid="webhook-card"] [data-testid="send-test"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="test-result"]').text()).toBe(
      'Test failed: Webhook answered 404: gone',
    );
    w.unmount();
  });
});
