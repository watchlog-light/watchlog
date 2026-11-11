// SPDX-License-Identifier: AGPL-3.0-only
// Containers stopped by their host's reboot or their Docker daemon's restart (ADR-159), from
// the times measured on the e2e Docker host on 2026-11-11.
import { describe, expect, it } from 'vitest';
import type { QuerySeries } from '../src/lib/victoria.js';
import {
  BOOT_QUERY,
  downQuery,
  hostBoots,
  stoppedWithHost,
} from '../src/modules/docker/host-restart.js';
import { dockerProblem, dockerProblems } from '../src/modules/overview/docker-problems.js';

const s = (iso: string) => Date.parse(iso) / 1000;
const row = (name: string, st: Record<string, unknown>, node = 'docker-01') => ({
  node,
  name,
  status_summary: st,
});
const exited = (code: number, finished: string) => ({
  state: 'exited',
  exit_code: code,
  finished_at: finished,
});

// A clean reboot: the agent's last report 08:41:13, the containers stopped 08:41:24–34 as
// the host shut down, the host booted 08:50:31.
const CLEAN = { bootAt: s('2026-11-11T08:50:31Z'), downAt: s('2026-11-11T08:41:13Z') };
// A hard reboot: the daemon marked the containers 255 six seconds after the boot.
const HARD = { bootAt: s('2026-11-10T07:03:31Z'), downAt: null };

describe('stoppedWithHost', () => {
  it('a clean reboot: the containers that stopped as the host went down', () => {
    const got = stoppedWithHost(
      [
        row('storefront-orders-1', exited(130, '2026-11-11T08:41:26Z')),
        row('storefront-probe-1', exited(137, '2026-11-11T08:41:34Z')),
        // Started again by its policy after the boot, then gave up (its broker hadn't come
        // back): its own failure, measured on rabbitmq-e2e's publisher.
        row('rabbitmq-e2e-publisher-1', exited(1, '2026-11-11T08:52:10Z')),
        // Crashed an hour before the shutdown: its own exit.
        row('fx-exited', exited(1, '2026-11-11T07:40:00Z')),
        // Running: no finish time, no judgement.
        row('causes-e2e-web-1', { state: 'running', exit_code: 0 }),
      ],
      new Map([['docker-01', CLEAN]]),
    );
    expect([...got.keys()]).toEqual([
      'docker-01\u0000storefront-orders-1',
      'docker-01\u0000storefront-probe-1',
    ]);
    expect(got.get('docker-01\u0000storefront-orders-1')).toEqual({
      how: 'host',
      at: '2026-11-11T08:50:31.000Z',
    });
  });

  it('a hard reboot with no report before it: only the daemon’s exit-255 marks after the boot', () => {
    const got = stoppedWithHost(
      [
        row('nginx-e2e-bare-1', exited(255, '2026-11-10T07:03:37.577Z')),
        // Exit 1 just after the boot: a crash, not the daemon's mark.
        row('early', exited(1, '2026-11-10T07:03:40Z')),
        // 255 long after the boot, alone: the process's own exit(-1).
        row('late', exited(255, '2026-11-10T09:00:00Z')),
      ],
      new Map([['docker-01', HARD]]),
    );
    expect([...got.keys()]).toEqual(['docker-01\u0000nginx-e2e-bare-1']);
  });

  it('a killed daemon without a reboot: exit-255 marks on three containers within seconds', () => {
    const t = '2026-11-11T10:00:0';
    const rows = [
      row('a', exited(255, `${t}1Z`)),
      row('b', exited(255, `${t}2Z`)),
      row('c', exited(255, `${t}4Z`)),
      row('other-host', exited(255, `${t}1Z`), 'docker-02'),
    ];
    const got = stoppedWithHost(rows, new Map());
    expect(got.get('docker-01\u0000a')).toEqual({ how: 'docker', at: '2026-11-11T10:00:01.000Z' });
    expect(got.size).toBe(3);
    // Two alone are not enough to tell from a coincidence.
    expect(stoppedWithHost(rows.slice(0, 2), new Map()).size).toBe(0);
  });
});

describe('hostBoots', () => {
  it('reads the boot, then the last report before it; old boots are left out', async () => {
    const now = s('2026-11-11T09:00:00Z');
    const asked: string[] = [];
    const query = (expr: string): Promise<QuerySeries[]> => {
      asked.push(expr);
      if (expr === BOOT_QUERY)
        return Promise.resolve([
          { labels: { host: 'docker-01' }, points: [[now, CLEAN.bootAt]] },
          { labels: { host: 'docker-02' }, points: [[now, now - 3 * 86400]] },
        ]);
      return Promise.resolve([{ labels: {}, points: [[now, CLEAN.downAt]] }]);
    };
    const boots = await hostBoots(query, now);
    expect(boots).toEqual(new Map([['docker-01', CLEAN]]));
    expect(asked).toEqual([BOOT_QUERY, downQuery('docker-01', CLEAN.bootAt, now)]);
    expect(downQuery('docker-01', CLEAN.bootAt, now)).toBe(
      'max(tlast_over_time(watchlog_node_boot_time_seconds{host="docker-01"}[1d] offset 574s))',
    );
  });
});

describe('a stopped container its host’s reboot left stopped', () => {
  const now = Date.parse('2026-11-11T09:05:00Z');
  const st = exited(130, '2026-11-11T08:41:26Z');
  const withHost = { how: 'host' as const, at: '2026-11-11T08:50:31.000Z' };

  it('is no problem: its restart policy left it stopped', () => {
    expect(dockerProblem(st, now)?.ruleKey).toBe('docker.container.exited');
    expect(dockerProblem(st, now, null, withHost)).toBeNull();
    const rows = [
      { node: 'docker-01', name: 'storefront-orders-1', spec_summary: {}, status_summary: st },
    ];
    expect(dockerProblems(rows, [], 'fleet', now)).toHaveLength(1);
    expect(
      dockerProblems(
        rows,
        [],
        'fleet',
        now,
        undefined,
        undefined,
        new Map([['docker-01\u0000storefront-orders-1', withHost]]),
      ),
    ).toHaveLength(0);
  });
});
