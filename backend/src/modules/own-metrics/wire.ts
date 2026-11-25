// SPDX-License-Identifier: AGPL-3.0-only
// Prometheus remote write 1.0 for own metrics (1.0.0, ADR-236): a body is read in full (every
// series with its labels and samples, and the metadata's types), because each series is judged
// on its own (its name, its labels, the caps) and stored under labels the server sets. What is
// admitted is written again as a new body; the sender's bytes never reach the store unchanged.
import { compressSync, uncompressSync } from 'snappy';
import type { OwnType } from './naming.js';

export class WireError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

export interface WireSeries {
  name: string;
  /** Without `__name__`. */
  labels: Record<string, string>;
  /** [unix milliseconds, value] */
  samples: [number, number][];
}

export interface WireBatch {
  series: WireSeries[];
  /** Types by family name, from the request's metadata (Prometheus sends them). */
  types: Map<string, OwnType>;
}

export interface WireLimits {
  maxDecodedBytes: number;
  maxSeries: number;
  maxSamples: number;
}

interface Cursor {
  buf: Uint8Array;
  pos: number;
}

function varint(c: Cursor): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (c.pos >= c.buf.length) throw new WireError('truncated varint', 400);
    const byte = c.buf[c.pos++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  throw new WireError('varint too long', 400);
}

/** A varint as int64: a negative timestamp (ten bytes) is read as its two's complement. */
function varint64(c: Cursor): number {
  let lo = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (c.pos >= c.buf.length) throw new WireError('truncated varint', 400);
    const byte = c.buf[c.pos++]!;
    lo |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return Number(BigInt.asIntN(64, lo));
    shift += 7n;
  }
  throw new WireError('varint too long', 400);
}

function bytes(c: Cursor): Uint8Array {
  const len = varint(c);
  if (c.pos + len > c.buf.length) throw new WireError('truncated field', 400);
  const out = c.buf.subarray(c.pos, c.pos + len);
  c.pos += len;
  return out;
}

function skip(c: Cursor, wire: number): void {
  if (wire === 0) varint(c);
  else if (wire === 1) c.pos += 8;
  else if (wire === 2) bytes(c);
  else if (wire === 5) c.pos += 4;
  else throw new WireError(`unsupported wire type ${wire}`, 400);
  if (c.pos > c.buf.length) throw new WireError('truncated field', 400);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function text(b: Uint8Array, what: string): string {
  try {
    return utf8.decode(b);
  } catch {
    throw new WireError(`${what} is not valid UTF-8`, 400);
  }
}

function readLabel(b: Uint8Array): [string, string] {
  const c: Cursor = { buf: b, pos: 0 };
  let name = '';
  let value = '';
  while (c.pos < c.buf.length) {
    const tag = varint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) name = text(bytes(c), 'a label name');
    else if (field === 2 && wire === 2) value = text(bytes(c), 'a label value');
    else skip(c, wire);
  }
  return [name, value];
}

function readSample(b: Uint8Array): [number, number] {
  const c: Cursor = { buf: b, pos: 0 };
  let value = 0;
  let ts = 0;
  while (c.pos < c.buf.length) {
    const tag = varint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 1) {
      if (c.pos + 8 > c.buf.length) throw new WireError('truncated sample', 400);
      value = new DataView(c.buf.buffer, c.buf.byteOffset + c.pos, 8).getFloat64(0, true);
      c.pos += 8;
    } else if (field === 2 && wire === 0) ts = varint64(c);
    else skip(c, wire);
  }
  return [ts, value];
}

/** MetricMetadata.MetricType → a type; the kinds own metrics don't have are left out. */
const META_TYPE: Record<number, OwnType> = {
  1: 'counter',
  2: 'gauge',
  3: 'histogram',
  5: 'summary',
};

function readMetadata(b: Uint8Array): [string, OwnType] | null {
  const c: Cursor = { buf: b, pos: 0 };
  let type = 0;
  let family = '';
  while (c.pos < c.buf.length) {
    const tag = varint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 0) type = varint(c);
    else if (field === 2 && wire === 2) family = text(bytes(c), 'a metric family name');
    else skip(c, wire);
  }
  const t = META_TYPE[type];
  return family && t ? [family, t] : null;
}

/** Reads a snappy-compressed WriteRequest; throws WireError. */
export function decodeWrite(body: Uint8Array, limits: WireLimits): WireBatch {
  if (body.length === 0) throw new WireError('empty body', 400);
  const declared = varint({ buf: body, pos: 0 });
  if (declared > limits.maxDecodedBytes)
    throw new WireError(`decoded body would be ${declared} bytes`, 413);
  let raw: Uint8Array;
  try {
    raw = uncompressSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength)) as Buffer;
  } catch {
    throw new WireError('body is not valid snappy', 400);
  }
  const c: Cursor = { buf: raw, pos: 0 };
  const series: WireSeries[] = [];
  const types = new Map<string, OwnType>();
  let samples = 0;
  while (c.pos < c.buf.length) {
    const tag = varint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 3 && wire === 2) {
      const m = readMetadata(bytes(c));
      if (m) types.set(m[0], m[1]);
      continue;
    }
    if (field !== 1 || wire !== 2) {
      skip(c, wire);
      continue;
    }
    if (series.length >= limits.maxSeries)
      throw new WireError(`more than ${limits.maxSeries} series in one request`, 413);
    const ts: Cursor = { buf: bytes(c), pos: 0 };
    const s: WireSeries = { name: '', labels: {}, samples: [] };
    while (ts.pos < ts.buf.length) {
      const t = varint(ts);
      const f = Math.floor(t / 8);
      const w = t % 8;
      if (f === 1 && w === 2) {
        const [name, value] = readLabel(bytes(ts));
        if (!name) throw new WireError('label without a name', 400);
        if (name === '__name__') s.name = value;
        else s.labels[name] = value;
      } else if (f === 2 && w === 2) {
        if (++samples > limits.maxSamples)
          throw new WireError(`more than ${limits.maxSamples} samples in one request`, 413);
        s.samples.push(readSample(bytes(ts)));
      } else skip(ts, w);
    }
    if (!s.name) throw new WireError('series without __name__', 400);
    series.push(s);
  }
  return { series, types };
}

// ---------------------------------------------------------------------------- writing

class Writer {
  private buf = Buffer.allocUnsafe(64 << 10);
  private len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  varint(v: number) {
    this.room(10);
    while (v >= 0x80) {
      this.buf[this.len++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.len++] = v;
  }
  /** int64 as a varint; a negative value takes ten bytes. */
  int64(v: number) {
    if (v >= 0) return this.varint(v);
    this.room(10);
    let n = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    while (n >= 0x80n) {
      this.buf[this.len++] = Number(n & 0x7fn) | 0x80;
      n >>= 7n;
    }
    this.buf[this.len++] = Number(n);
  }
  double(v: number) {
    this.room(8);
    this.buf.writeDoubleLE(v, this.len);
    this.len += 8;
  }
  string(s: string) {
    const n = Buffer.byteLength(s);
    this.varint(n);
    this.room(n);
    this.buf.write(s, this.len, n, 'utf8');
    this.len += n;
  }
  raw(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  bytes(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

function label(name: string, value: string): Buffer {
  const w = new Writer();
  w.varint(0x0a);
  w.string(name);
  w.varint(0x12);
  w.string(value);
  return w.bytes();
}

/** One series to store: its name and labels as the server set them. */
export interface StoredSeries {
  name: string;
  labels: Record<string, string>;
  samples: readonly (readonly [number, number])[];
}

/** A snappy-compressed WriteRequest of these series, labels in name order (the spec's). */
export function encodeWrite(series: readonly StoredSeries[]): Buffer {
  const out = new Writer();
  for (const s of series) {
    const ts = new Writer();
    const labels: [string, string][] = [['__name__', s.name], ...Object.entries(s.labels)];
    labels.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [k, v] of labels) {
      const l = label(k, v);
      ts.varint(0x0a);
      ts.varint(l.length);
      ts.raw(l);
    }
    for (const [at, value] of s.samples) {
      const sample = new Writer();
      sample.varint(0x09);
      sample.double(value);
      sample.varint(0x10);
      sample.int64(at);
      const b = sample.bytes();
      ts.varint(0x12);
      ts.varint(b.length);
      ts.raw(b);
    }
    const b = ts.bytes();
    out.varint(0x0a);
    out.varint(b.length);
    out.raw(b);
  }
  return compressSync(out.bytes()) as Buffer;
}
