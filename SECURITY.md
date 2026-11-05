# Security policy

WatchLog runs an agent with read access to your nodes and containers, so we take reports seriously and answer quickly.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately in one of these ways:

- **GitHub:** [report a vulnerability](https://github.com/watchlog-light/watchlog/security/advisories/new) (private security advisory). This is preferred.
- **Email:** security@watchlog.io

Include what you found, the version (`watchlog-agent --version`, or the backend version on Settings), how to reproduce it, and the impact as you see it. A proof of concept helps; please don't access data that isn't yours.

## What happens next

| When                   | What                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Within 3 working days  | We confirm we received the report.                                                                                              |
| Within 10 working days | We confirm whether it is a vulnerability, its severity and a planned fix date.                                                  |
| Fix released           | A patch release, a GitHub security advisory (with a CVE where it applies) and credit to you, unless you prefer not to be named. |

We ask you to keep the report private until the fix is released, or for 90 days from your report, whichever comes first.

## Supported versions

Security fixes go into the latest minor release. Before 1.0, only the latest release is supported: upgrade with `helm upgrade --reuse-values` or by re-running the Docker install command. Upgrades never need manual steps.

## Scope

In scope: the agent and cluster-agent, the backend API, the web UI, the Helm charts, the Docker install command and the published images.

Especially interesting:

- **The agent reading more than documented.** See [docs/site/security.md](docs/site/security.md) for what it can and cannot access. It must never read Secrets, ConfigMap data, environment values or request payloads.
- **Privilege escalation.** For example, through the node agent's `BPF` and `PERFMON` capabilities or its read-only host mounts.
- **Authentication or tenant isolation bypasses.** In the backend, or in ingest tokens.
- **Injection.** Into commands that the UI shows for copying.

Out of scope: findings that need an already-compromised node or cluster-admin access, denial of service by volume against a self-hosted instance, and reports from automated scanners without a demonstrated impact.

## Verifying releases

Release images and charts are signed with cosign (keyless). How to verify them is in each release's notes.
