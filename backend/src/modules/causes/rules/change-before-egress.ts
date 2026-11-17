// SPDX-License-Identifier: AGPL-3.0-only
// change_before_egress (ADR-187, the catalog's thirteenth rule), for the egress alerts only: a
// rollout or image change of the source (Kubernetes), or a re-create, new image or Compose
// change (Docker, ADR-149), in the 60 minutes before its first connection to the destination.
// The chain: the first connection, after the change (where it starts). Without such a change
// the answer is "no clear cause" with what was checked.
//
// The alert's subject is the source (egress/rules.ts labels it as a workload, a Compose
// service or a container), so the evidence is the source's own changes; the alert starts at
// the first connection (its `since` is the inventory's first seen).
import { EGRESS_ALERT_KEYS } from '../catalog.js';
import { shortName } from '../checks.js';
import { focusObject } from '../resolve.js';
import type { EvMarker, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import { changeStep, images, SAME_MS, versionChanges } from './common.js';

/** The change must come at most this long before the first connection. */
export const EGRESS_CHANGE_MS = 60 * 60_000;

export const isEgressAlert = (ev: Pick<Evidence, 'alert'>) =>
  !!ev.alert && EGRESS_ALERT_KEYS.has(ev.alert.rule.key ?? '');

/** The headline's facts for the change: which words, and what it changed to. */
function changeFacts(m: EvMarker): { code: string; facts: Record<string, string> } {
  const d = m.details as Record<string, unknown>;
  switch (m.kind) {
    case 'image':
      return { code: 'change_before_egress_image', facts: { image: images(d.to) } };
    case 'rollout':
      return { code: 'change_before_egress_rollout', facts: { to: String(d.to ?? '?') } };
    case 'recreate':
      return {
        code: 'change_before_egress_recreate',
        facts: { image: String(d.image ?? '') || '?' },
      };
    default:
      return {
        code: 'change_before_egress_compose',
        facts: { project: m.target.split('/').slice(-1)[0]! },
      };
  }
}

export const changeBeforeEgress: Rule = {
  code: 'change_before_egress',
  platforms: ['kubernetes', 'server'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match(ev): Match | null {
    if (!isEgressAlert(ev)) return null;
    const alert = ev.alert!;
    const first = Date.parse(alert.startedAt);
    const object = focusObject(ev.focus, ev.platform);
    if (Number.isNaN(first) || !object) return null;
    const marker = versionChanges(ev).find((m) => {
      const t = Date.parse(m.ts);
      return t <= first + SAME_MS && t >= first - EGRESS_CHANGE_MS;
    });
    if (!marker) return null;
    const l = alert.labels;
    const destination =
      l.port && l.port !== '0' ? `${l.destination}:${l.port}` : (l.destination ?? '');
    const name = shortName(ev);
    const minutes = Math.max(0, Math.round((first - Date.parse(marker.ts)) / 60_000));
    const words = changeFacts(marker);
    return {
      code: 'change_before_egress',
      facts: { name, destination, change: marker.kind, target: marker.target, minutes },
      since: marker.ts,
      chain: [
        {
          object,
          source: 'service_map',
          code: 'egress_first_connection',
          facts: { destination },
          at: alert.startedAt,
          since: null,
          next: 'after',
        },
        changeStep(ev, marker),
      ],
      complete: true,
      headline: { code: words.code, facts: { name, n: minutes, ...words.facts } },
    };
  },
  explains: ['changes'],
};
