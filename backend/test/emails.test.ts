// SPDX-License-Identifier: AGPL-3.0-only
// Every email in the one template (ADR-220): a snapshot of each one's HTML and plain text,
// what real mail clients need (size, no remote anything, no tracking, lang, roles, contrast,
// a 44 px button), escaping with hostile names, the alert thread, unsubscribe only on the
// lifecycle emails, and Cloud named only in Cloud.
import { describe, expect, it } from 'vitest';
import { escapeHtml, headerText, MAX_HTML_BYTES, renderEmail, safeUrl } from '@watchlog/email';
import { message, render } from '../src/lib/mail.js';
import type { MessagePayload } from '../src/modules/alerts/outbox.js';
import { renderMessage } from '../src/modules/alerts/render.js';
import { inviteEmail, resetEmail, verifyEmail } from '../src/modules/emails/account.js';
import { alertEmail, alertThread } from '../src/modules/emails/alerts.js';
import { samples } from '../src/modules/emails/samples.js';
import { supportStartedEmail, whatChangedReadyEmail } from '../src/modules/emails/notices.js';

const ALL = samples().map((s) => ({ ...s, out: render(s.spec, s.edition) }));

describe('every email, as sent', () => {
  it('covers each kind of email the backend sends', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ALL.map((s) => s.name)).size).toBe(ALL.length);
  });

  for (const s of ALL) {
    it(`${s.name}: the HTML and the text match their snapshots`, async () => {
      await expect(s.out.html).toMatchFileSnapshot(`__snapshots__/emails/${s.name}.html`);
      await expect(`Subject: ${s.out.subject}\n\n${s.out.text}`).toMatchFileSnapshot(
        `__snapshots__/emails/${s.name}.txt`,
      );
    });
  }

  it('is under Gmail’s clipping size, with nothing remote, nothing tracked, nothing run', () => {
    for (const s of ALL) {
      const { html, text } = s.out;
      expect(Buffer.byteLength(html), s.name).toBeLessThan(MAX_HTML_BYTES);
      expect(Buffer.byteLength(html), s.name).toBeLessThan(20_000);
      for (const part of [html, text]) {
        expect(part, s.name).not.toContain('http://');
        expect(part, s.name).not.toMatch(/[?&](utm_|mc_|_hs|trk|ref=)/i);
      }
      expect(html, s.name).not.toMatch(/<img|<script|<link|@import|url\(|<iframe|<form|<video/i);
      expect(html, s.name).not.toMatch(/\son[a-z]+=/i);
      // Fonts: system ones only.
      expect(html, s.name).not.toMatch(/fonts\.googleapis|@font-face/i);
    }
  });

  it('is accessible: lang, layout tables marked, a 44 px button with real text, a title', () => {
    for (const s of ALL) {
      const { html } = s.out;
      expect(html, s.name).toContain('<html lang="en"');
      expect(html, s.name).toMatch(/<title>[^<]+<\/title>/);
      const tables = html.match(/<table[^>]*>/g) ?? [];
      for (const t of tables) {
        // The facts table is data (row headers); every other table is layout.
        if (t.includes('wl-box')) expect(t, s.name).not.toContain('role="presentation"');
        else expect(t, s.name).toContain('role="presentation"');
      }
      const button = /class="wl-btn-a" style="[^"]*padding:12px 24px;font:600 16px\/20px/;
      if (s.spec.button) expect(html, s.name).toMatch(button);
      // Link text is words or the address itself, never "here".
      expect(html, s.name).not.toMatch(/>\s*(click )?here\s*</i);
    }
  });

  it('meets 4.5:1 contrast for its text colours, light and dark', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const html = ALL.find((s) => s.name === 'alert-firing')!.out.html;
    // [text, background] pairs the template uses, each present in it.
    const pairs: [string, string][] = [
      ['#111827', '#ffffff'],
      ['#374151', '#ffffff'],
      ['#4b5563', '#ffffff'],
      ['#4b5563', '#f9fafb'],
      ['#15803d', '#ffffff'],
      ['#ffffff', '#15803d'],
      ['#991b1b', '#fee2e2'],
      ['#15803d', '#f0fdf4'],
      // Dark.
      ['#e8eaed', '#15181c'],
      ['#c9cdd2', '#15181c'],
      ['#a8aeb5', '#111317'],
      ['#4ade80', '#15181c'],
      ['#fca5a5', '#3b1212'],
    ];
    for (const [fg, bg] of pairs) {
      expect(html, fg).toContain(fg);
      expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const s of ALL) {
      expect(s.out.html, s.name).toContain('<meta name="color-scheme" content="light dark">');
      expect(s.out.html, s.name).toContain('@media (prefers-color-scheme:dark)');
      expect(s.out.html, s.name).toContain('[data-ogsc] .wl-card');
    }
  });

  it('has a written plain-text part: no markup, the title first, the link spelled out', () => {
    for (const s of ALL) {
      const { text } = s.out;
      expect(text, s.name).not.toMatch(/<[a-z]+[\s>]/i);
      expect(text, s.name).toContain(s.spec.title);
      expect(text, s.name).toMatch(/\n-- \n/);
      if (s.spec.button) expect(text, s.name).toContain(s.spec.button.url);
      for (const l of text.split('\n')) {
        if (!/https?:\/\//.test(l)) expect(l.length, `${s.name}: ${l}`).toBeLessThanOrEqual(80);
      }
    }
  });

  it('has a preheader that continues the subject, hidden', () => {
    for (const s of ALL) {
      expect(s.spec.preheader.length, s.name).toBeGreaterThan(10);
      expect(s.out.html, s.name).toContain(`aria-hidden="true">${escapeHtml(s.spec.preheader)}`);
      expect(s.spec.preheader, s.name).not.toBe(s.spec.subject);
    }
  });

  it('names Cloud only in Cloud, and points every link at the installation', () => {
    for (const s of ALL) {
      if (s.edition === 'cloud') expect(s.out.html, s.name).toContain('WatchLog Cloud ·');
      else {
        expect(s.out.html, s.name).not.toContain('WatchLog Cloud');
        expect(s.out.text, s.name).not.toContain('WatchLog Cloud');
      }
    }
    const self = ALL.find((s) => s.name === 'invite-community')!;
    expect(self.out.html).toContain('https://watchlog.acme.example/invite/');
  });

  it('carries an unsubscribe only on the lifecycle emails; the others say why they came', () => {
    for (const s of ALL) {
      const life = s.name.startsWith('lifecycle-') && s.name !== 'lifecycle-beta-notice';
      expect(s.out.html.includes('Unsubscribe from these emails'), s.name).toBe(life);
      expect(s.out.text.includes('Unsubscribe: '), s.name).toBe(life);
      expect(s.spec.footer.why, s.name).toMatch(/^You got this because /);
      const msg = message(
        {
          to: 'a@example.com',
          email: s.out,
          ...(s.unsubscribeUrl ? { unsubscribeUrl: s.unsubscribeUrl } : {}),
        },
        'WatchLog <no-reply@watchlog.example>',
      );
      const headers = (msg as { headers?: Record<string, string> }).headers ?? {};
      expect('List-Unsubscribe' in headers, s.name).toBe(life);
      if (life) expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(msg.html, s.name).toBe(s.out.html);
      expect(msg.text, s.name).toBe(s.out.text);
    }
  });

  it('never shows a secret, a token or a command line', () => {
    for (const s of ALL) {
      for (const part of [s.out.html, s.out.text]) {
        expect(part, s.name).not.toMatch(/wl_(pat|agt|sc)_[A-Za-z0-9]{8,}/);
        expect(part, s.name).not.toMatch(/--token|helm install|kubectl apply|curl -fsSL/);
      }
    }
  });
});

describe('subjects and the verification code', () => {
  it('puts the code in the subject and the box, spaced', () => {
    const v = render(
      verifyEmail({ code: '482913', link: 'https://x.example/verify-email/t' }),
      'cloud',
    );
    expect(v.subject).toBe('482 913 is your WatchLog code');
    expect(v.html).toContain('>482 913</div>');
    expect(v.text).toContain('    482 913\n    Valid for 15 minutes');
  });

  it('names the alert and the place, threads a resolve under its firing email', () => {
    const fired = ALL.find((s) => s.name === 'alert-firing')!;
    const resolved = ALL.find((s) => s.name === 'alert-resolved')!;
    expect(fired.out.subject).toBe('[Critical] api is crash-looping in acme-prod');
    expect(resolved.out.subject).toBe('[Resolved] api is crash-looping in acme-prod');
    expect(ALL.find((s) => s.name === 'alert-firing-server')!.out.subject).toBe(
      '[Critical] api is crash-looping on app-1 in acme-servers',
    );
    expect(ALL.find((s) => s.name === 'alert-warning')!.out.subject).toMatch(/^\[Warning\] /);

    const p = (kind: MessagePayload['kind']): MessagePayload => ({
      version: 1,
      kind,
      severity: 'critical',
      rule: { id: 'r', key: null, name: 'R' },
      cluster: { id: 'c', name: 'prod', kind: 'kubernetes' },
      items: [
        {
          alertId: 'a9',
          severity: 'critical',
          labels: { node: 'n1' },
          details: {},
          startedAt: '2026-11-19T14:00:00.000Z',
          firedAt: '2026-11-19T14:01:00.000Z',
          resolvedAt: kind === 'resolved' ? '2026-11-19T14:30:00.000Z' : null,
        },
      ],
      total: 1,
      at: '2026-11-19T14:30:00.000Z',
    });
    const thread = (k: MessagePayload['kind'], id: string) =>
      alertThread(p(k), renderMessage(p(k)), id, 'watchlog.example');
    const root = thread('firing', 'n1');
    expect(root).toEqual({
      messageId: `<alert-a9.${Date.parse('2026-11-19T14:01:00.000Z')}@watchlog.example>`,
    });
    for (const k of ['resolved', 'renotify', 'escalated'] as const) {
      expect(thread(k, `n-${k}`)).toEqual({
        messageId: `<n-${k}@watchlog.example>`,
        inReplyTo: root.messageId,
      });
    }
    const msg = message(
      { to: 'a@example.com', email: renderEmail({ ...fired.spec }), ...thread('resolved', 'n2') },
      'x@watchlog.example',
    ) as { inReplyTo?: string; references?: string[] };
    expect(msg.inReplyTo).toBe(root.messageId);
    expect(msg.references).toEqual([root.messageId]);
  });

  it('a batch names the rule and the count, and lists its alerts', () => {
    const b = ALL.find((s) => s.name === 'alert-batch')!;
    expect(b.out.subject).toBe('[Critical] Pod CrashLoopBackOff: 7 alerts in acme-prod');
    expect(b.out.text).toContain('And 2 more');
  });

  it('shows the likely cause, and on Pro what changed around it, on a firing alert', () => {
    const f = ALL.find((s) => s.name === 'alert-firing')!;
    expect(f.out.html).toContain('Likely cause');
    expect(f.out.html).toContain('What changed around it');
    const r = ALL.find((s) => s.name === 'alert-resolved')!;
    expect(r.out.html).toContain('Was likely');
    expect(r.out.html).not.toContain('What changed around it');
    for (const label of ['Where', 'Since', 'Rule', 'Now']) {
      expect(f.out.text, label).toMatch(new RegExp(`^${label}:`, 'm'));
    }
  });
});

describe('hostile names', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>\r\nBcc: victim@example.org';

  it('are escaped in the HTML and kept out of the headers', () => {
    const specs = [
      inviteEmail({
        inviter: evil,
        inviterEmail: 'x@example.org',
        org: evil,
        role: 'viewer',
        link: 'https://cloud.watchlog.example/invite/t',
        expires: new Date('2026-11-26T00:00:00Z'),
      }),
      supportStartedEmail({
        orgName: evil,
        staffEmail: 'support@watchlog.example',
        reason: evil,
        expiresAt: new Date('2026-11-26T00:00:00Z'),
        site: 'https://cloud.watchlog.example',
      }),
      whatChangedReadyEmail({
        site: 'https://cloud.watchlog.example',
        cluster: { id: 'c1"><script>', name: evil, kind: 'kubernetes' },
      }),
      resetEmail({ link: 'https://x.example/reset/t', by: evil, device: evil }),
    ];
    const alert: MessagePayload = {
      version: 1,
      kind: 'firing',
      severity: 'critical',
      rule: { id: 'r', key: 'k8s.pod.crashloop', name: evil },
      cluster: { id: 'c', name: evil, kind: 'kubernetes' },
      items: [
        {
          alertId: 'a',
          severity: 'critical',
          labels: { namespace: evil, pod: evil, workload: evil, workload_kind: 'Deployment' },
          details: { reason: evil, exitCode: 1, restarts: 2 },
          startedAt: '2026-11-19T14:00:00.000Z',
          firedAt: '2026-11-19T14:00:00.000Z',
          resolvedAt: null,
        },
      ],
      total: 1,
      at: '2026-11-19T14:10:00.000Z',
    };
    specs.push(alertEmail(alert, renderMessage(alert, 'https://cloud.watchlog.example')));
    for (const spec of specs) {
      for (const edition of ['cloud', 'community'] as const) {
        const out = render(spec, edition);
        // No tag gets through; the words stay as escaped text.
        expect(out.html).not.toMatch(/<script|<img|<[a-z][^>]*\sonerror=/i);
        expect(out.html).toContain('&lt;script&gt;');
        expect(out.subject).not.toMatch(/[\r\n]/);
        const msg = message({ to: 'a@example.com', email: out }, 'x@watchlog.example');
        expect(msg.subject).not.toMatch(/[\r\n]/);
        expect(out.text).not.toMatch(/\r/);
      }
    }
  });

  it('a link that is not http(s) gets no button', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('https://x.example/a?b=c')).toBe('https://x.example/a?b=c');
    const out = renderEmail({
      kind: 'info',
      subject: 's',
      preheader: 'p p p p p p',
      title: 't',
      button: { label: 'Go', url: 'javascript:alert(1)' },
      footer: { why: 'You got this because of a test.' },
    });
    expect(out.html).not.toContain('javascript:');
    expect(out.html).not.toContain('wl-btn-a');
  });

  it('headerText removes line breaks and control characters, and stays short', () => {
    expect(headerText('a\r\nBcc: b\u0000c d')).toBe('a Bcc: b c d');
    expect(headerText('x'.repeat(300)).length).toBe(200);
  });
});
