// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEV_SECRET_KEY, loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('loadConfig', () => {
  it('treats empty variables as unset (Compose passes VAR= when unset)', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://u:p@db:5432/watchlog',
      WATCHLOG_SECRET_KEY: KEY,
      WATCHLOG_PUBLIC_URL: '',
      WATCHLOG_INGEST_URL: '',
      VICTORIAMETRICS_URL: '',
      WATCHLOG_ADMIN_EMAIL: '',
      WATCHLOG_SMTP_URL: '',
      PORT: '',
    });
    expect(c.publicUrl).toBeUndefined();
    expect(c.victoriaMetricsUrl).toBeUndefined();
    expect(c.adminEmail).toBeUndefined();
    expect(c.smtp).toBeUndefined();
    expect(c.port).toBe(4080);
    expect(c.telegramApiUrl).toBe('https://api.telegram.org');
  });

  it('reads the country header and the fixed API token limits (ADR-125)', () => {
    const base = { DATABASE_URL: 'x', WATCHLOG_SECRET_KEY: KEY };
    expect(loadConfig(base).mcpEnabled).toBe(true);
    expect(loadConfig({ ...base, WATCHLOG_MCP_ENABLED: 'false' }).mcpEnabled).toBe(false);
    expect(() => loadConfig({ ...base, WATCHLOG_MCP_ENABLED: 'no' })).toThrow(
      /WATCHLOG_MCP_ENABLED/,
    );
    expect(loadConfig(base).clientCountryHeader).toBeUndefined();
    expect(loadConfig({ ...base, WATCHLOG_CLIENT_COUNTRY_HEADER: 'CF-IPCountry' })).toMatchObject({
      clientCountryHeader: 'CF-IPCountry',
      apiTokenLimits: { restPerMinute: 300, mcpCallsPerMinute: 60 },
    });
    expect(() => loadConfig({ ...base, WATCHLOG_CLIENT_COUNTRY_HEADER: 'a b' })).toThrow(
      /WATCHLOG_CLIENT_COUNTRY_HEADER/,
    );
  });

  it('rejects invalid URLs and ports', () => {
    const base = { DATABASE_URL: 'x', WATCHLOG_SECRET_KEY: KEY };
    expect(() => loadConfig({ ...base, WATCHLOG_PUBLIC_URL: 'not a url' })).toThrow(
      /WATCHLOG_PUBLIC_URL/,
    );
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses to start without a valid WATCHLOG_SECRET_KEY and never generates one (ADR-079)', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(
      /WATCHLOG_SECRET_KEY is not set.*openssl rand -base64 32.*backup/,
    );
    for (const bad of ['short', Buffer.alloc(16).toString('base64'), 'z'.repeat(64)]) {
      expect(() => loadConfig({ DATABASE_URL: 'x', WATCHLOG_SECRET_KEY: bad })).toThrow(
        /WATCHLOG_SECRET_KEY is malformed/,
      );
    }
    const hex = loadConfig({ DATABASE_URL: 'x', WATCHLOG_SECRET_KEY: 'ab'.repeat(32) });
    expect(hex.secretKey).toEqual(Buffer.alloc(32, 0xab));
    // Development mode uses the published dev key, the way it defaults DATABASE_URL.
    const dev = loadConfig({ NODE_ENV: 'development' });
    expect(dev.secretKey).toEqual(Buffer.from(DEV_SECRET_KEY, 'base64'));
  });
});
