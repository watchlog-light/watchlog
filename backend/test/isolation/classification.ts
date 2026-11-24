// SPDX-License-Identifier: AGPL-3.0-only
// Every route of the app, classified for the cross-org isolation suite (ADR-182). The suite
// reads Fastify's route table; a route missing here fails it, so each new route is
// classified when it is added. Kinds:
//   - org:          an org's data, behind a session or an API token. Called as org B with
//                   org A's ids it answers 404 (or 403 when the role decides first), and no
//                   answer of B's ever carries A's data.
//   - public:       answers before anyone is signed in (or about the caller only); still
//                   never carries A's data.
//   - installation: Community only (the installation's own settings, an Admin's reset
//                   link); 404 in Cloud (plugins/edition.ts).
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

/**
 * Routes of ee/'s modules (ADR-232), classified here but present only with ee/: the suite
 * checks them when they exist and doesn't miss them when ee/ is deleted.
 */
const NETWORK = 'the network module is licensed in ee/backend/test/network.test.ts, not here: 404';
const net: RouteClass = { kind: 'org', control: NETWORK };
export const EE_ROUTES: Record<string, RouteClass> = {
  // Network devices (ADR-233): every route behind the `network` feature, its rows by org.
  'GET /api/v1/network/summary': net,
  'GET /api/v1/network/devices': net,
  'GET /api/v1/network/devices/:id': net,
  'GET /api/v1/network/devices/:id/series': net,
  'POST /api/v1/network/devices': net,
  'PATCH /api/v1/network/devices/:id': net,
  'DELETE /api/v1/network/devices/:id': net,
  'POST /api/v1/network/devices/:id/accept-certificate': net,
  'GET /api/v1/network/map': net,
  'PUT /api/v1/network/map/layout': net,
  'GET /api/v1/network/attachments': net,
  'GET /api/v1/network/pollers': net,
  'GET /api/v1/network/credentials': net,
  'POST /api/v1/network/credentials': net,
  'PATCH /api/v1/network/credentials/:id': net,
  'DELETE /api/v1/network/credentials/:id': net,
  'POST /api/v1/network/discoveries': net,
  'GET /api/v1/network/discoveries/:id': net,
  'GET /api/v1/network/setup-commands': net,
  'POST /ingest/v1/network/report': ingest,
};

export const ROUTES: Record<string, RouteClass> = {
  'GET /api/v1/health': pub,
  'GET /api/v1/setup': pub,
  'POST /api/v1/setup': pub,
  'POST /api/v1/auth/login': pub,
  'POST /api/v1/auth/logout': pub,
  'GET /api/v1/me': pub,
  // The caller's own theme (ADR-228): about the caller only, no ids.
  'PATCH /api/v1/me/preferences': { kind: 'public', body: { theme: 'light' } },
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
  // Leaked-password hash endings for 5 hash characters (0.9.9): public data, no org in it.
  'GET /api/v1/auth/password-range/:prefix': cloud,
  'POST /api/v1/auth/signup': cloud,
  // Invite waves (ADR-173): checks a signup invite's code, signed out; no org's data.
  'POST /api/v1/auth/signup-invite': cloud,
  'POST /api/v1/auth/verify-email': cloud,
  'POST /api/v1/auth/verify-email/resend': cloud,
  'POST /api/v1/auth/verify-email/code': cloud,
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

  // Cloud onboarding (ADR-176): the first-week card, the page's funnel events, and the
  // kubectl manifest behind an install code (a code of A's never answers for B's cluster:
  // cross-org.test.ts).
  'GET /api/v1/onboarding/first-week': cloud,
  'POST /api/v1/onboarding/first-week/dismiss': cloud,
  'POST /api/v1/funnel': { kind: 'cloud', body: { name: 'install_command_copied' } },
  'GET /install.yaml': cloud,
  // The server install script (ADR-209): public, no token or org data in it.
  'GET /install.sh': pub,

  // Cloud plans (ADR-177): the org's plan, limits and usage, for the strip and the banners.
  'GET /api/v1/plan': cloud,
  // Plan & billing's actions (ADR-178), through the billing service; the org is the
  // session's, never a parameter. Owner-only writes: B's Owner reaches B's billing only.
  'GET /api/v1/plan/billing': cloud,
  'POST /api/v1/plan/beta': cloud,
  'POST /api/v1/plan/checkout': { kind: 'cloud', body: { interval: 'monthly' } },
  'POST /api/v1/plan/portal': cloud,

  // Support mode (ADR-179): entering from the Cloud admin's one-time link, the banner,
  // leaving, and the Owners' list of the org's sessions (B's Owner sees B's only). A
  // support session of A's reaching B is asserted in support.test.ts.
  'GET /api/v1/support/enter': { kind: 'cloud', query: { code: 'wl_sc_none' } },
  'GET /api/v1/support/current': cloud,
  'DELETE /api/v1/support/session': cloud,
  'GET /api/v1/support-sessions': cloud,
  // The lifecycle emails' unsubscribe (ADR-179): a signed link naming one user, no session.
  'GET /api/v1/email/unsubscribe': { kind: 'cloud', query: { token: 'none' } },
  'POST /api/v1/email/unsubscribe': { kind: 'cloud', query: { token: 'none' } },
  // Data rights (ADR-181): the banners' state, the exports (B with A's cluster: 404, in
  // cross-org.test.ts), the deletion (its confirmation is the org's name, so the sweep's
  // generated body is refused) and the Owners' reactivation.
  'GET /api/v1/org/status': cloud,
  'GET /api/v1/org/export': cloud,
  'GET /api/v1/clusters/:id/export': { kind: 'cloud', query: lastHour },
  'POST /api/v1/org/deletion': cloud,
  'DELETE /api/v1/org/deletion': cloud,
  'POST /api/v1/org/reactivate': cloud,

  'GET /api/v1/clusters': org,
  'POST /api/v1/clusters': org,
  'GET /api/v1/clusters/:id': org,
  // The agents and their update command (ADR-227): B with A's cluster gets 404.
  'GET /api/v1/clusters/:id/agents': org,
  'PATCH /api/v1/clusters/:id': org,
  'DELETE /api/v1/clusters/:id': org,
  'POST /api/v1/clusters/:id/tokens': org,
  'DELETE /api/v1/clusters/:id/tokens/:tokenId': org,
  'POST /api/v1/query/range': org,
  'GET /api/v1/clusters/:id/docker/hosts': org,
  'GET /api/v1/clusters/:id/docker/containers': org,
  // Server fleets (ADR-207).
  'GET /api/v1/clusters/:id/servers': org,
  'GET /api/v1/clusters/:id/servers/:server': org,
  'GET /api/v1/clusters/:id/servers/:server/workloads': org,
  'GET /api/v1/clusters/:id/servers/:server/workloads/:workload': org,
  'GET /api/v1/clusters/:id/process-rules': org,
  // Certificates and scheduled jobs (0.10, ADR-224).
  'GET /api/v1/clusters/:id/certificates': org,
  'GET /api/v1/clusters/:id/certificates/:certId': org,
  'GET /api/v1/clusters/:id/scheduled-jobs': org,
  'GET /api/v1/clusters/:id/scheduled-jobs/:jobId': org,
  'GET /api/v1/clusters/:id/scheduled-jobs/timeline': org,
  'GET /api/v1/clusters/:id/first-find': org,
  'POST /api/v1/clusters/:id/first-find/dismiss': org,
  'PUT /api/v1/clusters/:id/process-rules': org,
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
  'GET /api/v1/clusters/:id/servers/:server/workloads/:workload/logs': {
    kind: 'org',
    control: 'needs a connected agent to answer',
  },
  'GET /api/v1/clusters/:id/right-sizing': org,
  // Egress watch (ADR-189, ADR-192): the cluster is a query parameter, so its 404 for B with
  // A's ids and A's control are asserted in cross-org.test.ts ("egress").
  'GET /api/v1/egress': org,
  // Expectations (ADR-186): B with A's cluster or A's expectation id gets 404 and A's rows
  // stay; B's own create and remove work under RLS (cross-org.test.ts, "expectations").
  'GET /api/v1/egress/expected': org,
  'POST /api/v1/egress/expected': org,
  'DELETE /api/v1/egress/expected/:id': org,
  // The policy suggestion (ADR-190): B with A's clusters and workload gets 404, never the
  // Docker reason; B's own and A's control (cross-org.test.ts, "egress policy").
  'GET /api/v1/egress/policy': org,
  // What changed (ADR-199, ADR-202): Pro only, and public: API tokens read it too. B with A's
  // cluster or A's alert gets 404, a Free org 403 `pro-feature` with nothing of A's, B's own
  // and A's control, by session (cross-org.test.ts, "what changed") and by API token and MCP
  // ("what changed tool"); Community's 404 and absent tool are in community.test.ts.
  'GET /api/v1/what-changed': org,
  // All clusters and fleets (ADR-226): Pro only; no ids, so B's answer is its own org's alone:
  // all-clusters.test.ts asserts another org's clusters and problems never show, Free's 403
  // and Community's 404.
  'GET /api/v1/overview/all': org,
  // The learning week (ADR-216): the learning state alone, and a member's own "email me when
  // it's ready". B with A's clusters gets 404 for both (Free: 403), nothing of A's is added
  // or removed, and each org reads and changes only its own (cross-org.test.ts, "the learning
  // week"); Community's 404s are in community.test.ts.
  'GET /api/v1/what-changed/learning': org,
  'GET /api/v1/what-changed/live': org,
  'GET /api/v1/what-changed/recent': org,
  'PUT /api/v1/what-changed/ready-email': {
    kind: 'org',
    control:
      'needs a cluster still learning: the seed\'s have finished (cross-org.test.ts, "the learning week")',
  },
  // Anomaly alerts' page and feedback (ADR-200): Pro only. B with A's anomaly alert gets 404
  // (Free: 403 `pro-feature`), B's own answer and undo work under RLS, A's are untouched
  // (cross-org.test.ts, "anomaly feedback"); Community's 404 is in community.test.ts.
  'GET /api/v1/alerts/:id/anomaly': {
    kind: 'org',
    control:
      'needs an anomaly alert: the seed\'s alertId is a crash-loop alert (cross-org.test.ts, "anomaly feedback")',
  },
  'POST /api/v1/alerts/:id/anomaly-feedback': {
    kind: 'org',
    body: { answer: 'normal' },
    control: 'needs an anomaly alert (cross-org.test.ts, "anomaly feedback")',
  },
  'DELETE /api/v1/alerts/:id/anomaly-feedback': {
    kind: 'org',
    control: 'needs an anomaly alert (cross-org.test.ts, "anomaly feedback")',
  },
  'GET /api/v1/clusters/:id/search': { kind: 'org', query: { q: 'web' } },
  'GET /api/v1/clusters/:id/overview': org,
  'GET /api/v1/clusters/:id/service-map': org,
  // The live connection checklist (ADR-176), both editions; its stream form is in STREAMS.
  'GET /api/v1/clusters/:id/onboarding-status': org,
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

  // The Enterprise licence (ADR-232): the installation's, Community only.
  'GET /api/v1/license': installation,
  'PUT /api/v1/license': installation,
  'DELETE /api/v1/license': installation,
  'GET /api/v1/license/summary': installation,
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
  // Cloud: 404 (SR-1): an account there spans orgs, so an Admin's reset link is Community's.
  'POST /api/v1/users/:id/reset-link': installation,
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
  'GET /ingest/v1/process-rules': ingest,
  'POST /ingest/v1/integrations/status': ingest,
  'POST /ingest/v1/integrations/probes': ingest,
  'POST /ingest/v1/heartbeat': ingest,
};

/**
 * Every MCP tool (ADR-182, ADR-192): how it reaches an org's data. The sweep in
 * cross-org.test.ts ("every MCP tool") calls each one as B with A's Kubernetes and Docker
 * ids and as A; a tool missing here fails it, so each new tool is classified when it is added.
 *   - cluster: takes a cluster (name or id) and reads it through the public API as the token;
 *   - id:      takes one of an org's object ids (an alert's);
 *   - org:     lists the token's own org (no id to pass).
 */
export const MCP_TOOLS: Record<string, 'cluster' | 'id' | 'org'> = {
  list_clusters: 'org',
  // All clusters and fleets (ADR-226): the token's own org only; Cloud and the demo only
  // (mcp-all-clusters.test.ts: Free's refusal, absent in Community).
  get_all_clusters: 'org',
  get_problems: 'cluster',
  list_alerts: 'cluster',
  explain_alert: 'id',
  explain_problem: 'cluster',
  get_workload: 'cluster',
  get_pod: 'cluster',
  get_container_logs: 'cluster',
  get_right_sizing: 'cluster',
  get_node: 'cluster',
  get_server: 'cluster',
  list_workloads: 'cluster',
  list_scheduled_jobs: 'cluster',
  list_certificates: 'cluster',
  list_applications: 'cluster',
  get_application: 'cluster',
  get_service_map: 'cluster',
  // Egress watch (ADR-189): also asserted one by one in cross-org.test.ts ("egress tools").
  get_egress: 'cluster',
  get_new_destinations: 'cluster',
  get_expected_destinations: 'cluster',
  get_events: 'cluster',
  get_recent_changes: 'cluster',
  // What changed (ADR-202): Cloud and the demo only; also asserted one by one in
  // cross-org.test.ts ("what changed tool"), and absent in community.test.ts.
  get_what_changed: 'cluster',
  query_metric: 'cluster',
};

/** Event streams: a route and how it is asked for one (ADR-167's logs follow, ADR-176). */
export const STREAMS: { route: string; query: Record<string, string> }[] = [
  { route: 'GET /api/v1/clusters/:id/onboarding-status', query: {} },
  {
    route: 'GET /api/v1/clusters/:id/pods/:namespace/:name/logs',
    query: { follow: 'true' },
  },
  {
    route: 'GET /api/v1/clusters/:id/docker/hosts/:host/containers/:name/logs',
    query: { follow: 'true' },
  },
  {
    route: 'GET /api/v1/clusters/:id/servers/:server/workloads/:workload/logs',
    query: { follow: 'true' },
  },
];

/**
 * The internal API (ADR-177, ADR-178): its own app and listener, never the public one.
 * Each route answers 404 on the public listener and in Community, and 401 without the
 * internal token (internal.test.ts). A route added there without a line here fails.
 */
export const INTERNAL_ROUTES = [
  'GET /internal/orgs/:id/entitlements',
  'PUT /internal/orgs/:id/entitlements',
  'GET /internal/orgs/:id/usage',
  'GET /internal/orgs/:id/owners',
  // The beta-to-billing notice, asked for by billing (ADR-179).
  'POST /internal/orgs/:id/beta-notice',
  // The Cloud admin's API (ADR-179): also needs X-WatchLog-Staff (internal.test.ts).
  'GET /internal/admin/orgs',
  // The Cloud admin's Users page (0.9.9): read-only, never a secret.
  'GET /internal/admin/users',
  'GET /internal/admin/users/:id',
  'GET /internal/admin/orgs/:id',
  'GET /internal/admin/orgs/:id/members',
  'GET /internal/admin/orgs/:id/usage',
  'GET /internal/admin/orgs/:id/entitlements',
  'PUT /internal/admin/orgs/:id/entitlements',
  'POST /internal/admin/orgs/:id/suspend',
  'POST /internal/admin/orgs/:id/unsuspend',
  'GET /internal/admin/funnel',
  'POST /internal/admin/orgs/:id/support-sessions',
  'GET /internal/admin/orgs/:id/support-sessions',
  'DELETE /internal/admin/support-sessions/:id',
  // Slice 6c: across orgs for the Cloud admin's lists, and invite waves (ADR-173).
  'GET /internal/admin/support-sessions',
  'GET /internal/admin/deletions',
  'GET /internal/admin/signup-mode',
  'PUT /internal/admin/signup-mode',
  'POST /internal/admin/signup-invites',
  'GET /internal/admin/signup-invites',
] as const;
