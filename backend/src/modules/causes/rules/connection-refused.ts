// SPDX-License-Identifier: AGPL-3.0-only
// connection_refused (ADR-150 #9): the dependency's port refuses connections. At the far end
// of an edge the walk followed (`ev.via`), whose connects fail, while the dependency itself
// runs: Kubernetes, the workload has ready pods; Docker, its containers run. Then nothing
// accepts connections on that port (a wrong port, a listener on another address, a process
// that hasn't opened it). A dependency with nothing ready is dependency_down's.
//
// The agent counts a connect that ends without being established (SYN_SENT → CLOSE): a
// refusal (RST) or a timeout, which it doesn't tell apart. The words say "fail", and the
// chain is partial while some connects still succeed (a flapping pod rather than no listener).
import { EDGE_FAILED_RATIO } from '../checks.js';
import type { Evidence } from '../evidence.js';
import { workloadObject } from '../resolve.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { shortName } from '../checks.js';
import { containerRef } from './common.js';

/** From this share of failed connects, nothing listens (below it, some connects get through). */
export const REFUSED_RATIO = 0.5;

export const connectionRefused: Rule = {
  code: 'connection_refused',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['workload', 'container', 'compose_service'].includes(f.kind),
  match(ev: Evidence): Match | null {
    const via = ev.via;
    if (!via) return null;
    const e = via.edge;
    const ratio = e.failedRatio ?? 0;
    if (ratio < EDGE_FAILED_RATIO || (e.failedLastMinute ?? 1) <= 0) return null;
    let object: Step['object'];
    let facts: Step['facts'];
    if (ev.platform === 'kubernetes') {
      const w = ev.workload;
      if (!w || !w.ready) return null;
      object = workloadObject(w.namespace, w.kind, w.name);
      facts = { port: e.port, ready: w.ready, n: w.desired ?? w.ready };
    } else {
      const running = ev.containers.filter((c) => c.state === 'running');
      if (!running.length) return null;
      object = containerRef(running[0]!);
      facts = { port: e.port };
    }
    const name = via.from;
    const target = shortName(ev);
    const since = via.history?.troubleSince ?? null;
    return {
      code: 'connection_refused',
      facts: { name, target, port: e.port, pct: Math.round(ratio * 1000) / 10 },
      since,
      chain: [
        {
          object,
          source: ev.platform === 'docker' ? 'docker' : 'kubernetes',
          code: ev.platform === 'docker' ? 'no_listener_running' : 'no_listener_ready',
          facts,
          at: null,
          since,
          next: null,
        },
      ],
      complete: ratio >= REFUSED_RATIO,
      headline:
        e.port === null
          ? { code: 'connection_refused_noport', facts: { name, target } }
          : { code: 'connection_refused', facts: { name, target, port: e.port } },
    };
  },
  explains: ['dependencies'],
};
