// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node
// One source for every snippet (1.0.3): what the docs show is what @watchlog/snippets writes,
// the same package the Add a source page fills in. `pnpm docs:snippets` rewrites the docs.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  docSnippet,
  docSnippetIds,
  EXPOSE_LANGS,
  exposeSnippet,
  fillDocSnippets,
  installSnippet,
  kubectlPatchSnippet,
  PUSH_LANGS,
  pushSnippet,
  remoteWriteSnippet,
} from '@watchlog/snippets';
import { describe, expect, it } from 'vitest';

const DOCS = fileURLToPath(new URL('../../docs/site/', import.meta.url));
const pages = readdirSync(DOCS).filter((f) => f.endsWith('.md'));

describe('the docs’ snippets', () => {
  it('are the package’s own, in every page (run pnpm docs:snippets when this fails)', () => {
    let seen = 0;
    for (const name of pages) {
      const md = readFileSync(DOCS + name, 'utf8');
      seen += docSnippetIds(md).length;
      expect(fillDocSnippets(md), name).toBe(md);
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('your-metrics.md opens with the push path in every language, then which way is for whom', () => {
    const md = readFileSync(`${DOCS}your-metrics.md`, 'utf8');
    const ids = docSnippetIds(md);
    for (const lang of PUSH_LANGS) expect(ids).toContain(`push:${lang}`);
    for (const lang of EXPOSE_LANGS) expect(ids).toContain(`expose:${lang}`);
    for (const id of ['remote-write', 'annotation', 'kubectl-patch', 'metrics-sample'])
      expect(ids).toContain(id);
    const first = md.indexOf('## Your first metric in two minutes');
    const which = md.indexOf('## Which way is for me');
    const plans = md.indexOf('## What each plan includes');
    expect(first).toBeGreaterThan(0);
    expect(which).toBeGreaterThan(first);
    expect(plans).toBeGreaterThan(which);
    expect(md).toContain(
      '`orders_total` is 1\nseries however often you send it. `orders_total` split by 3 payment methods is 3.',
    );
    expect(md).toContain('## Limits on sending');
  });
});

describe('the snippets themselves', () => {
  const o = {
    endpoint: 'https://wl.example/',
    token: 'wl_mt_abc',
    name: 'orders_total',
    value: '3',
    owner: { workload: 'shop/orders' },
  };
  it('carry the address, the token, the name, the value and the owner in every language', () => {
    for (const lang of PUSH_LANGS) {
      const code = pushSnippet(lang, o);
      expect(code, lang).toContain('https://wl.example/ingest/v1/metrics');
      expect(code, lang).toContain('Bearer wl_mt_abc');
      expect(code, lang).toContain('orders_total');
      expect(code, lang).toContain('shop/orders');
      expect(code, lang).toMatch(/workload/);
      expect(code, lang).not.toContain('wl.example//');
    }
    // No token yet: the placeholder. No owner: none named. Not a number: 1.
    const bare = pushSnippet('curl', { ...o, token: '', owner: null, value: 'many' });
    expect(bare).toContain('Bearer wl_mt_…');
    expect(bare).toContain(`-d '{"name": "orders_total", "value": 1}'`);
    // A time is the clock's, and a crontab can't be handed a bare % (the script has none).
    const stamp = pushSnippet('cron', { ...o, name: 'backup_last_success_timestamp_seconds' });
    expect(stamp).toContain('value=$(date +%s)');
    expect(stamp.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('remote write keeps only named metrics; the annotation is one command or YAML', () => {
    const rw = remoteWriteSnippet('https://wl.example', 'wl_mt_abc');
    expect(rw).toContain('url: https://wl.example/ingest/v1/write');
    expect(rw).toContain('credentials: wl_mt_abc');
    expect(rw).toContain('action: keep');
    const patch = kubectlPatchSnippet({
      namespace: 'shop',
      kind: 'StatefulSet',
      name: 'db',
      port: 9187,
      path: '/internal/metrics',
    });
    expect(patch).toContain('kubectl -n shop patch statefulset db --type merge');
    expect(patch).toContain('"watchlog.io/path":"/internal/metrics"');
    expect(JSON.parse(patch.split("-p '")[1]!.slice(0, -1))).toEqual({
      spec: {
        template: {
          metadata: {
            annotations: {
              'watchlog.io/scrape': 'true',
              'watchlog.io/port': '9187',
              'watchlog.io/path': '/internal/metrics',
            },
          },
        },
      },
    });
  });

  it('each language’s /metrics example names its library as its documentation does', () => {
    expect(exposeSnippet('node')).toContain('require("@prometheus-io/client")');
    expect(exposeSnippet('python')).toContain(
      'from prometheus_client import Counter, start_http_server',
    );
    expect(exposeSnippet('go')).toContain(
      'github.com/prometheus/client_golang/prometheus/promhttp',
    );
    expect(exposeSnippet('php')).toContain('promphp/prometheus_client_php');
    expect(exposeSnippet('java')).toContain('io.prometheus.metrics.exporter.httpserver.HTTPServer');
    expect(docSnippet('nothing')).toBeNull();
  });

  it('install.md opens each way in with the commands the demo tour gives (1.3.0)', () => {
    const md = readFileSync(`${DOCS}install.md`, 'utf8');
    const version = /--version (\d+\.\d+\.\d+)/.exec(md)![1]!;
    expect(md).toContain(installSnippet('kubernetes', version));
    expect(md).toContain(installSnippet('server', version));
  });
});
