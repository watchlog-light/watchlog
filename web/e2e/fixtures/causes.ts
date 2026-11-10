// SPDX-License-Identifier: AGPL-3.0-only
// GET /causes answers for the responsive suite (v0.4 slice 6): the probable-cause panel in
// each state on every page it sits on, whatever the cluster shows at that moment. The
// answers are the kind and Docker e2e recordings replayed (web/test/fixtures/causes/), and
// the states the engine gives from them: possible only, no clear cause, network flows
// off, and a resolved alert.
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown> & {
  cluster: { id: string; name: string; kind: string };
  subject: { kind: string; ref: string; name: string; platform: string };
  causes: { strength: string }[];
  checks: { topic: string; code: string; result: string }[];
};

const load = (name: string): Json =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/causes/${name}.json`, import.meta.url), 'utf8'),
  ) as Json;

/** The answer as for another cluster (the one the suite checks). */
const on = (a: Json, cluster: { id: string; name: string }) => ({
  ...a,
  cluster: { ...a.cluster, id: cluster.id, name: cluster.name },
  checkedAt: new Date(Date.now() - 20_000).toISOString(),
});

const asPossible = (a: Json, more: Json) => ({
  ...a,
  state: 'possible',
  headline: { code: 'possible', facts: { name: a.subject.name, n: 2 } },
  causes: [...a.causes, ...more.causes].map((c) => ({ ...c, strength: 'possible' })),
  checks: a.checks.map((c) => (c.result === 'explains' ? { ...c, result: 'possible' } : c)),
});

const asNone = (a: Json) => ({
  ...a,
  state: 'none',
  headline: { code: 'none_found', facts: { name: a.subject.name, n: a.checks.length, found: 1 } },
  causes: [],
  checks: a.checks.map((c) => (c.result === 'explains' ? { ...c, result: 'possible' } : c)),
});

export function causeAnswers(
  kube: { id: string; name: string },
  docker: { id: string; name: string },
) {
  const dep = load('kube-dependency-down');
  const k = (a: Json) => on(a, kube);
  const d = (a: Json) => on(a, docker);
  return {
    likely: k(dep),
    // A second cause, possible, under the likely one.
    also: k({
      ...dep,
      causes: [...dep.causes, ...load('kube-cpu-throttle').causes].map((c, i) =>
        i ? { ...c, strength: 'possible' } : c,
      ),
    }),
    possible: k(asPossible(dep, load('kube-cpu-throttle'))),
    none: k(asNone(dep)),
    flowsOff: k({
      ...asNone(dep),
      headline: { code: 'none_flows_off', facts: { name: dep.subject.name } },
      flowsOff: [{ node: 'kind-worker', cause: 'kernel', reason: 'no BTF' }],
      checks: dep.checks.map((c) =>
        c.topic === 'dependencies' || c.topic === 'dns'
          ? { ...c, code: `${c.topic}_flows_off`, result: 'not_run' }
          : c,
      ),
    }),
    was: k({ ...dep, resolvedAt: new Date(Date.now() - 600_000).toISOString() }),
    pod: k(load('kube-node-drain')),
    rabbit: k(load('kube-rabbit-consumer-oom')),
    dockerDep: d(load('docker-dependency-down')),
    dockerDns: d(load('docker-dns-typo')),
    dockerRabbit: d(load('docker-rabbit-consumer-oom')),
  };
}

/** GET /causes, whatever the subject. */
export const CAUSES_URL = /\/api\/v1\/causes\?/;
