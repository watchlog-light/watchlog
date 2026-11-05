// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Remote-Write 1.0 reader (ADR-026): validates a request and counts its series
// without building objects for every sample. The body is forwarded unchanged.
import { uncompressSync } from 'snappy';

/** Labels only the backend may set; agents must never send them (SPEC §5.2). */
export const RESERVED_LABELS = new Set(['cluster_id', 'tenant_id']);

export class RemoteWriteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

interface Cursor {
  buf: Uint8Array;
  pos: number;
}

function readVarint(c: Cursor): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (c.pos >= c.buf.length) throw new RemoteWriteError('truncated varint', 400);
    const byte = c.buf[c.pos++]!;
    // Values above 2^53 cannot be lengths we accept; precision loss is irrelevant there.
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  throw new RemoteWriteError('varint too long', 400);
}

/** Decoded length declared in a snappy block header, read before decompressing. */
export function snappyDeclaredLength(body: Uint8Array): number {
  return readVarint({ buf: body, pos: 0 });
}

function readLengthDelimited(c: Cursor): Uint8Array {
  const len = readVarint(c);
  if (c.pos + len > c.buf.length) throw new RemoteWriteError('truncated field', 400);
  const out = c.buf.subarray(c.pos, c.pos + len);
  c.pos += len;
  return out;
}

function skipField(c: Cursor, wireType: number): void {
  switch (wireType) {
    case 0:
      readVarint(c);
      return;
    case 1:
      c.pos += 8;
      break;
    case 2:
      readLengthDelimited(c);
      return;
    case 5:
      c.pos += 4;
      break;
    default:
      throw new RemoteWriteError(`unsupported wire type ${wireType}`, 400);
  }
  if (c.pos > c.buf.length) throw new RemoteWriteError('truncated field', 400);
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function readLabelName(label: Uint8Array): string | undefined {
  const c: Cursor = { buf: label, pos: 0 };
  let name: string | undefined;
  while (c.pos < c.buf.length) {
    const tag = readVarint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) {
      try {
        name = decoder.decode(readLengthDelimited(c));
      } catch (err) {
        if (err instanceof RemoteWriteError) throw err;
        throw new RemoteWriteError('label name is not valid UTF-8', 400);
      }
    } else {
      skipField(c, wire);
    }
  }
  return name;
}

export interface WriteSummary {
  series: number;
  samples: number;
  decodedBytes: number;
}

export interface WriteLimits {
  maxDecodedBytes: number;
  maxSeries: number;
}

/** Decompresses and validates a remote_write body; throws RemoteWriteError. */
export function inspectWriteRequest(body: Uint8Array, limits: WriteLimits): WriteSummary {
  if (body.length === 0) throw new RemoteWriteError('empty body', 400);
  const declared = snappyDeclaredLength(body);
  if (declared > limits.maxDecodedBytes) {
    throw new RemoteWriteError(`decoded body would be ${declared} bytes`, 413);
  }
  let raw: Uint8Array;
  try {
    raw = uncompressSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength)) as Buffer;
  } catch {
    throw new RemoteWriteError('body is not valid snappy', 400);
  }

  const c: Cursor = { buf: raw, pos: 0 };
  let series = 0;
  let samples = 0;
  while (c.pos < c.buf.length) {
    const tag = readVarint(c);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field !== 1 || wire !== 2) {
      skipField(c, wire); // metadata and other fields are allowed and ignored
      continue;
    }
    series++;
    if (series > limits.maxSeries) {
      throw new RemoteWriteError(`more than ${limits.maxSeries} series in one request`, 413);
    }
    const ts: Cursor = { buf: readLengthDelimited(c), pos: 0 };
    let hasName = false;
    while (ts.pos < ts.buf.length) {
      const t = readVarint(ts);
      const f = Math.floor(t / 8);
      const w = t % 8;
      if (f === 1 && w === 2) {
        const name = readLabelName(readLengthDelimited(ts));
        if (name === undefined) throw new RemoteWriteError('label without a name', 400);
        if (RESERVED_LABELS.has(name)) {
          throw new RemoteWriteError(`label "${name}" is reserved and set by the server`, 400);
        }
        if (name === '__name__') hasName = true;
      } else if (f === 2 && w === 2) {
        readLengthDelimited(ts);
        samples++;
      } else {
        skipField(ts, w);
      }
    }
    if (!hasName) throw new RemoteWriteError('series without __name__', 400);
  }
  return { series, samples, decodedBytes: raw.length };
}
