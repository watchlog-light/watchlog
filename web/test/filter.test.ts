// SPDX-License-Identifier: AGPL-3.0-only
import type { DockerContainer, DockerHost } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import {
  filterContainers,
  filterHosts,
  highlightSegments,
  parseStatuses,
  searchTerms,
} from '@/lib/filter';

const c = (name: string, extra: Partial<DockerContainer> = {}) =>
  ({
    name,
    host: 'lima-watchlog-test',
    image: 'redis:7-alpine',
    state: 'running',
    health: null,
    composeProject: null,
    composeService: null,
    ...extra,
  }) as DockerContainer;

const CONTAINERS = [
  c('demo-cache-1', { composeProject: 'demo', composeService: 'cache' }),
  c('demo-web-1', { image: 'nginx:1.29-alpine', composeProject: 'demo', composeService: 'web' }),
  c('fx-crashloop', { image: 'busybox:1.37', state: 'restarting' }),
  c('fx-unhealthy', { image: 'busybox:1.37', health: 'unhealthy' }),
  c('fx-exited', { image: 'busybox:1.37', state: 'exited', host: 'edge-2' }),
];
const names = (list: DockerContainer[]) => list.map((x) => x.name);
const find = (q: string, statuses: Parameters<typeof filterContainers>[2] = []) =>
  names(filterContainers(CONTAINERS, searchTerms(q), statuses));

describe('container filter', () => {
  it('matches name, image, Compose project/service and host, case-insensitively', () => {
    expect(find('CRASH')).toEqual(['fx-crashloop']);
    expect(find('nginx')).toEqual(['demo-web-1']);
    expect(find('demo')).toEqual(['demo-cache-1', 'demo-web-1']);
    expect(find('cache')).toEqual(['demo-cache-1']);
    expect(find('edge-2')).toEqual(['fx-exited']);
    expect(find('')).toHaveLength(5);
  });

  it('requires every term to match some field', () => {
    expect(find('demo web')).toEqual(['demo-web-1']);
    expect(find('busybox lima')).toEqual(['fx-crashloop', 'fx-unhealthy']);
    expect(find('demo busybox')).toEqual([]);
  });

  it('combines status chips (any of them) with the text search (all of it)', () => {
    expect(find('', ['running'])).toEqual(['demo-cache-1', 'demo-web-1', 'fx-unhealthy']);
    expect(find('', ['stopped'])).toEqual(['fx-exited']);
    expect(find('', ['unhealthy', 'restarting'])).toEqual(['fx-crashloop', 'fx-unhealthy']);
    expect(find('demo', ['unhealthy'])).toEqual([]);
    expect(find('fx', ['running'])).toEqual(['fx-unhealthy']);
  });

  it('parses the status query and drops unknown values', () => {
    expect(parseStatuses('unhealthy,bogus,running')).toEqual(['running', 'unhealthy']);
    expect(parseStatuses(['stopped', 'restarting'])).toEqual(['stopped', 'restarting']);
    expect(parseStatuses(undefined)).toEqual([]);
  });
});

describe('host filter and highlighting', () => {
  const HOSTS = [
    { name: 'lima-watchlog-test', os: 'linux', dockerVersion: '29.9.2' },
    { name: 'edge-2', os: 'linux', dockerVersion: '27.5.1' },
  ] as DockerHost[];

  it('matches hostname, OS and Docker version', () => {
    const hosts = (q: string) => filterHosts(HOSTS, searchTerms(q)).map((h) => h.name);
    expect(hosts('EDGE')).toEqual(['edge-2']);
    expect(hosts('linux')).toHaveLength(2);
    expect(hosts('29.9')).toEqual(['lima-watchlog-test']);
    expect(hosts('windows')).toEqual([]);
  });

  it('splits text into matched segments, merging overlaps', () => {
    expect(highlightSegments('demo-web-1', ['WEB'.toLowerCase()])).toEqual([
      { text: 'demo-', match: false },
      { text: 'web', match: true },
      { text: '-1', match: false },
    ]);
    expect(highlightSegments('aaa', ['aa'])).toEqual([{ text: 'aaa', match: true }]);
    expect(highlightSegments('demo-web-1', [])).toEqual([{ text: 'demo-web-1', match: false }]);
  });
});
