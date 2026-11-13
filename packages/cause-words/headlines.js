// SPDX-License-Identifier: AGPL-3.0-only
// The first sentence of a probable-cause answer (causes.headline.<code>, ADR-147), in
// vue-i18n's message format: `{fact}` placeholders, "singular | plural" picked by `n`. The
// dashboard's panel and Needs attention and the notifications' "Likely cause:" line render
// these same templates (ADR-157), so the two can't drift. Facts that need formatting are
// formatted by causeValues() in index.js first.
/** @type {Record<string, string>} */
export const HEADLINES = {
  none_no_changes:
    'We checked {n} things around {name} and none of them explains it. Nothing changed in the {minutes} minutes before.',
  none_found:
    'No rule explains what happens to {name}. We checked {n} things; {found} of them found something to look at.',
  none_flows_off:
    "Nothing on {name} itself explains it. Without network flows we couldn't check the services it calls.",
  possible:
    'Nothing proves one cause for {name}. This one could explain it. | Nothing proves one cause for {name}. These {n} could explain it.',
  oom_limit:
    '{name} is OOM-killed when it reaches its {limit} memory limit: once in the last hour. | {name} is OOM-killed when it reaches its {limit} memory limit: {n} times in the last hour.',
  oom_limit_restarts:
    '{name} is OOM-killed when it reaches its {limit} memory limit; it restarted once in the last hour. | {name} is OOM-killed when it reaches its {limit} memory limit; it restarted {n} times in the last hour.',
  oom_limit_last: '{name} was OOM-killed when it reached its {limit} memory limit.',
  crash_exit:
    '{name} keeps exiting with code {exitCode}: {n} restart in the last hour. | {name} keeps exiting with code {exitCode}: {n} restarts in the last hour.',
  crash_exit_every: '{name} exits with code {exitCode} about every {every}.',
  crash_exit_once: '{name} exited with code {exitCode}.',
  bad_change_crash:
    '{name} fails since its last change: the new version exits with code {exitCode}.',
  bad_change_oom:
    '{name} fails since its last change: the new version is OOM-killed at its {limit} memory limit.',
  bad_change: '{name} fails since its last change.',
  image_pull: "{name} can't start: it can't pull its image {image}.",
  image_pull_change:
    "{name}'s new pods can't start: they can't pull {image}, the image it was changed to.",
  unschedulable_cpu:
    "{name} can't be scheduled: it requests {request} CPU, and no node has that much free.",
  unschedulable_memory:
    "{name} can't be scheduled: it requests {request} of memory, and no node has that much free.",
  unschedulable_resource: "{name} can't be scheduled: no node has enough {resource} free.",
  unschedulable_selector:
    "{name} can't be scheduled: no node matches its node selector or affinity.",
  unschedulable_taint: "{name} can't be scheduled: the nodes have taints it doesn't tolerate.",
  unschedulable_cordoned:
    "{name} can't be scheduled: the node it may run on is cordoned. | {name} can't be scheduled: the nodes it may run on are cordoned.",
  unschedulable_other: "{name} can't be scheduled. The scheduler says: {message}.",
  job_failed_exit:
    "{name}'s run {job} failed: its pods exited with code {exitCode} until it gave up.",
  job_failed: "{name}'s run {job} failed.",
  node_or_host_held_cordoned:
    "{name} can't be scheduled: node {node}, where it may run, is cordoned and takes no new pods.",
  node_or_host_held_not_ready:
    "{name} can't be scheduled: node {node}, where it may run, isn't Ready.",
  node_or_host_held_pressure:
    "{name} can't be scheduled: node {node}, where it may run, is under {condition}.",
  node_or_host_not_ready: "{name} runs on node {node}, which isn't Ready ({status}).",
  node_or_host_evicted: '{name} was evicted: node {node} ran low on {resource}.',
  node_or_host_evicted_node: '{name} was evicted: its node ran low on {resource}.',
  node_or_host_oom_no_limit:
    '{name} is OOM-killed because node {node} runs out of memory: it has no memory limit of its own.',
  node_or_host_oom_pressure:
    '{name} is OOM-killed below its {limit} memory limit while node {node} is short of memory.',
  node_or_host_pressure: '{name} fails on node {node}, which is under {condition}.',
  node_or_host_node_restarted: '{name} restarted when node {node} restarted at {time}.',
  node_or_host_host_restarted: '{name} stopped when host {host} restarted at {time}.',
  node_or_host_docker_restarted: '{name} stopped when Docker on host {host} restarted at {time}.',
  node_or_host_silent:
    'Host {host} has sent nothing for {minutes} min: what WatchLog shows of {name} is from before.',
  node_or_host_never: 'Host {host} has never reported: WatchLog has nothing current about {name}.',
  node_or_host_oom_host:
    '{name} is OOM-killed because host {host} runs out of memory: it has no memory limit of its own.',
  node_or_host_oom_host_full:
    '{name} is OOM-killed below its {limit} memory limit while host {host} is nearly out of memory.',
  node_or_host_host_disk: '{name} fails on host {host}, whose disk is {pct}% full.',
  node_or_host_host_memory: '{name} fails on host {host}, whose memory is {pct}% used.',
  cpu_throttled: '{name} is CPU-throttled {pct}% of the time at its {cpuLimit} CPU limit.',
  cpu_throttled_share: '{name} is CPU-throttled {pct}% of the time at its CPU limit.',
  dependency_down: '{name} fails because {target} is down: none of its pods is ready.',
  dependency_down_scaled:
    '{name} fails because {target} was scaled to 0: nothing answers its calls.',
  dependency_down_oom:
    '{name} fails because {target} is down: it is OOM-killed at its {limit} memory limit.',
  dependency_down_crash:
    '{name} fails because {target} is down: it keeps exiting with code {exitCode}.',
  dependency_down_change: '{name} fails because {target} is down since its last change.',
  dependency_down_pull: "{name} fails because {target} is down: it can't pull its image {image}.",
  dependency_down_stopped:
    '{name} fails because {target} was stopped (exit code {exitCode}): nothing answers its calls.',
  dependency_down_node:
    '{name} fails because {target} is down: node {node} under it keeps it from running.',
  dependency_down_host:
    '{name} fails because {target} is down: host {node} under it keeps it from running.',
  connection_refused:
    "{name}'s connections to {target} on port {port} fail: {target} runs, but nothing accepts connections on that port.",
  connection_refused_noport:
    "{name}'s connections to {target} fail: {target} runs, but nothing accepts them.",
  dns_nxdomain:
    "{name}'s lookups fail: a name it looks up doesn't exist (NXDOMAIN {perMinute} times a minute).",
  dns_nxdomain_change:
    "{name}'s lookups fail since its last change: a name it looks up doesn't exist (NXDOMAIN {perMinute} times a minute).",
  bad_change_slow:
    "{name} is slow since {target}'s last change: its calls to {target} take {p95} at p95.",
  bad_change_errors:
    "{name} fails since {target}'s last change: {pct}% of its calls to {target} answer 5xx.",
  cpu_throttled_dependency:
    '{name} is slow because {target} is CPU-throttled {pct}% of the time at its {cpuLimit} CPU limit: its calls to {target} take {p95} at p95.',
  cpu_throttled_dependency_share:
    '{name} is slow because {target} is CPU-throttled {pct}% of the time at its CPU limit: its calls to {target} take {p95} at p95.',
  app_consumer_oom:
    '{queue} is filling up because its consumer {consumer} is OOM-killed at its {limit} memory limit.',
  app_consumer_crash:
    '{queue} is filling up because its consumer {consumer} keeps exiting with code {exitCode}.',
  app_consumer_ended: '{queue} is filling up because its consumer {consumer} ended ({how}).',
  app_consumer_change:
    '{queue} is filling up because its consumer {consumer} fails since its last change.',
  app_pg_held:
    '{name} is at {pct}% of max_connections: {holder} holds one of them. | {name} is at {pct}% of max_connections: {holder} holds {n} of them.',
  app_lock_held:
    "{name}'s writes wait on a row lock in {table}: {holder} holds it, its transaction open for {held}.",
  app_lock_held_any:
    "{name}'s writes wait on a row lock: {holder} holds it, its transaction open for {held}.",
  app_finding_caller:
    "{name}'s calls to {app} fail or slow down, and WatchLog sees a problem on {app}.",
};
