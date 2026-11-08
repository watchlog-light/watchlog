// SPDX-License-Identifier: AGPL-3.0-only
// Demo mode never shows the kernel version (ADR-122): the demo's nodes share the host's
// kernel. Every JSON answer is cleaned, so the dashboard, the API and MCP all are.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerDemoHiddenFacts } from '../src/plugins/demo.js';

describe('demo hidden facts', () => {
  it('blanks every kernelVersion in JSON answers, and nothing else', async () => {
    const app = Fastify();
    registerDemoHiddenFacts(app);
    app.get('/node', async () => ({
      node: { name: 'k3d-demo-server-0', kernelVersion: '6.8.0-59-generic' },
      hosts: [{ kernelVersion: 'a"b\\c' }, { kernelVersion: null }],
      kernelVersions: 'kept',
      note: 'kernelVersion stays in text',
    }));
    app.get('/text', async (_req, reply) => reply.type('text/plain').send('"kernelVersion":"6.8"'));
    const res = await app.inject({ method: 'GET', url: '/node' });
    expect(res.json()).toEqual({
      node: { name: 'k3d-demo-server-0', kernelVersion: null },
      hosts: [{ kernelVersion: null }, { kernelVersion: null }],
      kernelVersions: 'kept',
      note: 'kernelVersion stays in text',
    });
    expect((await app.inject({ method: 'GET', url: '/text' })).body).toBe('"kernelVersion":"6.8"');
    await app.close();
  });
});
