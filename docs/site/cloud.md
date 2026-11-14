---
title: WatchLog Cloud
description: WatchLog run for you, in beta: signing up, the setup wizard, plans and limits, Pro free during the beta, export and deletion, staff support sessions and security.
---

# WatchLog Cloud

WatchLog Cloud is the same WatchLog as the self-hosted Community edition, run for you at cloud.watchlog.io. You install the agents on your Kubernetes clusters or Docker hosts; we run the backend, keep the data, upgrade it and back it up. Cloud is in **beta**: it is new, and it may change before billing starts.

If you'd rather run everything yourself, the [Community edition](install.md) is free, open source and has no limits.

## Signing up

Cloud opens in **waves**. While signup is by invite, we send invites from the waitlist in batches: each invite is one link, for one address, valid for 14 days. Opening the link fills in your address; you then sign up with a password, GitHub or Google. Without an invite, the sign-up page points you to the [waitlist](/pricing#cloud) and to the self-hosted install. Once Cloud opens to everyone, anyone can sign up.

Signing up needs no card and no company details. You get an organization named after your email address (rename it in Settings) with you as its Owner, on the Cloud Free plan. We send a link to verify your address; you can start before you click it, but after 7 days an unverified account can only verify.

**Two-factor sign-in** (an authenticator app, TOTP, with 10 recovery codes) is optional for every account and can be turned on in Settings › Security. It becomes required for the Owners of an organization that pays for Pro, once billing starts.

## The setup wizard

After signup a short wizard connects your first cluster or Docker fleet:

1. **Choose** Kubernetes or Docker, and a name.
2. **Install** with one command, which carries the cluster's token (it starts with `wl_ct_`, and is shown once): Helm or a `kubectl` manifest for Kubernetes, `docker run` or a Compose service for Docker. The `kubectl` manifest is fetched with a separate one-time install code, so the token never appears in a URL.
3. **Watch it connect.** A checklist ticks, live, as the agents report, the first metrics arrive, eBPF starts and the service map gets its first connection. If no agent has reported after 2 minutes, the wizard shows the checks to run and the common causes, and a way to ask us for help.

Then add an alert channel (Slack, Telegram or email) and open the dashboard. Everything after that works as in the [Community edition](install.md): the same views, [alerts](alerts.md), [probable cause](probable-cause.md), [logs](logs.md), the applications ([Redis](integrations/redis.md), [PostgreSQL](integrations/postgres.md) and the others) and [MCP](mcp.md).

## Plans and limits

|                                           | Cloud Free | Cloud Pro                                                                                        |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| Clusters or Docker fleets                 | 1          | Unlimited                                                                                        |
| Nodes (Kubernetes nodes and Docker hosts) | 5          | Unlimited                                                                                        |
| History                                   | 3 days     | 30 days                                                                                          |
| Users                                     | 1          | Up to 10                                                                                         |
| Support                                   |            | Email, within 2 business days                                                                    |
| Price                                     | Free       | $1 per node a month, $10 minimum; annual: $10 per node a year (2 months free), at least 10 nodes |

Every monitoring feature is in both plans. The multi-cluster view, SLO reports and anomaly detection are **coming to Pro**; they are not built yet.

**When you reach a limit,** nothing that already works stops:

- **A second cluster** on Free can't be added: the dashboard says the plan allows one and how to change plan. (The API answers `409` with the problem type `plan-limit`.)
- **A sixth node** on Free isn't accepted: its agent's data is refused, and the dashboard shows a banner with the count. The nodes that were already sending in the last 24 hours keep sending; a new node is refused only while the plan is full. (Ingest answers `402` for that node only.)
- **A second user** on Free can't be invited. (The API answers `409` `plan-limit`.)

The Owners get one email about each limit a day at most.

**Changing to a smaller plan** never deletes data before its history runs out. The nodes and clusters already sending keep sending for 14 days; after that, the nodes beyond the plan's limit (the newest first) are refused. The banner counts the days.

### How nodes are counted

Every hour WatchLog records how many nodes and Docker hosts sent data. A month's bill uses the **95th percentile** of those hourly counts, so a short autoscaling spike doesn't raise it: 10 nodes for most of the month and 40 for one day is billed as 10. The cluster agent and the applications' collectors aren't nodes. Settings › Plan & billing shows this month's count so far.

## Pro is free during the beta

While Cloud is in beta, an Owner can switch the organization to Pro in Settings › Plan & billing, without a card: unlimited clusters and nodes, 30 days of history and up to 10 users. Before billing starts, every Owner of a beta Pro organization gets **14 days' notice by email**. Nothing is ever charged without a card you add yourself, and the prices above don't change.

When billing starts, payments go through Stripe's own checkout and customer portal pages: card details never reach WatchLog's servers.

## Export and deletion

An Owner can, in Settings › Data:

- **Export the configuration** as JSON: the organization, its plan, members, clusters, alert rules, channels (without their secrets), silences, applications (without credentials) and API tokens (names and prefixes only).
- **Export metrics** for one cluster, for a time range of up to 31 days at a time, in VictoriaMetrics' export format.
- **Delete the organization.** You type its name to confirm. Deletion waits **7 days**, during which an Owner can undo it and you can still sign in and export; agents' data is refused from the start. After 7 days its data, its metrics and the accounts that belong to no other organization are deleted, and only a record that the deletion happened is kept.

You can also move to the self-hosted Community edition at any time: it is the same product.

**Inactive Free organizations:** a Free organization with no data for 30 days gets an email; if no data arrives in the 7 days after it, it is suspended. Sign-in still works, to export, delete or reactivate it.

## When we help you: support sessions

Sometimes we need to see your organization to help with a problem. WatchLog staff never sign in as you. Instead, a staff member opens a **support session** for your organization, with a reason:

- it is **read-only**: nothing can be changed, enforced three times (the request, the role and the database);
- it lasts **at most an hour**, and ends earlier when the staff member leaves;
- every **Owner gets an email** when one starts, and Settings › Security lists every session: who, when, why and which pages it opened;
- API tokens record "accessed by WatchLog staff" when a session viewed them.

## Security

- **Isolation between organizations:** every row belongs to one organization and the database enforces it with Row-Level Security, under a role that can't bypass it; every query, API call, MCP tool and stream also checks the organization. A test suite calls every route, MCP tool, query and stream as one organization with another's ids, and it runs on every change to the code.
- **Accounts:** passwords hashed with argon2id, checked against known breaches without sending them, optional two-factor sign-in, sessions you can list and end in Settings › Security, and Cloudflare Turnstile against bots on signup and password reset.
- **In transit and at rest:** HTTPS everywhere, a strict Content-Security-Policy, tokens stored as hashes, and secrets (channel tokens, two-factor secrets) encrypted with AES-256-GCM. Backups are encrypted before they leave the server.
- **The agents** are the same read-only agents as in the Community edition: see [what they can and cannot access](security.md).
- **Outbound requests:** alert channels can only post to public addresses, never to internal or cloud metadata ones.

## Help

Write to support@watchlog.io. Pro organizations get an answer within 2 business days. If a problem looks like a WatchLog bug, an issue on GitHub helps everyone.
