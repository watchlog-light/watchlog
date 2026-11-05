// SPDX-License-Identifier: AGPL-3.0-only
// Client-side filtering for the Docker lists: case-insensitive text terms (all must
// match some field) combined with container status chips (any selected chip matches).
import type { DockerContainer, DockerHost } from '@watchlog/api-types';

export const CONTAINER_STATUSES = ['running', 'stopped', 'unhealthy', 'restarting'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

const STOPPED_STATES = new Set(['exited', 'dead', 'created']);

/** Splits a query into lower-case terms; "demo web" matches containers with both. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesTerms(fields: (string | null | undefined)[], terms: string[]): boolean {
  const haystack = fields.filter(Boolean).map((f) => f!.toLowerCase());
  return terms.every((t) => haystack.some((f) => f.includes(t)));
}

export function hasStatus(c: DockerContainer, status: ContainerStatus): boolean {
  switch (status) {
    case 'running':
      return c.state === 'running';
    case 'stopped':
      return STOPPED_STATES.has(c.state);
    case 'unhealthy':
      return c.health === 'unhealthy';
    case 'restarting':
      return c.state === 'restarting';
  }
}

/** Exact host / Compose project selections from the top bar; empty means all. */
export interface Scope {
  host?: string;
  project?: string;
}

export function filterContainers(
  containers: DockerContainer[],
  terms: string[],
  statuses: ContainerStatus[],
  scope: Scope = {},
): DockerContainer[] {
  return containers.filter(
    (c) =>
      (!scope.host || c.host === scope.host) &&
      (!scope.project || c.composeProject === scope.project) &&
      (statuses.length === 0 || statuses.some((s) => hasStatus(c, s))) &&
      matchesTerms([c.name, c.image, c.composeProject, c.composeService, c.host], terms),
  );
}

export function filterHosts(hosts: DockerHost[], terms: string[], scope: Scope = {}): DockerHost[] {
  return hosts.filter(
    (h) =>
      (!scope.host || h.name === scope.host) &&
      matchesTerms([h.name, h.os, h.dockerVersion], terms),
  );
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/** Splits text into matched and unmatched segments for highlighting (no HTML). */
export function highlightSegments(text: string, terms: string[]): TextSegment[] {
  if (terms.length === 0 || text === '') return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      marked.fill(true, i, i + term.length);
    }
  }
  const segments: TextSegment[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = segments.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else segments.push({ text: text[i]!, match: marked[i]! });
  }
  return segments;
}

/** Parses `?status=running,unhealthy`, ignoring unknown values. */
export function parseStatuses(value: unknown): ContainerStatus[] {
  const raw = (Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '')
    .split(',')
    .filter(Boolean);
  return CONTAINER_STATUSES.filter((s) => raw.includes(s));
}
