---
title: Linux servers
description: Monitor Linux servers with WatchLog: every systemd service, every process group (PHP, Node, Go, Java, Python, anything) and every container, with exits, crashes and OOM kills from the kernel, alerts and probable cause. One command to install.
---

# Linux servers

A **Server fleet** is a group of Linux servers. On each one, WatchLog shows every workload
it runs, whatever it is and however it was started:

- **systemd services:** nginx, PostgreSQL, a Go binary with its own unit;
- **process groups:** a pm2 app, a PHP-FPM pool, a gunicorn app, a jar or a script started by
  hand, named by what they run, in any language;
- **containers:** Docker or Podman, with their Compose project.

No code changes, no exporters. Docker fleets from WatchLog 0.8 and earlier became Server
fleets in 0.9 and kept their history.

## Install

In WatchLog, **Settings → Clusters → Add**, choose **Servers**, then run the command it shows
on each server. Four ways, all with the same agent:

| Way         | Command                                                                          | For                                          |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| One command | `curl -fsSL https://<your WatchLog>/install.sh \| sudo sh -s -- --token <token>` | Any distribution with systemd                |
| deb         | the package of your WatchLog's version, with the token in the environment        | Debian, Ubuntu                               |
| rpm         | the same, as an rpm                                                              | RHEL, Rocky, Alma, Fedora, Amazon Linux      |
| Docker      | `docker run … --pid host --cgroupns host …`                                      | When nothing should be installed on the host |

The script detects amd64 or arm64, checks the release's checksum (and its signature when
`cosign` is installed), installs two binaries in `/usr/bin` and their systemd units, and
starts them. The server shows in WatchLog within a minute; the page's checklist says when
its services, process groups and network map arrive.

```bash
# Upgrade to your WatchLog's version, keeping the configuration
curl -fsSL https://<your WatchLog>/install.sh | sudo sh -s -- --upgrade
# Remove everything: units, binaries, the watchlog user and /etc/watchlog
curl -fsSL https://<your WatchLog>/install.sh | sudo sh -s -- --uninstall
```

Supported: Ubuntu 20.04 and later, Debian 11 and later, RHEL, Rocky and Alma 8 and later,
Amazon Linux 2023, amd64 and arm64. Tested on Ubuntu 24.04, Debian 12 and Rocky 9 (SELinux
enforcing).

## What it runs as, and what it reads

- **Its own user, not root.** The agent runs as the user `watchlog` with exactly five
  capabilities: `CAP_BPF` and `CAP_PERFMON` (its eBPF programs), `CAP_SYS_PTRACE` (to see other
  users' processes), `CAP_DAC_READ_SEARCH` (their open sockets, pm2's files, the journal) and
  `CAP_SYS_RESOURCE` (eBPF maps on kernels before 5.11). The integrations collector has none.
- **What it reads:** `/proc`, the cgroups, systemd's unit states over D-Bus, pm2's pid and log
  files in each account's home (the home directories from `/etc/passwd`, nothing else of
  them), supervisord's configuration, and the Docker socket read-only when `watchlog` is in
  the `docker` group (the script adds it, and says so: that group can control Docker;
  `--no-docker` leaves it out, and containers don't show). With Podman, which has no `docker`
  group, the script and the packages give Podman's API socket to the group `watchlog` (a
  drop-in, `podman.socket.d/watchlog.conf`, removed on uninstall), with the same warning and
  the same `--no-docker`.
- **What never leaves the server:** command lines, arguments, environment values, user names
  and process ids. A process group is sent as its derived name only, with secrets redacted.
- The token is kept in `/etc/watchlog/agent.env`, mode 0640, owned by root and the `watchlog`
  group.

## Services, process groups and containers

**systemd services** are the units that run or failed: their state, CPU, memory against
`MemoryMax`, CPU throttling at `CPUQuota`, tasks, I/O, restarts, and every exit of their main
process with its code. The OS's own services (ssh, cron, journald…) are collected and folded
under **Show system services** on the server page.

**Process groups** are named by the first of these that applies:

1. your own rules (below);
2. pm2's apps, from pm2's pid files;
3. supervisord's programs;
4. PHP-FPM's pools (`pool www`);
5. gunicorn and uwsgi apps;
6. Java jars and main classes;
7. an interpreter's script (`python3 sync.py` is `sync.py`);
8. the executable.

A server shows at most 50 groups and 100 services; the rest are summed as "other processes".
A group inside a service (pm2's apps in `pm2-app.service`) is shown under it.

**Containers** are as on 0.8's Docker fleets, with their Compose project.

### Your own rules

**Settings → Clusters → your fleet → Process groups.** A rule matches on the executable's
name (a glob, `python*`), the systemd unit (a glob, `legacy-*.service`) and a pattern over the
arguments, and names the group; `$1`…`$9` are the pattern's captures:

| Executable | Unit               | Arguments  | Name     |
| ---------- | ------------------ | ---------- | -------- |
| `python*`  |                    | `-m (\w+)` | `py $1`  |
|            | `legacy-*.service` |            | `legacy` |

Rules come first, in order. **Try a process** previews a command line against them in the
browser; the agents evaluate them on the server, so command lines still never leave it. The
agents pick up a change within a minute.

## Crashes, exits and OOM kills

WatchLog sees every process exit from the kernel (eBPF, `sched_process_exit`): its exit code
or signal, and whether the OOM killer chose it, for services and process groups alike, with
or without systemd. A **crash loop** is three failed exits or restarts in ten minutes. A
**release** is the executable replaced on disk: it is marked on the workload's timeline and
checked as a cause.

## Alerts and probable cause

Every Server fleet has these default rules, which you can tune or turn off in **Alerts**:

| Rule                          | When                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| Service failed                | systemd marks a service failed, for 1 minute                             |
| Service crash-looping         | more than 2 crashes or restarts in 10 minutes                            |
| Process group crash-looping   | more than 2 failed exits in 10 minutes                                   |
| Service / process OOM-killed  | an OOM kill                                                              |
| Process group gone            | no process left of a group that ran at least 10 minutes in the last hour |
| Service near its memory limit | above 90 % of `MemoryMax` for 5 minutes                                  |
| Service CPU-throttled         | throttled more than 25 % of the time at `CPUQuota` for 15 minutes        |
| Server memory high            | above 90 % for 10 minutes                                                |
| Node CPU high, disk usage     | as on Kubernetes nodes                                                   |

A workload's page answers **why**: likely the release (its executable changed just before
the first crash), memory (OOM-killed at its limit, or the server ran low), a dependency whose
connections fail, or its CPU limit, with what was checked.

## Logs on demand

The workload page reads a service's journal (`journalctl -u <unit>`), a pm2 app's or
supervisord program's log files, or a container's log, only when you ask. Lines are redacted
on the server and never stored. A process started by hand has no log WatchLog can read: run it
as a systemd service to get its logs here.

## Applications

Services installed with apt or dnf (PostgreSQL, MariaDB, MySQL, Redis, MongoDB, RabbitMQ,
Kafka, nginx, Traefik and [PHP-FPM](integrations/php-fpm.md)) are offered under
**Applications → Found N services** by their unit's name. The server's own collector reads them
on `127.0.0.1`. Nothing is contacted until you press **Monitor**.

## Network map, Egress and What changed

Connections are attributed to the service or process group that opens them, with HTTP
requests and latency for plain HTTP/1.x. They need Linux 5.8 or newer with BTF (Ubuntu 20.10,
Debian 11 and RHEL 8.2 on). Egress and What changed include services and process groups.

## Troubleshooting

```bash
systemctl status watchlog-agent watchlog-integrations
journalctl -u watchlog-agent -n 50 --no-pager
```

- **"No eBPF" on the map:** the kernel is older than 5.8 or has no BTF. Everything else works.
- **No services, only processes:** the server doesn't run systemd (Alpine, OpenRC). Use the
  `docker run` command; crashes still show from the kernel.
- **Some processes are "other processes":** add a rule to name the ones you care about.
- **An old cgroup v1 server (CentOS 7, Ubuntu 18.04):** best effort; per-service CPU
  throttling doesn't show.
- **Behind a proxy:** add `HTTPS_PROXY=http://proxy:3128` to `/etc/watchlog/agent.env`, then
  `systemctl restart watchlog-agent`.
