// SPDX-License-Identifier: AGPL-3.0-only
// Types for the public REST API (SPEC §8), generated from the backend's OpenAPI
// document: run `pnpm api-types:generate` after changing a route schema.
import type { paths } from './generated/openapi.js';

export type { paths } from './generated/openapi.js';

type JsonBody<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Responses<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: infer R;
}
  ? R
  : never;
type RequestBody<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  requestBody?: infer B;
}
  ? JsonBody<NonNullable<B>>
  : never;

export type HealthResponse = JsonBody<Responses<'/api/v1/health', 'get'>[200]>;
export type SetupStatus = JsonBody<Responses<'/api/v1/setup', 'get'>[200]>;
export type SetupRequest = RequestBody<'/api/v1/setup', 'post'>;
export type LoginRequest = RequestBody<'/api/v1/auth/login', 'post'>;
export type DemoSessionResponse = JsonBody<Responses<'/api/v1/demo/session', 'post'>[200]>;
export type UserEnvelope = JsonBody<Responses<'/api/v1/me', 'get'>[200]>;
export type CurrentUser = UserEnvelope['user'];

export type ClusterList = JsonBody<Responses<'/api/v1/clusters', 'get'>[200]>;
export type Cluster = ClusterList['clusters'][number];
/** Ingest failing now (ADR-117). */
export type IngestFailure = NonNullable<Cluster['ingestFailure']>;
export type CreateClusterRequest = RequestBody<'/api/v1/clusters', 'post'>;
export type CreateClusterResponse = JsonBody<Responses<'/api/v1/clusters', 'post'>[201]>;
export type ClusterDetail = JsonBody<Responses<'/api/v1/clusters/{id}', 'get'>[200]>;
export type ClusterToken = ClusterDetail['tokens'][number];
export type IssueTokenResponse = JsonBody<Responses<'/api/v1/clusters/{id}/tokens', 'post'>[201]>;
/** The live connection checklist (ADR-176). */
export type OnboardingStatus = JsonBody<
  Responses<'/api/v1/clusters/{id}/onboarding-status', 'get'>[200]
>;
export type OnboardingStep = OnboardingStatus['steps'][number];

export type DockerHostList = JsonBody<Responses<'/api/v1/clusters/{id}/docker/hosts', 'get'>[200]>;
export type DockerHost = DockerHostList['hosts'][number];
export type DockerContainerList = JsonBody<
  Responses<'/api/v1/clusters/{id}/docker/containers', 'get'>[200]
>;
export type DockerContainer = DockerContainerList['containers'][number];
// Server fleets (ADR-207).
export type ServerList = JsonBody<Responses<'/api/v1/clusters/{id}/servers', 'get'>[200]>;
// Certificates and scheduled jobs (0.10, ADR-224).
export type CertificateList = JsonBody<Responses<'/api/v1/clusters/{id}/certificates', 'get'>[200]>;
export type TlsCertificate = CertificateList['certificates'][number];
export type InventoryCoverage = CertificateList['coverage'][number];
export type CertificateDetail = JsonBody<
  Responses<'/api/v1/clusters/{id}/certificates/{certId}', 'get'>[200]
>;
export type ScheduledJobList = JsonBody<
  Responses<'/api/v1/clusters/{id}/scheduled-jobs', 'get'>[200]
>;
export type ScheduledJob = ScheduledJobList['jobs'][number];
export type JobRun = ScheduledJob['recent'][number];
export type ScheduledJobDetail = JsonBody<
  Responses<'/api/v1/clusters/{id}/scheduled-jobs/{jobId}', 'get'>[200]
>;
// The run timeline and the first-find card (0.13.0, ADR-230).
export type JobTimeline = JsonBody<
  Responses<'/api/v1/clusters/{id}/scheduled-jobs/timeline', 'get'>[200]
>;
export type JobTimelineLane = JobTimeline['jobs'][number];
export type JobTimelineSlot = JobTimelineLane['slots'][number];
export type FirstFind = JsonBody<Responses<'/api/v1/clusters/{id}/first-find', 'get'>[200]>;
export type ServerRow = ServerList['servers'][number];
export type FleetWorkload = NonNullable<ServerList['workloads']>[number];
export type ServerDetail = JsonBody<
  Responses<'/api/v1/clusters/{id}/servers/{server}', 'get'>[200]
>;
export type ServerEdge = ServerDetail['talksTo'][number];
export type ServerWorkloadList = JsonBody<
  Responses<'/api/v1/clusters/{id}/servers/{server}/workloads', 'get'>[200]
>;
export type ServerWorkload = ServerWorkloadList['workloads'][number];
export type ServerWorkloadDetail = JsonBody<
  Responses<'/api/v1/clusters/{id}/servers/{server}/workloads/{workload}', 'get'>[200]
>;
export type ProcessRuleList = JsonBody<
  Responses<'/api/v1/clusters/{id}/process-rules', 'get'>[200]
>;
export type ProcessRule = ProcessRuleList['rules'][number];
export type KubeOverview = JsonBody<Responses<'/api/v1/clusters/{id}/overview', 'get'>[200]>;
export type OverviewProblem = KubeOverview['problems']['items'][number];
export type OverviewEvent = KubeOverview['events'][number];
export type OverviewMarker = KubeOverview['markers'][number];
export type OverviewNode = KubeOverview['nodes'][number];
export type OverviewTop = KubeOverview['top']['cpu'][number];
export type OverviewPod = KubeOverview['pods'][number];
export type KubeNodeList = JsonBody<Responses<'/api/v1/clusters/{id}/nodes', 'get'>[200]>;
export type KubeNode = KubeNodeList['nodes'][number];
export type KubeNodeDetail = JsonBody<Responses<'/api/v1/clusters/{id}/nodes/{name}', 'get'>[200]>;
export type KubeWorkloadList = JsonBody<Responses<'/api/v1/clusters/{id}/workloads', 'get'>[200]>;
export type KubeWorkload = KubeWorkloadList['workloads'][number];
export type KubePodList = JsonBody<Responses<'/api/v1/clusters/{id}/pods', 'get'>[200]>;
export type KubePod = KubePodList['pods'][number];
export type KubePodDetail = JsonBody<
  Responses<'/api/v1/clusters/{id}/pods/{namespace}/{name}', 'get'>[200]
>;
export type KubeContainer = KubePodDetail['containers'][number];
export type KubeEventPage = JsonBody<Responses<'/api/v1/clusters/{id}/events', 'get'>[200]>;
export type KubeEvent = KubeEventPage['events'][number];
export type KubeEventSummary = JsonBody<
  Responses<'/api/v1/clusters/{id}/events/summary', 'get'>[200]
>;
export type ChangeMarkerList = JsonBody<
  Responses<'/api/v1/clusters/{id}/change-markers', 'get'>[200]
>;
export type ChangeMarker = ChangeMarkerList['markers'][number];
export type NamespaceList = JsonBody<Responses<'/api/v1/clusters/{id}/namespaces', 'get'>[200]>;
export type RangeQueryRequest = RequestBody<'/api/v1/query/range', 'post'>;
export type RangeQueryResponse = JsonBody<Responses<'/api/v1/query/range', 'post'>[200]>;
export type MetricKey = RangeQueryRequest['metric'];

/** RFC 9457 problem details returned by every error response. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Read-only demo mode (ADR-122): `demo_read_only`, with `message` for the visitor. */
  code?: string;
  message?: string;
  /** Cloud's `plan-limit` (ADR-177): `clusters`, `users` or `nodes`, and the plan's number. */
  limit?: string;
  max?: number;
}

export type AlertingStatus = JsonBody<Responses<'/api/v1/alerting/status', 'get'>[200]>;
export type AlertList = JsonBody<Responses<'/api/v1/alerts', 'get'>[200]>;
export type Alert = AlertList['alerts'][number];
export type AlertDetail = JsonBody<Responses<'/api/v1/alerts/{id}', 'get'>[200]>;
export type AlertNotification = AlertDetail['notifications'][number];
export type AlertingGap = AlertDetail['gaps'][number];
export type AlertChart = JsonBody<Responses<'/api/v1/alerts/{id}/chart', 'get'>[200]>;
export type AlertChartPanel = AlertChart['panels'][number];
export type AlertChartMarker = AlertChart['markers'][number];
export type SilenceList = JsonBody<Responses<'/api/v1/silences', 'get'>[200]>;
export type Silence = SilenceList['silences'][number];
export type CreateSilenceRequest = RequestBody<'/api/v1/silences', 'post'>;
export type AlertRuleList = JsonBody<Responses<'/api/v1/alert-rules', 'get'>[200]>;
export type AlertRule = AlertRuleList['rules'][number];
export type PatchAlertRuleRequest = RequestBody<'/api/v1/alert-rules/{id}', 'patch'>;
export type CreateAlertRuleRequest = RequestBody<'/api/v1/alert-rules', 'post'>;
export type AlertChannelList = JsonBody<Responses<'/api/v1/alert-channels', 'get'>[200]>;
export type AlertChannel = AlertChannelList['channels'][number];
export type CreateAlertChannelRequest = RequestBody<'/api/v1/alert-channels', 'post'>;
export type CreatedAlertChannel = JsonBody<Responses<'/api/v1/alert-channels', 'post'>[201]>;
export type PatchAlertChannelRequest = RequestBody<'/api/v1/alert-channels/{id}', 'patch'>;
export type ChannelTestResult = JsonBody<
  Responses<'/api/v1/alert-channels/{id}/test', 'post'>[200]
>;
export type TelegramConnect = JsonBody<
  Responses<'/api/v1/alert-channels/{id}/telegram/connect', 'post'>[200]
>;
export type GeneralSettings = JsonBody<Responses<'/api/v1/settings/general', 'get'>[200]>;
export type NamespaceSettings = JsonBody<Responses<'/api/v1/settings/namespaces', 'get'>[200]>;
export type SmtpSettingsResponse = JsonBody<Responses<'/api/v1/settings/smtp', 'get'>[200]>;
export type SmtpSettings = NonNullable<SmtpSettingsResponse['smtp']>;
export type SmtpSettingsRequest = RequestBody<'/api/v1/settings/smtp', 'put'>;
export type SmtpTestResult = JsonBody<Responses<'/api/v1/settings/smtp/test', 'post'>[200]>;
export type TelegramSettings = JsonBody<Responses<'/api/v1/settings/telegram', 'get'>[200]>;
export type TelegramReachability = JsonBody<
  Responses<'/api/v1/settings/telegram/reachability', 'get'>[200]
>;
export type RulePreview = JsonBody<Responses<'/api/v1/alert-rules/preview', 'post'>[200]>;

export type ServiceMap = JsonBody<Responses<'/api/v1/clusters/{id}/service-map', 'get'>[200]>;
export type ServiceMapNode = ServiceMap['nodes'][number];
export type ServiceMapEdge = ServiceMap['edges'][number];
export type ServiceMapEdgeSeries = JsonBody<
  Responses<'/api/v1/clusters/{id}/service-map/edge', 'get'>[200]
>;

// Personal API tokens (ADR-125): Settings → API tokens.
export type ApiTokenList = JsonBody<Responses<'/api/v1/api-tokens', 'get'>[200]>;
export type ApiToken = ApiTokenList['tokens'][number];
export type ApiTokenStatus = ApiToken['status'];
export type CreateApiTokenRequest = RequestBody<'/api/v1/api-tokens', 'post'>;
export type CreateApiTokenResponse = JsonBody<Responses<'/api/v1/api-tokens', 'post'>[201]>;
export type ApiTokenDetail = JsonBody<Responses<'/api/v1/api-tokens/{id}', 'get'>[200]>;
export type ApiTokenEvent = ApiTokenDetail['history'][number];

// Applications (v0.3, SPEC §4.12).
export type ApplicationList = JsonBody<Responses<'/api/v1/applications', 'get'>[200]>;
export type Application = ApplicationList['applications'][number];
export type ApplicationHealth = Application['health'];
export type DiscoveredList = JsonBody<Responses<'/api/v1/applications/discovered', 'get'>[200]>;
export type DiscoveredService = DiscoveredList['discovered'][number];
export type IntegrationTarget = DiscoveredService['target'];
export type CollectorList = JsonBody<Responses<'/api/v1/applications/collectors', 'get'>[200]>;
export type IntegrationCollector = CollectorList['collectors'][number];
export type CreateApplicationRequest = RequestBody<'/api/v1/applications', 'post'>;
// The service page (ADR-135, ADR-137).
export type ApplicationDetail = JsonBody<Responses<'/api/v1/applications/{id}', 'get'>[200]>;
export type ApplicationReason = ApplicationDetail['reasons'][number];
export type ApplicationConnected = NonNullable<ApplicationDetail['connected']>;
export type ApplicationPanels = JsonBody<Responses<'/api/v1/applications/{id}/panels', 'get'>[200]>;
export type Panel = ApplicationPanels['panels'][number];
export type PanelKind = Panel['kind'];
export type ApplicationMetrics = JsonBody<Responses<'/api/v1/applications/metrics', 'get'>[200]>;
export type RowMetrics = ApplicationMetrics['metrics'][string];
export type KeyMetric = RowMetrics['keyMetrics'][number];
// The connect flow (ADR-133, ADR-134).
export type CreateProbeRequest = RequestBody<'/api/v1/applications/probes', 'post'>;
export type AccessRequest = CreateProbeRequest['access'];
export type CreateProbeResponse = JsonBody<Responses<'/api/v1/applications/probes', 'post'>[201]>;
export type Probe = CreateProbeResponse['probe'];
export type ApplicationAccess = JsonBody<Responses<'/api/v1/applications/{id}/access', 'get'>[200]>;
export type ApplicationEvent = ApplicationAccess['events'][number];
// Multi-user (ADR-140).
export type UserList = JsonBody<Responses<'/api/v1/users', 'get'>[200]>;
export type UserRow = UserList['users'][number];
export type InviteRow = UserList['invites'][number];
export type AuditRow = UserList['audit'][number];
export type CreateInviteRequest = RequestBody<'/api/v1/users/invites', 'post'>;
export type CreatedInvite = JsonBody<Responses<'/api/v1/users/invites', 'post'>[201]>;
export type IssuedLink = JsonBody<Responses<'/api/v1/users/{id}/reset-link', 'post'>[200]>;
export type InviteInfo = JsonBody<Responses<'/api/v1/invites/{token}', 'get'>[200]>;
export type ResetInfo = JsonBody<Responses<'/api/v1/password-resets/{token}', 'get'>[200]>;
// Probable cause (ADR-146 to ADR-148).
export type Causes = JsonBody<Responses<'/api/v1/causes', 'get'>[200]>;
export type Cause = Causes['causes'][number];
export type CauseStep = Cause['chain'][number];
export type CauseCheck = Causes['checks'][number];
export type CauseObject = Causes['subject'];
/** The short likely cause on the alert detail, a problem and an application (ADR-148). */
export type LikelyCause = NonNullable<AlertDetail['likelyCause']>;
/** A possible cause on a Needs-attention problem with no likely one (ADR-156). */
export type PossibleCause = NonNullable<OverviewProblem['possibleCauses']>[number];
// Right-sizing hints (ADR-168).
export type RightSizing = JsonBody<Responses<'/api/v1/clusters/{id}/right-sizing', 'get'>[200]>;
export type RightSizingHint = RightSizing['hints'][number];
export type RightSizingShort = RightSizing['notEnoughHistory'][number];
/** Egress watch (ADR-188, ADR-189): a cluster's or fleet's external destinations. */
export type Egress = JsonBody<Responses<'/api/v1/egress', 'get'>[200]>;
export type EgressRow = Egress['rows'][number];
export type EgressSource = EgressRow['sources'][number];
/** Expected destinations (ADR-186): a name, `*.` pattern or CIDR, for one source or all. */
export type EgressExpectations = JsonBody<Responses<'/api/v1/egress/expected', 'get'>[200]>;
export type EgressExpectation = EgressExpectations['items'][number];
export type EgressExpectationCreated = JsonBody<Responses<'/api/v1/egress/expected', 'post'>[201]>;
/** The suggested egress policy for a Kubernetes workload (ADR-190): YAML text, never applied. */
export type EgressPolicy = JsonBody<Responses<'/api/v1/egress/policy', 'get'>[200]>;
export type EgressPolicyFlavour = EgressPolicy['policies'][number];
/** What changed (ADR-199, ADR-202): a cluster's or fleet's unusual periods in a window. Pro. */
export type WhatChanged = JsonBody<Responses<'/api/v1/what-changed', 'get'>[200]>;
export type WhatChangedRow = WhatChanged['rows'][number];
export type WhatChangedObject = WhatChangedRow['object'];
/** The learning week as data (ADR-216): the day, the hours of the week learned, the series. */
export type WhatChangedLearning = WhatChanged['learning'];
// The agents and their update command (ADR-227).
export type ClusterAgents = JsonBody<Responses<'/api/v1/clusters/{id}/agents', 'get'>[200]>;
// All clusters and fleets (ADR-226).
export type AllClusters = JsonBody<Responses<'/api/v1/overview/all', 'get'>[200]>;
export type AllClustersRow = AllClusters['clusters'][number];
export type AllClustersProblem = AllClusters['problems'][number];
export type AllClustersChange = AllClusters['whatChanged']['rows'][number];
/** An anomaly alert's page (ADR-200): now, the usual range, the usual band, the answer given. */
export type AnomalyAlert = JsonBody<Responses<'/api/v1/alerts/{id}/anomaly', 'get'>[200]>;
export type AnomalyFeedback = NonNullable<AnomalyAlert['feedback']>;
// The ⌘K palette's search (ADR-169).
export type SearchResponse = JsonBody<Responses<'/api/v1/clusters/{id}/search', 'get'>[200]>;
export type SearchResult = SearchResponse['results'][number];
