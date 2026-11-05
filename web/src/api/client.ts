// SPDX-License-Identifier: AGPL-3.0-only
// Minimal JSON client for /api/v1. Errors are RFC 9457 problems (SPEC §8).
import type { Problem } from '@watchlog/api-types';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the backend could not be reached. */
    readonly status: number,
    readonly problem?: Problem,
  ) {
    super(problem?.detail ?? problem?.title ?? (status === 0 ? 'Network error' : `HTTP ${status}`));
  }
}

let unauthorizedHandler: (() => void) | undefined;

/** Called when an authenticated request returns 401 (for example an expired session). */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0);
  }

  const isJson = res.headers.get('content-type')?.includes('json') ?? false;
  const data: unknown = res.status === 204 || !isJson ? undefined : await res.json();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();
    throw new ApiError(res.status, data as Problem | undefined);
  }
  return data as T;
}

/** Machine-readable problem types returned by the backend (RFC 9457 `type`). */
export const ProblemType = {
  clusterLimit: 'urn:watchlog:problem:cluster-limit',
  nameTaken: 'urn:watchlog:problem:name-taken',
  tokenLimit: 'urn:watchlog:problem:token-limit',
  telegramUnreachable: 'urn:watchlog:problem:telegram-unreachable',
} as const;

export function hasProblemType(err: unknown, type: string): boolean {
  return err instanceof ApiError && err.problem?.type === type;
}
