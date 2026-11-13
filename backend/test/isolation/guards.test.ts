// SPDX-License-Identifier: AGPL-3.0-only
// The two escape hatches of tenancy stay where ADR-174 allows them (ADR-182):
//   - systemDb, the owner's connection that Row-Level Security doesn't apply to, is used
//     only for what runs before the org is known or across orgs;
//   - authorisedScope makes a VictoriaMetrics scope without clusterForOrg, only where the
//     cluster comes from a cluster token or from the org's own rows.
// A new file using either fails here until it is reviewed and added with its reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const SYSTEM_DB: Record<string, string> = {
  'app.ts': 'wiring: hands systemDb to the modules below only',
  'server.ts': 'wiring: setup, secret key check, demo user, bootstrap cluster, seed',
  'alert-worker.ts': 'wiring: the worker lists orgs and runs the outbox and token jobs',
  'modules/alerts/worker.ts': 'lists the orgs and prunes history across them',
  'modules/auth/routes.ts': 'sign-in, before the org is known',
  'modules/accounts/routes.ts':
    "Cloud accounts: signup, OAuth, 2FA, the user's sessions and orgs, joining from an invite",
  'modules/accounts/service.ts': 'Cloud signup creates the user and their org',
  'modules/cloud/routes.ts': 'wiring: hands systemDb to the Cloud account routes',
  'modules/demo/routes.ts': 'the demo sign-in, before the org is known',
  'modules/entitlements/limit-mail.ts':
    "the worker's plan-limit emails: the day's hits across orgs, each org's Owners",
  'modules/entitlements/node-gate.ts':
    "ingest's node limit: each org's recent agents, read before a request's org is bound to a query",
  'modules/entitlements/service.ts':
    'the entitlements cache, read across orgs by ingest and the metrics tiers; the internal API writes it',
  'modules/entitlements/usage.ts':
    "the usage job lists the orgs with agents in the hour; each org's row is written withOrg",
  'modules/funnel/day7.ts':
    "the worker's day7_active job lists clusters across orgs; each event is written withOrg",
  'modules/internal/admin.ts':
    "the Cloud admin's API (staff): any org's row, members, usage, funnel and support sessions",
  'modules/lifecycle/job.ts':
    "the worker's lifecycle emails list Owners across orgs; each record is written withOrg",
  'modules/lifecycle/unsubscribe.ts': 'the unsubscribe link names a user (global), signed out',
  'modules/support/routes.ts':
    'entering support mode: the one-time code names the session, before the org',
  'modules/support/service.ts':
    "support sessions: the cookie's lookup before the org, and the records a read-only request can't write itself",
  'plugins/support.ts': "support mode's cookie lookup and the records of what it opened",
  'modules/internal/app.ts':
    "the internal API (billing, staff): any org's entitlements and usage, behind its own token",
  'modules/onboarding/cloud-routes.ts':
    'Cloud /install.yaml: the install code names its cluster, before the org is known',
  'modules/onboarding/install-codes.ts': 'resolves an install code, before the org is known',
  'modules/setup/routes.ts': 'first-run setup, before any org exists',
  'modules/users/routes.ts': 'invite and password-reset links, signed out',
  'plugins/api-token.ts': 'the API token lookup',
  'plugins/auth.ts': 'the session lookup',
  'plugins/demo.ts': 'the demo session lookup',
  'plugins/service-identity.ts': "the alert worker's in-process reads name their org",
};

const AUTHORISED_SCOPE: Record<string, string> = {
  'lib/victoria.ts': 'defines it',
  'modules/clusters/service.ts': 'clusterForOrg, the guard itself',
  'modules/ingest/routes.ts': 'the cluster comes from the cluster token (ADR-026)',
  'modules/alerts/metric-rules.ts': "the alert worker's rules, read under withOrg",
  'modules/alerts/routes.ts': "the org's clusters, read with its filter",
  'modules/alerts/rule-charts.ts': "charts of the org's own alerts and rules",
  'modules/integrations/discovery.ts': "the org's clusters, read with its filter",
  'modules/integrations/routes.ts': "services read with the org's filter (composite key)",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

/** Files whose code (not comments) names the identifier. */
function users(identifier: string): string[] {
  const re = new RegExp(`\\b${identifier}\\b`);
  return sources(SRC)
    .filter((f) => {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return re.test(code);
    })
    .map((f) => relative(SRC, f))
    .sort();
}

describe('tenancy escape hatches (ADR-174)', () => {
  it('systemDb is used only by the allow-listed files', () => {
    expect(users('systemDb')).toEqual(Object.keys(SYSTEM_DB).sort());
  });

  it('the wiring never hands systemDb to a module as its `db`', () => {
    for (const f of ['app.ts', 'server.ts']) {
      const code = readFileSync(join(SRC, f), 'utf8');
      expect(code, f).not.toMatch(/\bdb:\s*(deps\.)?systemDb\b/);
    }
  });

  it('authorisedScope is used only by the allow-listed files', () => {
    expect(users('authorisedScope')).toEqual(Object.keys(AUTHORISED_SCOPE).sort());
  });
});
