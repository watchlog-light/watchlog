// SPDX-License-Identifier: AGPL-3.0-only
// Breaking changes between two versions of the public spec (ADR-126). A client written
// against the old spec must keep working with the new one:
//   - every operation is still there;
//   - it sends nothing the new one refuses: no new required parameter or body field, no
//     parameter removed, no type or allowed value taken away;
//   - it reads nothing it can't handle: no response field removed or made optional, no
//     new type (null included) where it expected one. New fields and new enum values are
//     additions, which clients are told to tolerate.

type Schema = Record<string, unknown>;
type Op = {
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema }[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};
type Spec = { paths?: Record<string, Record<string, Op>> };

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;

/** The JSON types a schema allows; `undefined` when it allows any. */
function typesOf(s: Schema | undefined): Set<string> | undefined {
  if (!s) return undefined;
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const out = new Set<string>();
    for (const v of (s.anyOf ?? s.oneOf) as Schema[]) {
      const t = typesOf(v);
      if (!t) return undefined;
      t.forEach((x) => out.add(x));
    }
    return out;
  }
  if ('const' in s) return new Set([jsonType(s.const)]);
  if (Array.isArray(s.enum)) return new Set((s.enum as unknown[]).map(jsonType));
  if (typeof s.type === 'string') return new Set([s.type === 'integer' ? 'number' : s.type]);
  if (Array.isArray(s.type)) {
    return new Set((s.type as string[]).map((t) => (t === 'integer' ? 'number' : t)));
  }
  return undefined;
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

/** The literal values a schema allows (enum, const, or a union of them); else undefined. */
function valuesOf(s: Schema | undefined): Set<unknown> | undefined {
  if (!s) return undefined;
  if ('const' in s) return new Set([s.const]);
  if (Array.isArray(s.enum)) return new Set(s.enum as unknown[]);
  const variants = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (!variants) return undefined;
  const out = new Set<unknown>();
  for (const v of variants) {
    const vals = valuesOf(v);
    if (!vals) return undefined;
    vals.forEach((x) => out.add(x));
  }
  return out;
}

/** The one object (or array) variant of a schema, for looking inside a nullable union. */
function variant(s: Schema | undefined, type: 'object' | 'array'): Schema | undefined {
  if (!s) return undefined;
  if (s.type === type || (type === 'object' && s.properties)) return s;
  const vs = ((s.anyOf ?? s.oneOf) as Schema[] | undefined)?.filter(
    (v) => v.type === type || (type === 'object' && v.properties),
  );
  return vs?.length === 1 ? vs[0] : undefined;
}

const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every((x) => b.has(x));

/** What a client reads: the new schema may only promise as much or more. */
function compareRead(old: Schema | undefined, next: Schema | undefined, at: string, out: string[]) {
  if (!old) return;
  if (!next) return void out.push(`${at}: no longer documented`);
  const [ot, nt] = [typesOf(old), typesOf(next)];
  if (ot && (!nt || !subset(nt, ot))) {
    out.push(`${at}: type ${[...ot].join('|')} became ${nt ? [...nt].join('|') : 'any'}`);
    return;
  }
  const [oo, no] = [variant(old, 'object'), variant(next, 'object')];
  if (oo && no) {
    const oldProps = (oo.properties ?? {}) as Record<string, Schema>;
    const newProps = (no.properties ?? {}) as Record<string, Schema>;
    const oldReq = new Set((oo.required ?? []) as string[]);
    const newReq = new Set((no.required ?? []) as string[]);
    for (const [name, schema] of Object.entries(oldProps)) {
      if (!(name in newProps)) out.push(`${at}.${name}: removed`);
      else {
        if (oldReq.has(name) && !newReq.has(name)) out.push(`${at}.${name}: no longer always sent`);
        compareRead(schema, newProps[name], `${at}.${name}`, out);
      }
    }
  }
  const [oa, na] = [variant(old, 'array'), variant(next, 'array')];
  if (oa && na) compareRead(oa.items as Schema, na.items as Schema, `${at}[]`, out);
}

/** What a client sends: the new schema must accept everything the old one did. */
function compareWrite(
  old: Schema | undefined,
  next: Schema | undefined,
  at: string,
  out: string[],
) {
  if (!old || !next) return;
  const [ot, nt] = [typesOf(old), typesOf(next)];
  if (nt && (!ot || !subset(ot, nt))) {
    out.push(`${at}: accepts ${[...nt].join('|')}, was ${ot ? [...ot].join('|') : 'any'}`);
    return;
  }
  const [ov, nv] = [valuesOf(old), valuesOf(next)];
  if (nv && (!ov || !subset(ov, nv))) out.push(`${at}: no longer accepts every value it did`);
  for (const [key, tighter] of [
    ['minimum', (a: number, b: number) => b > a],
    ['maximum', (a: number, b: number) => b < a],
    ['minLength', (a: number, b: number) => b > a],
    ['maxLength', (a: number, b: number) => b < a],
    ['maxItems', (a: number, b: number) => b < a],
  ] as const) {
    const [a, b] = [old[key], next[key]];
    if (typeof b === 'number' && (typeof a !== 'number' || tighter(a, b))) {
      out.push(`${at}: ${key} ${String(a ?? 'none')} became ${b}`);
    }
  }
  const [oo, no] = [variant(old, 'object'), variant(next, 'object')];
  if (oo && no) {
    const oldProps = (oo.properties ?? {}) as Record<string, Schema>;
    const newProps = (no.properties ?? {}) as Record<string, Schema>;
    const oldReq = new Set((oo.required ?? []) as string[]);
    for (const name of (no.required ?? []) as string[]) {
      if (!oldReq.has(name)) out.push(`${at}.${name}: newly required`);
    }
    for (const [name, schema] of Object.entries(oldProps)) {
      if (!(name in newProps)) {
        if (no.additionalProperties === false) out.push(`${at}.${name}: no longer accepted`);
      } else compareWrite(schema, newProps[name], `${at}.${name}`, out);
    }
  }
}

const jsonSchema = (c?: Record<string, { schema?: Schema }>) => c?.['application/json']?.schema;

/** Every breaking change from `old` to `next`, one line each; empty when there is none. */
export function breakingChanges(old: Spec, next: Spec): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(old.paths ?? {})) {
    for (const method of METHODS) {
      const o = item[method];
      if (!o) continue;
      const at = `${method.toUpperCase()} ${path}`;
      const n = next.paths?.[path]?.[method];
      if (!n) {
        out.push(`${at}: removed`);
        continue;
      }
      const key = (p: { name: string; in: string }) => `${p.in}:${p.name}`;
      const oldParams = new Map((o.parameters ?? []).map((p) => [key(p), p]));
      for (const p of n.parameters ?? []) {
        const before = oldParams.get(key(p));
        if (!before) {
          if (p.required) out.push(`${at}: new required ${p.in} parameter ${p.name}`);
        } else {
          if (p.required && !before.required)
            out.push(`${at}: ${p.in} parameter ${p.name} now required`);
          compareWrite(before.schema, p.schema, `${at} ${p.in} ${p.name}`, out);
        }
      }
      for (const [k, p] of oldParams) {
        if (!(n.parameters ?? []).some((q) => key(q) === k)) {
          out.push(`${at}: ${p.in} parameter ${p.name} removed`);
        }
      }
      if (n.requestBody?.required && !o.requestBody) out.push(`${at}: a body is now required`);
      compareWrite(
        jsonSchema(o.requestBody?.content),
        jsonSchema(n.requestBody?.content),
        `${at} body`,
        out,
      );
      for (const [status, res] of Object.entries(o.responses ?? {})) {
        if (!status.startsWith('2')) continue;
        compareRead(
          jsonSchema(res.content),
          jsonSchema(n.responses?.[status]?.content),
          `${at} ${status}`,
          out,
        );
      }
    }
  }
  return out;
}
