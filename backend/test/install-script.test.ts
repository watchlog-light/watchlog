// SPDX-License-Identifier: AGPL-3.0-only
// GET /install.sh (ADR-209): the server install script with this install's address and its
// own release as the defaults; no token in it.
import { afterEach, describe, expect, it } from 'vitest';
import { renderInstallScript } from '../src/modules/onboarding/install-script.js';
import { closeTestContext, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(async () => {
  if (ctx) await closeTestContext(ctx);
  ctx = undefined;
});

const BASE =
  '#!/bin/sh\nURL=${WATCHLOG_URL:-https://ingest.watchlog.io}\nVERSION=${WATCHLOG_VERSION:-}\n';

describe('the install script', () => {
  it("pins this install's address, and its release when it is one", () => {
    expect(renderInstallScript(BASE, 'https://watchlog.acme.io', '0.9.0')).toBe(
      '#!/bin/sh\nURL=${WATCHLOG_URL:-https://watchlog.acme.io}\nVERSION=${WATCHLOG_VERSION:-0.9.0}\n',
    );
    // A development build keeps "the latest release".
    expect(renderInstallScript(BASE, 'http://localhost:4080', '0.9.0-12-gabc1234')).toContain(
      'VERSION=${WATCHLOG_VERSION:-}\n',
    );
  });

  it('serves the real script at /install.sh, public, with the address agents use', async () => {
    ctx = await createTestContext({ version: '0.9.0' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/install.sh',
      headers: { host: 'watchlog.lan:8080' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/x-shellscript');
    expect(res.body.startsWith('#!/bin/sh')).toBe(true);
    expect(res.body).toContain('VERSION=${WATCHLOG_VERSION:-0.9.0}');
    expect(res.body).toMatch(/^URL=\$\{WATCHLOG_URL:-https?:\/\/[^}]+\}$/m);
    expect(res.body).not.toContain('ingest.watchlog.io}');
    expect(res.body).toContain('--uninstall');
  });
});
