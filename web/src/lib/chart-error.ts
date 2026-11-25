// SPDX-License-Identifier: AGPL-3.0-only
// What a chart says when its request fails (0.17.1): a refusal that explains itself (a 4xx
// problem with a `detail`, such as the demo's "The demo shows at most the last 24 hours.") is
// shown as it is, with no Retry, since asking again gets the same answer; a server error (5xx) or
// a network error keeps the chart's own words and Retry.
import { ApiError } from '@/api/client';

export interface ChartFailure {
  /** The server's words, or null for the chart's own message. */
  text: string | null;
  retry: boolean;
}

export function chartFailure(err: unknown): ChartFailure {
  if (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408 &&
    err.status !== 429 &&
    err.problem?.detail
  )
    return { text: err.problem.detail, retry: false };
  return { text: null, retry: true };
}
