// SPDX-License-Identifier: AGPL-3.0-only
// certificate_bad (0.10.0, ADR-225): at the far end of a failing edge or one answering 5xx,
// the certificate served on that port has expired, or doesn't cover a name it is served for.
// Its callers' TLS handshakes fail there, so it explains their failed connects and errors:
// "web calls api → api's certificate for api.shop.test expired 2 days ago". The certificate
// read is the cluster's (GET /clusters/:id/certificates), matched to the edge's Service and
// port (Kubernetes) or to the port on the target's server (Servers).
import { EDGE_FAILED_RATIO, shortName } from '../checks.js';
import type { EvCertificate, Evidence } from '../evidence.js';
import { workloadObject } from '../resolve.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { containerRef } from './common.js';

/** The share of 5xx answers from which an edge counts as answering errors. */
const ERROR_RATIO = 0.05;

const bad = (c: EvCertificate) => c.status === 'expired' || c.nameMismatch.length > 0;

export const certificateBad: Rule = {
  code: 'certificate_bad',
  platforms: ['kubernetes', 'server'],
  applies: (f) => ['workload', 'container', 'compose_service'].includes(f.kind),
  match(ev: Evidence): Match | null {
    const via = ev.via;
    if (!via) return null;
    const e = via.edge;
    const failing =
      (e.failedRatio ?? 0) >= EDGE_FAILED_RATIO ||
      (e.http?.serverErrorRatio ?? 0) >= ERROR_RATIO ||
      e.health === 'failing';
    if (!failing) return null;
    const cert = (ev.certificates ?? []).find(bad);
    if (!cert) return null;
    let object: Step['object'];
    if (ev.platform === 'kubernetes') {
      const w = ev.workload;
      if (!w) return null;
      object = workloadObject(w.namespace, w.kind, w.name);
    } else {
      const c = ev.containers[0];
      if (!c) return null;
      object = containerRef(c);
    }
    const expired = cert.status === 'expired';
    const name = via.from;
    const target = shortName(ev);
    const certName = cert.names[0] ?? '';
    // An expired certificate began failing when it expired; a wrong one when it was first seen.
    const since = expired
      ? new Date(cert.notAfter * 1000).toISOString()
      : cert.firstSeen
        ? new Date(cert.firstSeen * 1000).toISOString()
        : null;
    const days = Math.abs(cert.daysLeft);
    return {
      code: 'certificate_bad',
      facts: { name, target, cert: certName, port: e.port },
      since,
      chain: [
        {
          object,
          source: ev.platform === 'server' ? 'docker' : 'kubernetes',
          code: expired ? 'cert_expired' : 'cert_name_mismatch',
          facts: expired
            ? { cert: certName, n: days, port: e.port }
            : { cert: certName, asked: cert.nameMismatch[0] ?? '', port: e.port },
          at: null,
          since,
          next: null,
        },
      ],
      complete: true,
      headline: expired
        ? { code: 'certificate_expired', facts: { name, target, cert: certName, n: days } }
        : {
            code: 'certificate_mismatch',
            facts: { name, target, cert: certName, asked: cert.nameMismatch[0] ?? '' },
          },
      // Failed handshakes are what the far end's failed connects are.
      covers: ['connection_refused'],
    };
  },
  explains: ['dependencies'],
};
