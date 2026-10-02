#!/usr/bin/env python3
"""JSON-RPC failover proxy: the paid RPC first, public ones only when it refuses.

Every Base consumer on the box (executor, gateway, all ASP generations) pointed straight at one
paid dRPC URL. When that account ran out of credit (2026-10-02) each call came back 403 "User
balance exceeded" and screening, admission, relaying and key purchase all failed together. They
now point here instead, so the choice of upstream lives in one place.

RPC_UPSTREAMS is an ordered, comma-separated list: the first is the primary. A request goes to
the first upstream that is not cooling down; any non-200 status or transport error marks that
upstream down for RPC_COOLDOWN_SEC and the request moves to the next. After the cooldown the
primary is tried again, so it takes over by itself once it is healthy (recharged).

A 200 that carries a JSON-RPC error (a reverted eth_call, say) is the chain's answer, not an
upstream failure, and is returned as is.

Stdlib only. Logs name upstreams by HOST — the URL path can carry an API key.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALL_FAILED = json.dumps(
    {"jsonrpc": "2.0", "id": None, "error": {"code": -32000, "message": "all RPC upstreams failed"}}
).encode()


class Failover:
    def __init__(self, upstreams, cooldown=30.0, timeout=20.0):
        if not upstreams:
            raise ValueError("RPC_UPSTREAMS is empty")
        self.upstreams = upstreams
        self.cooldown = cooldown
        self.timeout = timeout
        self._down_until = [0.0] * len(upstreams)
        self._lock = threading.Lock()
        self.active = 0  # index of the upstream that answered last (for the health line)

    def host(self, i):
        return urllib.parse.urlparse(self.upstreams[i]).netloc

    def _mark_down(self, i, why):
        with self._lock:
            was_up = self._down_until[i] <= time.time()
            self._down_until[i] = time.time() + self.cooldown
        if was_up:  # one line per outage, not one per request
            print(f"[rpc-failover] {self.host(i)} down ({why}); cooling {self.cooldown:.0f}s", flush=True)

    def forward(self, body, content_type):
        """(status, body) from the first upstream that answers 200, else the last failure."""
        now = time.time()
        n = len(self.upstreams)
        # Everything cooling down is not a reason to refuse: try them all rather than fail blind.
        order = [i for i in range(n) if self._down_until[i] <= now] or list(range(n))
        last = (502, ALL_FAILED)
        for i in order:
            req = urllib.request.Request(
                self.upstreams[i],
                data=body,
                headers={"Content-Type": content_type or "application/json", "User-Agent": "siphon-rpc-failover"},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    data = r.read()
                    if r.status == 200:
                        if self.active != i:
                            print(f"[rpc-failover] serving from {self.host(i)}", flush=True)
                            self.active = i
                        return 200, data
                    last = (r.status, data)
                    self._mark_down(i, f"HTTP {r.status}")
            except urllib.error.HTTPError as e:
                last = (e.code, e.read() or ALL_FAILED)
                # 400/413 mean THIS request was refused (public RPCs cap eth_getLogs ranges), not
                # that the upstream is unhealthy: try the next one, but keep this one in rotation.
                if e.code not in (400, 413):
                    self._mark_down(i, f"HTTP {e.code}")
            except Exception as e:  # timeout, DNS, connection reset
                self._mark_down(i, type(e).__name__)
        return last


def make_handler(fo):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status, body):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._send(*fo.forward(body, self.headers.get("Content-Type")))

        def do_GET(self):  # health check: which upstream is serving
            self._send(200, json.dumps({"ok": True, "active": fo.host(fo.active), "primary": fo.host(0)}).encode())

        def log_message(self, *args):  # one line per request would drown the outage lines
            pass

    return Handler


def main():
    upstreams = [u.strip() for u in os.environ.get("RPC_UPSTREAMS", "").split(",") if u.strip()]
    fo = Failover(
        upstreams,
        cooldown=float(os.getenv("RPC_COOLDOWN_SEC", "30")),
        timeout=float(os.getenv("RPC_TIMEOUT_SEC", "20")),
    )
    port = int(os.getenv("PORT", "8545"))
    print(f"[rpc-failover] :{port} -> " + " , ".join(fo.host(i) for i in range(len(upstreams))), flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), make_handler(fo)).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
