// SPDX-License-Identifier: AGPL-3.0-only
// The funnel's events (SPEC §10.4, ADR-179) and how often each may happen. A one-time event
// is unique in the database (funnel_events.once_key): once per org, per user or per cluster.

/** How often an event may be recorded: once per org, user or cluster, or every time. */
export type FunnelOnce = 'org' | 'user' | 'cluster' | 'many';

/** Recorded by the server where they happen. */
export const SERVER_FUNNEL_EVENTS = {
  signup_completed: 'user',
  email_verified: 'user',
  cluster_created: 'many',
  second_cluster_added: 'org',
  agent_first_heartbeat: 'cluster',
  first_metrics_received: 'cluster',
  alert_channel_connected: 'org',
  first_alert_sent: 'org',
  day7_active: 'cluster',
  teammate_invited: 'org',
  application_connected: 'org',
  mcp_first_call: 'org',
  pro_started: 'org',
  first_week_channel: 'user',
  first_week_teammate: 'user',
  first_week_application: 'user',
  first_week_mcp: 'user',
  first_week_problem: 'user',
  first_week_dismissed: 'user',
} as const satisfies Record<string, FunnelOnce>;

/** Sent by the pages through POST /api/v1/funnel (the allow-list): what the server can't see. */
export const CLIENT_FUNNEL_EVENTS = {
  install_command_copied: 'many',
  sample_opened: 'user',
  dashboard_first_view: 'user',
  onboarding_dashboard_opened: 'many',
  onboarding_help_opened: 'many',
  onboarding_troubleshooting_shown: 'many',
} as const satisfies Record<string, FunnelOnce>;

export type ServerFunnelEvent = keyof typeof SERVER_FUNNEL_EVENTS;
export type ClientFunnelEvent = keyof typeof CLIENT_FUNNEL_EVENTS;
export type FunnelEventName = ServerFunnelEvent | ClientFunnelEvent;

export const CLIENT_FUNNEL_EVENT_NAMES = Object.keys(CLIENT_FUNNEL_EVENTS) as ClientFunnelEvent[];

export function onceOf(name: FunnelEventName): FunnelOnce {
  return (
    (SERVER_FUNNEL_EVENTS as Record<string, FunnelOnce>)[name] ??
    (CLIENT_FUNNEL_EVENTS as Record<string, FunnelOnce>)[name] ??
    'many'
  );
}

/**
 * The funnel's steps for the weekly conversion (the Cloud admin), in order. Each counts the
 * orgs that reached it, among the orgs whose first signup fell in that week.
 */
export const FUNNEL_STEPS = [
  'signup_completed',
  'cluster_created',
  'agent_first_heartbeat',
  'first_metrics_received',
  'dashboard_first_view',
  'alert_channel_connected',
  'first_alert_sent',
  'day7_active',
  'pro_started',
] as const satisfies readonly FunnelEventName[];
