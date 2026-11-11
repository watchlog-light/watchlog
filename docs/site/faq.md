---
title: FAQ
description: Common questions about WatchLog — cost, data, kernels, air-gapped installs and alerts.
---

# Frequently asked questions

## Is it really free?

Yes. WatchLog Community is open source under AGPL-3.0, and you can self-host it at no cost, with no limit on clusters, Docker fleets, nodes or users. Teams that want a hosted service, a unified view across clusters, longer retention or SSO will be able to use the paid editions; see [pricing](/pricing).

## What data leaves my cluster?

Metrics (CPU, memory, disk, network, restarts), Kubernetes object states and events, and connection counts between workloads. It goes only to the WatchLog server you choose, which is your own when you self-host. Never Secrets, ConfigMap data, environment variables, command lines, request payloads or TLS contents. See [security](security.md) for the full list.

## Why does the node agent run as root?

Only for network flows, and only with two capabilities. Loading eBPF programs needs `BPF` and `PERFMON`, and Linux makes added capabilities effective in Kubernetes only for uid 0. Every other capability is dropped, privilege escalation is blocked, and the host mounts are read-only. With `agent.networkFlows.enabled=false` it runs as a non-root user with no capabilities, and everything except the service map traffic keeps working.

## Which kernels support the service map?

Linux 5.8 or newer with BTF (`/sys/kernel/btf/vmlinux`) and cgroup v2. That covers most current distributions, for example Ubuntu 22.04+, Debian 12+, RHEL 9+ and Amazon Linux 2023. Amazon Linux 2 nodes use cgroup v1 and are not supported for network flows.

On older kernels the agent reports why, everything else keeps working, and the service map shows topology from Services, clearly labelled.

## The service map says eBPF is off. What do I do?

The map lists each agent without network flows and says why: turned off in the configuration, an unsupported kernel, a missing capability, or an agent installed before network flows existed. Where a command fixes it, the map shows that exact command, such as the `helm upgrade` for your release. Copy and run it.

## Nodes say the kubelet certificate is not verified. How do I fix it?

The node agent reads each node's stats from its own kubelet over TLS. kind and kubeadm kubelets serve a self-signed certificate that the cluster CA did not sign, so with the default `kubeletTLS: auto` the agent connects without verifying it and the Nodes page says so. The data is still correct and the connection is still encrypted.

To have it verified, let the kubelets get serving certificates signed by the cluster CA: set `serverTLSBootstrap: true` in the kubelet configuration (kubeadm: the `kubelet-config` ConfigMap in `kube-system`, then restart the kubelets; kind: a `KubeletConfiguration` patch in `kubeadmConfigPatches` when you create the cluster), then approve the new certificate requests with `kubectl get csr` and `kubectl certificate approve <name>`. The agent verifies on its next connection; k3s does this out of the box. Set the agent chart's `agent.kubeletTLS` to `verify` to refuse unverified connections.

## Can I use it in an air-gapped network?

Yes. Mirror the images (`ghcr.io/watchlog-light/*`, `postgres:16-alpine` and `victoriametrics/victoria-metrics`) and the charts into your registry, then set `image.registry` (and `postgresql.image`, `victoriametrics.image`). Agents connect only to your WatchLog server. For alerts, email works through your SMTP server, and Slack, Telegram and webhooks can go through `HTTPS_PROXY`.

## How much does the agent use?

The node agent stays within 64 MB of memory and 1 % of a CPU core; we measure this on every change. Measured on a kind cluster: about 0.2–0.3 % of a core and 17–26 MB with network flows on. Images are under 40 MB.

## How is it different from Coroot or Netdata?

<!-- TODO before launch (SPEC §16 #6): one sentence each, after running both. -->

WatchLog aims at teams that want answers without building dashboards. One install gives you ready-made views for clusters, workloads and Docker hosts, a service map from eBPF and alerts that work on day one, with a small, read-only agent.

## Which alert channels are supported?

Slack, Telegram, email and webhooks (signed with HMAC-SHA256). Default rules cover crash loops, OOM kills, pods stuck pending, image pull errors, unavailable deployments, node pressure and NotReady nodes, containers throttled at their CPU limit, unhealthy Docker containers, failing connections between services, and agents that stop reporting. You can change their thresholds or add your own. When an alert's cause is likely, its message says so in one line ("Likely cause: …"); see [Alerts and notifications](alerts.md), which also documents the webhook's payload.

## Where is WatchLog Cloud data stored?

WatchLog Cloud is not available yet. When it launches, this answer will say where data is stored and for how long.

## How do I upgrade?

With `helm upgrade --reuse-values`, `docker compose pull && docker compose up -d`, or by re-running the Docker agent's install command. Upgrades never need manual steps. See [install](install.md#upgrade).
