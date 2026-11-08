// SPDX-License-Identifier: AGPL-3.0-only
// The MCP output layer (ADR-128, ADR-129): cluster text cleaned and capped, lists cut to
// fit 16 KB with a hint, errors with WatchLog's sentence and the data beside it.
import { describe, expect, it } from 'vitest';
import {
  errorJson,
  finish,
  label,
  labels,
  MAX_OUTPUT_BYTES,
  message,
  name,
  ToolError,
} from '../src/modules/mcp/output.js';

describe('cluster text', () => {
  it('drops control and invisible characters and turns line breaks into spaces', () => {
    expect(name('web\u0000-1\u0007')).toBe('web-1');
    expect(name('a\r\n\tb')).toBe('a b');
    expect(name('evil\u202egnp.exe')).toBe('evilgnp.exe');
    expect(name('zero\u200bwidth\ufeff')).toBe('zerowidth');
    expect(message('line one\u2028line two')).toBe('line one line two');
    expect(name(null)).toBeNull();
    expect(name(undefined)).toBeNull();
  });

  it('caps names, messages and labels with an ellipsis, by characters', () => {
    expect(name('x'.repeat(300))).toBe(`${'x'.repeat(252)}…`);
    expect(message('y'.repeat(600))!.length).toBe(512);
    expect(label('z'.repeat(64))).toBe(`${'z'.repeat(62)}…`);
    // Not cut inside a surrogate pair.
    expect(label('🙂'.repeat(70))).toBe(`${'🙂'.repeat(62)}…`);
    expect(labels({ pod: 'a\nb', ['k'.repeat(80)]: 'v' })).toEqual({
      pod: 'a b',
      [`${'k'.repeat(62)}…`]: 'v',
    });
  });
});

describe('finish', () => {
  const list = (n: number, size = 10) => ({
    key: 'items',
    items: Array.from({ length: n }, (_, i) => ({ i, pad: 'p'.repeat(size) })),
    noun: 'items',
    narrow: 'Pass `namespace` to narrow it.',
  });

  it('leaves a short answer alone', () => {
    const r = finish({ body: { a: 1 }, list: { ...list(3), total: 3 } });
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.json)).toEqual({ a: 1, items: list(3).items });
  });

  it('says when a list was capped before, and how to narrow it', () => {
    const r = finish({ body: {}, list: { ...list(50), total: 73 } });
    expect(r.truncated).toBe(true);
    expect(JSON.parse(r.json)).toMatchObject({
      truncated: true,
      shown: 50,
      total: 73,
      hint: 'Truncated to 50 items of 73. Pass `namespace` to narrow it.',
    });
  });

  it('cuts a list to fit 16 KB', () => {
    const r = finish({ body: { cluster: 'c' }, list: { ...list(50, 1000), total: 50 } });
    expect(Buffer.byteLength(r.json)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const out = JSON.parse(r.json);
    expect(r.truncated).toBe(true);
    expect(out.items.length).toBe(out.shown);
    expect(out.shown).toBeGreaterThan(10);
    expect(out.total).toBe(50);
  });
});

describe('errors', () => {
  it('keep the asked values as data beside the sentence', () => {
    const json = errorJson(
      new ToolError('No pod with this name in this namespace.', 'Take it from get_problems.', {
        name: 'web-1',
      }),
    );
    expect(JSON.parse(json)).toEqual({
      error: 'No pod with this name in this namespace.',
      hint: 'Take it from get_problems.',
      name: 'web-1',
    });
  });
});
