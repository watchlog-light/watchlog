// SPDX-License-Identifier: AGPL-3.0-only
// The Containers page's rules (Docker parity of the Workloads page): rows grouped by
// Compose project (standalone containers in a group of their own), WatchLog's own
// containers hidden by default, a Failing filter on top of the state chips.
import type { DockerContainer } from '@watchlog/api-types';
import { filterContainers, type ContainerStatus, type Scope } from './filter';

/** The group of containers without a Compose project. */
export const STANDALONE = '';

export type ContainerRow = DockerContainer & { namespace: string; key: string };

export const containerRows = (cs: DockerContainer[]): ContainerRow[] =>
  cs.map((c) => ({ ...c, namespace: c.composeProject ?? STANDALONE, key: `${c.host}/${c.name}` }));

export interface ContainerFilter {
  terms: string[];
  statuses: ContainerStatus[];
  scope: Scope;
  failing: boolean;
  hideOwn: boolean;
}

export function filterContainerRows(rows: ContainerRow[], f: ContainerFilter): ContainerRow[] {
  const keep = new Set(filterContainers(rows, f.terms, f.statuses, f.scope));
  return rows.filter(
    (r) => keep.has(r) && (!f.failing || !!r.problem) && (!f.hideOwn || !r.watchlog),
  );
}

/** Running and stopped containers are fine; a problem gets a badge. */
export const isRunning = (c: Pick<DockerContainer, 'state'>) =>
  c.state === 'running' || c.state === 'restarting';
