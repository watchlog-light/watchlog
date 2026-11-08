// SPDX-License-Identifier: AGPL-3.0-only
// MCP tools read through the public REST API in-process, as the same API token
// (lib/internal-call.ts). A tool therefore sees exactly what the token sees through the
// API, with its org, its scope (public routes only), demo mode's limits and the API's
// redaction; nothing more.
import type { FastifyInstance } from 'fastify';
import { internalCallHeaders } from '../../lib/internal-call.js';

export class ApiReadError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${status}: ${detail}`);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiReader {
  constructor(
    private readonly app: FastifyInstance,
    /** The /mcp request's Authorization header: the same token. */
    private readonly authorization: string,
  ) {}

  /** A read sent as POST (the chart query, ADR-125). */
  async post<T>(path: string, body: object): Promise<T> {
    const res = await this.app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: { ...internalCallHeaders(this.authorization), 'content-type': 'application/json' },
      payload: body,
    });
    return this.answer<T>(res);
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    const res = await this.app.inject({
      method: 'GET',
      url: `/api/v1${path}${qs ? `?${qs}` : ''}`,
      headers: internalCallHeaders(this.authorization),
    });
    return this.answer<T>(res);
  }

  private answer<T>(res: Awaited<ReturnType<FastifyInstance['inject']>>): T {
    if (res.statusCode !== 200) {
      let detail = res.statusMessage;
      try {
        detail = (res.json() as { detail?: string }).detail ?? detail;
      } catch {
        // Not JSON: keep the status text.
      }
      throw new ApiReadError(res.statusCode, detail);
    }
    return res.json() as T;
  }
}
