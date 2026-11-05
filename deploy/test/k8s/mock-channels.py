#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Stand-in for Slack, Telegram and webhook receivers in the alerting e2e (ADR-082).

Records every POST; GET /requests returns them. Telegram's getMe, sendMessage and
getUpdates are answered like the Bot API; POST /telegram/updates queues a message
(used to send the deep link's /start code). Standard library only.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
requests = []
updates = []


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/requests":
            with lock:
                return self._send(200, requests)
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        try:
            body = json.loads(raw or b"null")
        except ValueError:
            body = None
        if self.path == "/telegram/updates":
            with lock:
                updates.append({"update_id": len(updates) + 1, "message": body})
            return self._send(200, {"ok": True})
        with lock:
            requests.append({"path": self.path, "headers": dict(self.headers), "json": body})
        if self.path.startswith("/bot"):
            method = self.path.rsplit("/", 1)[-1]
            if method == "getMe":
                result = {"id": 1, "is_bot": True, "username": "watchlog_e2e_bot"}
            elif method == "getUpdates":
                offset = (body or {}).get("offset", 0)
                with lock:
                    result = [u for u in updates if u["update_id"] >= offset]
            else:
                result = {"message_id": len(requests)}
            return self._send(200, {"ok": True, "result": result})
        self._send(200, {"ok": True})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
