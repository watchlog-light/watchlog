// SPDX-License-Identifier: AGPL-3.0-only
// Every route of the app, classified for the cross-org isolation suite (ADR-182). The suite
// reads Fastify's route table; a route missing here fails it, so each new route is
// classified when it is added. Kinds:
//   - org:          an org's data, behind a session or an API token. Called as org B with
//                   org A's ids it answers 404 (or 403 when the role decides first), and no
//                   answer of B's ever carries A's data.
//   - public:       answers before anyone is signed in (or about the caller only); still
//                   never carries A's data.
//   - installation: the installation's own settings; 404 in Cloud (plugins/edition.ts).
//   - stream:       an event stream (logs follow); org B with A's ids gets 404.
//   - ingest:       a cluster token's; the cluster comes from the token (ingest tests).
//   - mcp:          the MCP endpoint; every tool is called as B (MCP tests).
//   - cloud:        registered only in Cloud (registerCloudOnly); Community answers 404.

export type RouteKind = 'org' | 'public' | 'installation' | 'stream' | 'ingest' | 'mcp' | 'cloud';

export interface RouteClass {
  kind: RouteKind;
  /** Query string for the call (the generated one otherwise). */
  query?: Record<string, string>;
  /** Request body (one generated from the route's schema otherwise). */
  body?: Record<string, unknown>;
  /**
   * The control call as org A with the same ids must succeed (proving the ids are A's real
   * ones). False only with a reason: the route needs something the seed doesn't have.
   */
  control?: true | string;
}

const org: RouteClass = { kind: 'org' };
const now = Math.floor(Date.now() / 1000);
/** The last hour, for routes that ask for a range. */
const lastHour = { from: String(now - 3600), to: String(now) };
const pub: RouteClass = { kind: 'public' };
const installation: RouteClass = { kind: 'installation' };
const ingest: RouteClass = { kind: 'ingest' };
const mcp: RouteClass = { kind: 'mcp' };
const cloud: RouteClass = { kind: 'cloud' };

export const ROUTES: Record<string, RouteClass> = {
  'GET /api/v1/health': pub,
  'GET /api/v1/setup': pub,
  'POST /api/v1/setup': pub,
  'POST /api/v1/auth/login': pub,
  'POST /api/v1/auth/logout': pub,
  'GET /api/v1/me': pub,
  'POST /api/v1/demo/session': pub,
  'GET /api/v1/openapi.json': pub,
  'POST /api/v1/auth/forgot-password': pub,
  'GET /api/v1/invites/:token': pub,
  'POST /api/v1/invites/:token/accept': pub,
  'GET /api/v1/password-resets/:token': pub,
  'POST /api/v1/password-resets/:token': pub,

  // Cloud accounts (ADR-175). Called as B with A's ids in the sweep; the cross-org cases
  // (switching to A's org, revoking A's session) are asserted in cross-org.test.ts.
  'GET /api/v1/auth/config': cloud,
  'POST /api/v1/auth/signup': cloud,
  'POST /api/v1/auth/verify-email': cloud,
  'POST /api/v1/auth/verify-email/resend': cloud,
  'GET /api/v1/auth/account': cloud,
  'POST /api/v1/auth/2fa/setup': cloud,
  'POST /api/v1/auth/2fa/enable': cloud,
  'POST /api/v1/auth/2fa/disable': cloud,
  'POST /api/v1/auth/2fa/recovery-codes': cloud,
  'POST /api/v1/auth/2fa/verify': cloud,
  'GET /api/v1/auth/sessions': cloud,
  'DELETE /api/v1/auth/sessions/:id': cloud,
  'DELETE /api/v1/auth/sessions': cloud,
  'GET /api/v1/orgs': cloud,
  'POST /api/v1/orgs/:id/switch': cloud,
  'POST /api/v1/invites/:token/join': cloud,
  'GET /api/v1/auth/oauth/:provider/start': cloud,
  'GET /api/v1/auth/oauth/:provider/callback': cloud,
  'DELETE /api/v1/auth/identities/:provider': cloud,

  'GET /api/v1/clusters': org,
  'POST /api/v1/clusters': org,
  'GET /api/v1/clusters/:id': org,
  'PATCH /api/v1/clusters/:id': org,
  'DELETE /api/v1/clusters/:id': org,
  'POST /api/v1/clusters/:id/tokens': org,
  'DELETE /api/v1/clusters/:id/tokens/:tokenId': org,
  'POST /api/v1/query/range': org,
  'GET /api/v1/clusters/:id/docker/hosts': org,
  'GET /api/v1/clusters/:id/docker/containers': org,
  'GET /api/v1/clusters/:id/nodes': org,
  'GET /api/v1/clusters/:id/nodes/:name': org,
  'GET /api/v1/clusters/:id/workloads': org,
  'GET /api/v1/clusters/:id/pods': org,
  'GET /api/v1/clusters/:id/pods/:namespace/:name': org,
  'GET /api/v1/clusters/:id/events': org,
  'GET /api/v1/clusters/:id/events/summary': org,
  'GET /api/v1/clusters/:id/change-markers': { kind: 'org', query: lastHour },
  'GET /api/v1/clusters/:id/namespaces': org,
  'GET /api/v1/clusters/:id/pods/:namespace/:name/logs': {
    kind: 'org',
    control: 'needs a connected agent to answer; its stream form is classified separately',
  },
  'GET /api/v1/clusters/:id/docker/hosts/:host/containers/:name/logs': {
    kind: 'org',
    control: 'needs a connected agent to answer',
  },
  'GET /api/v1/clusters/:id/right-sizing': org,
  'GET /api/v1/clusters/:id/search': { kind: 'org', query: { q: 'web' } },
  'GET /api/v1/clusters/:id/overview': org,
  'GET /api/v1/clusters/:id/service-map': org,
  'GET /api/v1/clusters/:id/service-map/edge': {
    kind: 'org',
    control: 'needs an edge between two workloads, which the seed has no flows for',
  },

  'GET /api/v1/alerting/status': org,
  'GET /api/v1/alerts': org,
  'GET /api/v1/alerts/:id': org,
  'GET /api/v1/alerts/:id/chart': org,
  'GET /api/v1/silences': org,
  'POST /api/v1/silences': org,
  'DELETE /api/v1/silences/:id': org,
  'GET /api/v1/alert-rules': org,
  'PATCH /api/v1/alert-rules/:id': org,
  'POST /api/v1/alert-rules': org,
  'PUT /api/v1/alert-rules/defaults/channels': org,
  'POST /api/v1/alert-rules/:id/reset': org,
  'POST /api/v1/alert-rules/preview': org,
  'DELETE /api/v1/alert-rules/:id': org,
  'GET /api/v1/alert-channels': org,
  'POST /api/v1/alert-channels': org,
  'PATCH /api/v1/alert-channels/:id': org,
  'DELETE /api/v1/alert-channels/:id': org,
  'POST /api/v1/alert-channels/:id/test': org,
  'POST /api/v1/alert-channels/:id/telegram/connect': org,

  'GET /api/v1/settings/general': installation,
  'PUT /api/v1/settings/general': installation,
  'GET /api/v1/settings/namespaces': pub,
  'PUT /api/v1/settings/namespaces': installation,
  'GET /api/v1/settings/logs': pub,
  'PUT /api/v1/settings/logs': installation,
  'GET /api/v1/settings/smtp': installation,
  'PUT /api/v1/settings/smtp': installation,
  'DELETE /api/v1/settings/smtp': installation,
  'POST /api/v1/settings/smtp/test': installation,
  'GET /api/v1/settings/telegram': installation,
  'PUT /api/v1/settings/telegram': installation,
  'GET /api/v1/settings/telegram/reachability': installation,

  'GET /api/v1/applications': org,
  'GET /api/v1/applications/discovered': org,
  'POST /api/v1/applications/discovered/ignore': org,
  'DELETE /api/v1/applications/discovered/ignore/:id': org,
  'GET /api/v1/applications/collectors': org,
  'GET /api/v1/applications/alert-defaults': org,
  'GET /api/v1/applications/metrics': org,
  'GET /api/v1/applications/:id': org,
  'GET /api/v1/applications/:id/panels': org,
  'POST /api/v1/applications': org,
  'DELETE /api/v1/applications/:id': org,
  'POST /api/v1/applications/probes': org,
  'GET /api/v1/applications/probes/:id': org,
  'POST /api/v1/applications/probes/:id/check': org,
  'GET /api/v1/applications/:id/access': org,
  'PUT /api/v1/applications/:id/access': org,
  'DELETE /api/v1/applications/:id/access': org,
  'PATCH /api/v1/applications/:id': org,
  'GET /api/v1/causes': org,

  'GET /api/v1/api-tokens': org,
  'POST /api/v1/api-tokens': org,
  'GET /api/v1/api-tokens/:id': org,
  'DELETE /api/v1/api-tokens/:id': org,

  'GET /api/v1/users': org,
  'POST /api/v1/users/invites': org,
  'POST /api/v1/users/invites/:id/link': org,
  'POST /api/v1/users/invites/:id/renew': org,
  'DELETE /api/v1/users/invites/:id': org,
  'PATCH /api/v1/users/:id': org,
  'POST /api/v1/users/:id/reset-link': org,
  'DELETE /api/v1/users/:id': org,
  'POST /api/v1/users/:id/owner': org,

  'POST /mcp': mcp,
  'GET /mcp': mcp,
  'DELETE /mcp': mcp,

  'POST /ingest/v1/write': ingest,
  'POST /ingest/v1/objects': ingest,
  'POST /ingest/v1/events': ingest,
  'GET /ingest/v1/logs/requests': ingest,
  'POST /ingest/v1/logs/:requestId': ingest,
  'GET /ingest/v1/integrations/config': ingest,
  'POST /ingest/v1/integrations/status': ingest,
  'POST /ingest/v1/integrations/probes': ingest,
  'POST /ingest/v1/heartbeat': ingest,
};

/** Event streams: a route and how it is asked for one (ADR-167's logs follow). */
export const STREAMS: { route: string; query: Record<string, string> }[] = [
  {
    route: 'GET /api/v1/clusters/:id/pods/:namespace/:name/logs',
    query: { follow: 'true' },
  },
  {
    route: 'GET /api/v1/clusters/:id/docker/hosts/:host/containers/:name/logs',
    query: { follow: 'true' },
  },
];
