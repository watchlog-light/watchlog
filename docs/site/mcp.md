---
title: Ask your cluster (MCP)
description: Connect Claude Code, Claude Desktop, ChatGPT or Cursor to WatchLog and ask about your Kubernetes clusters and Docker hosts.
---

# Ask your cluster

WatchLog has a built-in [MCP](https://modelcontextprotocol.io) server. Connect your AI
assistant to it, and you can ask questions like:

- "What's wrong with my clusters?"
- "Why does the cart pod keep restarting?"
- "Which containers on docker-01 were killed for memory today?"
- "Did anything change right before the errors started?"

The assistant answers from what WatchLog sees: problems and alerts, pods and containers,
exit codes and OOM kills, events, recent rollouts, the service map and metrics. It works
for **Kubernetes clusters** and **Docker hosts** alike.

WatchLog doesn't run an AI model itself. It only answers the questions your assistant asks
through MCP. Nothing about your clusters leaves WatchLog unless you connect a client.

## Try it on the live demo

The [live demo](https://demo.watchlog.io/demo) has a public, read-only token. In a terminal
with [Claude Code](https://claude.com/claude-code):

```bash
claude mcp add --transport http watchlog-demo https://demo.watchlog.io/mcp \
  --header "Authorization: Bearer wl_pat_demoWafe1IZZ5LgmkIMrbhhfs932B8pd75Lr8P4fomh"
```

Then ask "What's wrong with this cluster?". The demo token reads only the sample cluster.
It allows 30 tool calls a minute per visitor and 600 a minute in total.

## Connect your WatchLog

You need:

- **A personal API token.** In WatchLog, open **Settings → API tokens** and choose
  **Create token**. Use one token per app, so you can revoke one without breaking the others.
- **WatchLog's address,** reachable from the machine your assistant runs on. That's the
  address in **Settings → General → Public address**. If WatchLog is only on a private
  network, connect through a VPN or a tunnel first.

The MCP server is at `<your address>/mcp`, for example `https://watchlog.example.com/mcp`.
After you create a token, WatchLog shows the setup for each app below with your address and
token filled in.

### Claude Code

```bash
claude mcp add --transport http watchlog https://watchlog.example.com/mcp \
  --header "Authorization: Bearer wl_pat_..."
```

### Claude Desktop

Claude Desktop connects through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote),
which needs Node.js. Open **Settings → Developer → Edit config** and add:

```json
{
  "mcpServers": {
    "watchlog": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://watchlog.example.com/mcp",
        "--header",
        "Authorization: Bearer ${WATCHLOG_TOKEN}"
      ],
      "env": { "WATCHLOG_TOKEN": "wl_pat_..." }
    }
  }
}
```

Restart Claude Desktop. The token stays in the environment variable, out of the
command line.

### ChatGPT

The ChatGPT desktop app and the Codex CLI read their MCP servers from
`~/.codex/config.toml`. Add:

```toml
[mcp_servers.watchlog]
url = "https://watchlog.example.com/mcp"
bearer_token_env_var = "WATCHLOG_TOKEN"
```

Then set `WATCHLOG_TOKEN` to your token in the environment the app starts from. If the app
doesn't see the variable, put the header in the file instead:

```toml
[mcp_servers.watchlog]
url = "https://watchlog.example.com/mcp"
http_headers = { "Authorization" = "Bearer wl_pat_..." }
```

Restart the app, and WatchLog shows up under **Settings → MCP servers**.

ChatGPT on the web adds MCP apps in developer mode. Those apps sign in with OAuth, which
WatchLog doesn't offer yet, so use the desktop app or Codex for now.

From your own code, OpenAI's Responses API takes WatchLog as a remote MCP server:
`{"type": "mcp", "server_label": "watchlog", "server_url": "https://watchlog.example.com/mcp", "authorization": "wl_pat_..."}`.

### Cursor

Add to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "watchlog": {
      "url": "https://watchlog.example.com/mcp",
      "headers": { "Authorization": "Bearer wl_pat_..." }
    }
  }
}
```

### Other clients

Any MCP client that supports Streamable HTTP and a custom header works. Send
`Authorization: Bearer <token>`. WatchLog speaks the 2026-07-28 protocol, and the
2025 versions (2025-11-25, 2025-06-18, 2025-03-26) for clients that haven't moved yet.

## What the assistant can do

Every tool is read-only. Each takes the cluster by name, and answers in that cluster's
words: namespaces, workloads and pods on Kubernetes; hosts, Compose projects and containers
on Docker.

| Tool                 | Kubernetes                                                               | Docker                                                        |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `list_clusters`      | Your clusters, their kind and whether they report                        | The same                                                      |
| `get_problems`       | What needs attention: crash loops, OOM kills, nodes, connections, alerts | Restarting, unhealthy, OOM-killed or exited containers, hosts |
| `list_alerts`        | Firing or recent alerts                                                  | The same                                                      |
| `explain_alert`      | An alert with its pod's state, events and the changes before it          | The same for a container or Compose service                   |
| `get_workload`       | A Deployment, StatefulSet, DaemonSet, Job or CronJob and its pods        | A Compose service and its containers                          |
| `get_pod`            | A pod: containers, exit codes, OOM kills, restarts, events               | A container                                                   |
| `get_node`           | A node: conditions, capacity against use, the heaviest pods              | A host                                                        |
| `get_service_map`    | Failing connections, or one workload's connections and DNS errors        | The same between containers                                   |
| `get_events`         | Warning events, grouped                                                  | Container deaths, OOM kills, health changes                   |
| `get_recent_changes` | Rollouts, image changes, scaling, nodes                                  | Re-created containers, image changes                          |
| `query_metric`       | A metric over up to 24 hours, as statistics                              | The same                                                      |

Two prompts start an investigation for you: `investigate_problem` and `why_is_it_crashing`.

**Limits:**

- **Tool calls:** 60 a minute per token.
- **Answer size:** at most 16 KB each, with a fixed number of items. When an answer is
  cut, it says so, and which argument narrows it (for example "pass `namespace`").
- **Metrics:** at most 24 hours, 10 series and 60 points per series.

## Security

- **Read only.** A token can't change anything in WatchLog or in your clusters, and no tool
  writes. The worst a misled assistant can do with WatchLog is read what your token reads.
- **What it never returns:** Secrets, environment variable values, request or response
  payloads, alert channel targets, email or Telegram settings, and tokens. WatchLog never
  collects most of these in the first place.
- **Cluster text is data.** Pod and container names, event messages, labels and images come
  from whoever runs workloads in your cluster. Someone could name a pod "ignore previous
  instructions…" to try to steer your assistant (prompt injection).
  - WatchLog returns such text only in its own fields, cleaned of control characters and
    cut to a fixed length.
  - Every tool tells the assistant to treat it as data.
  - Since the tools only read, an injected instruction can't make WatchLog do anything.
  - It could still try to steer the assistant's other tools in the same session. Review what
    your assistant does with those.
- **Your call log.** **Settings → API tokens → a token** shows its last 50 tool calls: the
  tool, a short summary of the arguments, the status, the time and the size, never the
  answer. Calls are kept 30 days.
- **Revoking** a token stops it at the next call.

## Turn it off

The MCP server is on by default, since it needs a token anyway. To turn it off, set
`mcp.enabled: false` in the Helm chart, or `WATCHLOG_MCP_ENABLED=false` with Docker Compose.
`/mcp` then answers 404. Tokens still work with the [REST API](api.md).

## Troubleshooting

| What you see                           | What to check                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 401                                    | The token is wrong, expired or revoked. Create a new one in Settings → API tokens.                                    |
| 404                                    | The address must end in `/mcp`, at WatchLog's address (not under `/api/v1`), or the MCP server is turned off.         |
| "Rate limited"                         | More than 60 tool calls a minute with this token. The answer says how many seconds to wait.                           |
| The client can't connect               | Open WatchLog's address in a browser on the same machine. If it doesn't load, connect a VPN or set up a tunnel first. |
| Claude Desktop shows no WatchLog tools | `npx` needs Node.js. Check **Settings → Developer** for the server's log.                                             |
