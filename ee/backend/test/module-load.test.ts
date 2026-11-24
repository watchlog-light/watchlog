// SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise
// The module loads the way the app loads it (index.ts first): its files import each other, and
// nothing may be read at a module's top before the file it comes from has run.
import { describe, expect, it } from 'vitest';

describe('the network module', () => {
  it('loads from its index with every rule', async () => {
    const { network } = await import('../src/network/index.js');
    expect(network.feature).toBe('network');
    const { networkRules } = await import('../src/network/alerts.js');
    const keys = networkRules({ sql: () => '' } as never).map((r) => r.key);
    expect(keys).toContain('network.recorder.not_recording');
    expect(new Set(keys).size).toBe(keys.length);
  });
});
