#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Phase 3 acceptance on a cluster installed with `helm install` (SPEC §13, ADR-086).

Adds one channel of each type pointing at the in-cluster mocks (alert-mocks.sh):
Slack, Telegram (connected through the deep link), email (Mailpit) and a webhook.
Sends a test to each, starts a crash-looping Deployment, and checks that every
channel gets exactly one firing and one resolve message for it after the Deployment
is deleted. The alert-worker must be running (ADR-088).

  deploy/test/k8s/alert-acceptance.py --context kind-watchlog --url http://localhost:8080 \
      --email admin@example.com --password '...'
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from acceptance import Api, check, kubectl, results

MOCKS = "wl-alert-mocks"
NS = "wl-alert"
WORKLOAD = "crashy"
WHERE = f"{NS}/{WORKLOAD} (Deployment)"
RECIPIENT = "oncall@e2e.test"
CRASHY = f"""
apiVersion: v1
kind: Namespace
metadata: {{ name: {NS} }}
---
apiVersion: apps/v1
kind: Deployment
metadata: {{ name: {WORKLOAD}, namespace: {NS} }}
spec:
  selector: {{ matchLabels: {{ app: {WORKLOAD} }} }}
  template:
    metadata: {{ labels: {{ app: {WORKLOAD} }} }}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: busybox:1.37
          command: [sh, -c, "echo starting; sleep 1; exit 1"]
"""


def port_forward(ctx, svc, local, remote):
    proc = subprocess.Popen(
        ["kubectl", "--context", ctx, "-n", MOCKS, "port-forward", f"svc/{svc}", f"{local}:{remote}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(3)
    return proc


def http_json(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    if data:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read() or b"null")


def wait(_what, fn, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(5)
    return None


class Messages:
    """What each mock channel received about the crashy workload, as (kind) lists."""

    def __init__(self, mock_url, mailpit_url):
        self.mock_url = mock_url
        self.mailpit_url = mailpit_url

    def all(self):
        reqs = http_json(f"{self.mock_url}/requests")
        out = {"slack": [], "telegram": [], "webhook": [], "email": []}
        for r in reqs:
            body = r.get("json") or {}
            text = json.dumps(body)
            if WHERE not in text and f'"workload": "{WORKLOAD}"' not in text:
                continue
            if r["path"].startswith("/slack/"):
                out["slack"].append("resolved" if "RESOLVED" in body.get("text", "") else "firing")
            elif r["path"].endswith("/sendMessage"):
                out["telegram"].append("resolved" if "RESOLVED" in body.get("text", "") else "firing")
            elif r["path"] == "/webhook":
                out["webhook"].append(body.get("event"))
        q = urllib.parse.quote(f'to:"{RECIPIENT}" subject:"{WORKLOAD}"')
        mails = http_json(f"{self.mailpit_url}/api/v1/search?query={q}")["messages"]
        for m in reversed(mails):
            out["email"].append("resolved" if m["Subject"].startswith("[RESOLVED]") else "firing")
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--context", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    args = ap.parse_args()
    ctx = args.context

    api = Api(args.url)
    if api.call("POST", "/auth/login", {"email": args.email, "password": args.password})[0] != 200:
        sys.exit("login failed")
    status = wait("worker", lambda: api.get("/alerting/status")["running"] or None, 120)
    check("the alert-worker runs (heartbeat within 2 min)", status)
    # Settings made in the UI (alerts redesign): the public address and the email server.
    status, _ = api.call("PUT", "/settings/general", {"publicUrl": args.url})
    check("public address set in Settings → General", status == 200, f"HTTP {status}")
    smtp = {"host": f"mailpit.{MOCKS}", "port": 1025, "security": "none", "username": "",
            "from": "WatchLog e2e <alerts@e2e.test>"}
    status, res = api.call("POST", "/settings/smtp/test", smtp)
    check("email server tested from the UI (test email delivered)", status == 200 and res and res["ok"], json.dumps(res))
    status, _ = api.call("PUT", "/settings/smtp", smtp)
    check("email server saved from the UI", status == 200 and api.get("/alerting/status")["smtpConfigured"])
    reach = api.get("/settings/telegram/reachability")
    check("Telegram API reachable (mock)", reach["reachable"], json.dumps(reach))

    mock_pf = port_forward(ctx, "mock-channels", 18090, 8080)
    mail_pf = port_forward(ctx, "mailpit", 18025, 8025)
    try:
        run(api, ctx, Messages("http://127.0.0.1:18090", "http://127.0.0.1:18025"))
    finally:
        mock_pf.terminate()
        mail_pf.terminate()
        kubectl(ctx, "delete", "namespace", NS, "--wait=false", check_rc=False)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


def run(api, ctx, msgs):
    # A clean slate: earlier runs' channels go, so every rule gets exactly these four.
    for ch in api.get("/alert-channels")["channels"]:
        api.call("DELETE", f"/alert-channels/{ch['id']}")
    mock = f"http://mock-channels.{MOCKS}:8080"
    specs = [
        ("slack", {"webhookUrl": f"{mock}/slack/T0/B0/e2e"}),
        ("telegram", {"botToken": "123456:E2eFakeTokenForTheMockServer"}),
        ("email", {"recipients": [RECIPIENT]}),
        ("webhook", {"url": f"{mock}/webhook"}),
    ]
    channels = {}
    for kind, settings in specs:
        status, body = api.call("POST", "/alert-channels", {
            "type": kind, "name": f"e2e {kind}", "settings": settings, "useForAllRules": True,
        })
        if not check(f"add a {kind} channel", status == 201, f"HTTP {status}"):
            return
        channels[kind] = body
    # Telegram: the deep link's code, sent as the user would by pressing Start.
    code = re.search(r"start=([\w-]+)$", channels["telegram"]["connect"]["link"]).group(1)
    http_json(f"{msgs.mock_url}/telegram/updates", {
        "text": f"/start {code}", "chat": {"id": 4242, "type": "private", "first_name": "e2e"},
    })
    tg_id = channels["telegram"]["channel"]["id"]
    connected = wait("telegram", lambda: next(
        (c for c in api.get("/alert-channels")["channels"] if c["id"] == tg_id and c["config"].get("connected")), None), 60)
    check("Telegram chat connected through the deep link", connected)
    for kind, ch in channels.items():
        status, res = api.call("POST", f"/alert-channels/{ch['channel']['id']}/test")
        check(f"send test: {kind}", status == 200 and res and res["ok"], json.dumps(res))

    subprocess.run(["kubectl", "--context", ctx, "apply", "-f", "-"], input=CRASHY, text=True,
                   check=True, capture_output=True)
    t0 = time.time()

    def alert(state):
        for a in api.get("/alerts" + ("?view=history" if state == "resolved" else ""))["alerts"]:
            if a["labels"].get("workload") == WORKLOAD and a["rule"]["key"] == "k8s.pod.crashloop" and a["state"] == state:
                return a
        return None

    fired = wait("firing", lambda: alert("firing"), 420)
    check("CrashLoopBackOff alert fires for the crashing Deployment", fired,
          f"after {time.time() - t0:.0f} s (rule duration 2 min)" if fired else "not within 7 min")
    if not fired:
        return
    check("the alert says what is wrong in plain words", fired["title"] == f"{WORKLOAD} is crash-looping",
          f"{fired['title']!r} / {fired['why']!r}")
    got = wait("firing messages", lambda: (lambda m: m if all("firing" in v for v in m.values()) else None)(msgs.all()), 120)
    check("a firing message reached every channel", got, json.dumps(msgs.all()))

    kubectl(ctx, "-n", NS, "delete", "deployment", WORKLOAD, "--wait=false")
    t1 = time.time()
    resolved = wait("resolved", lambda: alert("resolved"), 240)
    check("the alert resolves after the Deployment is deleted", resolved,
          f"after {time.time() - t1:.0f} s" if resolved else "not within 4 min")
    wait("resolve messages", lambda: (lambda m: m if all("resolved" in v for v in m.values()) else None)(msgs.all()), 120)
    time.sleep(70)  # nothing else may follow: no repeat, no late firing (ADR-090)
    final = msgs.all()
    for kind in ("slack", "telegram", "email", "webhook"):
        check(f"{kind}: exactly one firing and one resolve message", final[kind] == ["firing", "resolved"],
              str(final[kind]))
    detail = api.get(f"/alerts/{fired['id']}")
    sent = [n for n in detail["notifications"] if n["status"] == "sent"]
    check("the alert's history lists 8 delivered messages", len(sent) == 8, f"{len(sent)} sent")


if __name__ == "__main__":
    main()
