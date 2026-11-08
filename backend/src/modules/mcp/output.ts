// SPDX-License-Identifier: AGPL-3.0-only
// What every MCP tool returns (ADR-128, ADR-129): compact JSON, at most 16 KB and a fixed
// number of list items, with a hint when it was cut.
//
// Cluster-controlled text (names, messages, labels, images) is data, never instructions
// (ADR-129). It only ever appears in its own field, passed through `name`, `message`,
// `label` or `text` here: control and invisible characters are removed, line breaks become
// spaces, and the length is capped with an ellipsis. WatchLog's own sentences (reasons,
// summaries, hints, errors) never contain such text; they refer to "this pod" and the
// name sits beside them in a field.

/** The most a tool result may weigh, in UTF-8 bytes (about 4k tokens). */
export const MAX_OUTPUT_BYTES = 16 * 1024;

// C0 and C1 controls, zero-width and bidirectional formatting characters, the BOM.
// Tab, line feed and carriage return are replaced with a space instead.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const BREAKS = /[\t\n\r\u2028\u2029]+/g;

/** Cluster-supplied text as a data value: cleaned and capped at `max` characters. */
export function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(INVISIBLE, '').replace(BREAKS, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

/** A Kubernetes or Docker name: at most 253 characters (a DNS name's limit). */
export const name = (v: unknown) => text(v, 253);
/** An event message, a status message or a reason line: at most 512 characters. */
export const message = (v: unknown) => text(v, 512);
/** A label value: at most 63 characters (Kubernetes' limit). */
export const label = (v: unknown) => text(v, 63);

/** Labels as data: keys and values cleaned and capped, at most `max` of them. */
export function labels(record: Record<string, unknown> | null | undefined, max = 20) {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, max)
      .map(([k, v]) => [text(k, 63) ?? '', label(v)]),
  );
}

/** A failure the assistant can act on: WatchLog's sentence, a hint, and data beside them. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** Data fields (cluster-supplied values go here, never in the sentences). */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A list in a tool's answer, and how to narrow it when it is cut. */
export interface ToolList {
  /** The field it goes in, e.g. "problems". */
  key: string;
  items: unknown[];
  /** How many there are in all, before any cap. */
  total: number;
  /** The plural noun for the hint, e.g. "problems". */
  noun: string;
  /** WatchLog's sentence saying which argument narrows it, e.g. "Pass `namespace`…". */
  narrow: string;
}

export interface ToolAnswer {
  body: Record<string, unknown>;
  list?: ToolList;
}

export interface ToolResult {
  json: string;
  truncated: boolean;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * The answer as compact JSON within MAX_OUTPUT_BYTES. Its list is cut from the end when it
 * is over its cap or the size, with `truncated`, how many are shown, how many there are,
 * and a hint naming the argument that narrows it.
 */
export function finish(answer: ToolAnswer): ToolResult {
  const list = answer.list;
  if (!list) {
    const json = JSON.stringify(answer.body);
    if (bytes(json) > MAX_OUTPUT_BYTES) throw new Error('tool answer over the size limit');
    return { json, truncated: false };
  }
  const build = (n: number) => {
    const shown = list.items.slice(0, n);
    const cut = n < list.total;
    return JSON.stringify({
      ...answer.body,
      [list.key]: shown,
      ...(cut
        ? {
            truncated: true,
            shown: shown.length,
            total: list.total,
            hint: `Truncated to ${shown.length} ${list.noun} of ${list.total}. ${list.narrow}`,
          }
        : {}),
    });
  };
  let n = list.items.length;
  let json = build(n);
  while (bytes(json) > MAX_OUTPUT_BYTES && n > 0) {
    n = Math.max(0, n - Math.max(1, Math.ceil(n / 10)));
    json = build(n);
  }
  if (bytes(json) > MAX_OUTPUT_BYTES) throw new Error('tool answer over the size limit');
  return { json, truncated: n < list.total };
}

/** The JSON of a ToolError, for an `isError` result. */
export function errorJson(err: ToolError): string {
  return JSON.stringify({
    error: err.message,
    ...(err.hint ? { hint: err.hint } : {}),
    ...err.data,
  });
}
