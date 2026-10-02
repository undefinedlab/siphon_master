"""Run: python rpc-failover/test_rpc_failover.py   (stdlib only, no network)"""
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rpc_failover import Failover, make_handler


def stub(status, body, hits):
    """A fake upstream on a free port. `status` is a one-item list so a test can flip it."""

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            hits.append(1)
            self.send_response(status[0])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}/base/SECRETKEY"


REQ = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}).encode()
paid_status, paid_hits, pub_hits = [403], [], []
paid = stub(paid_status, b'{"error":{"message":"User balance exceeded","code":10}}', paid_hits)
pub = stub([200], b'{"jsonrpc":"2.0","id":1,"result":"0x10"}', pub_hits)
fo = Failover([paid, pub], cooldown=0.3, timeout=2)

# Paid RPC out of credit -> the public one answers.
assert fo.forward(REQ, "application/json") == (200, b'{"jsonrpc":"2.0","id":1,"result":"0x10"}')
assert (len(paid_hits), len(pub_hits)) == (1, 1)

# While cooling down, the dead primary is not asked again.
fo.forward(REQ, None)
assert (len(paid_hits), len(pub_hits)) == (1, 2), "primary must be skipped during its cooldown"

# Recharged: after the cooldown the primary takes over by itself and the fallback goes quiet.
paid_status[0] = 200
time.sleep(0.35)
fo.forward(REQ, None)
assert (len(paid_hits), len(pub_hits)) == (2, 2), "primary must be retried, and win, after the cooldown"
assert fo.active == 0

# A 200 carrying a JSON-RPC error is the chain's answer: returned as is, no failover.
rev_hits, pub2_hits = [], []
reverted = stub([200], b'{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}', rev_hits)
fo2 = Failover([reverted, stub([200], b"{}", pub2_hits)], cooldown=0.3, timeout=2)
status, body = fo2.forward(REQ, None)
assert status == 200 and b"execution reverted" in body and pub2_hits == []

# Everything down -> the last upstream's own failure comes back, not a hang or a fake success.
fo3 = Failover([stub([429], b"slow down", []), "http://127.0.0.1:9/"], cooldown=0.3, timeout=1)
assert fo3.forward(REQ, None)[0] in (429, 502)
assert fo3.forward(REQ, None)[0] in (429, 502), "all cooling down must still be tried, not refused blind"

# A 413 is about one oversized request (public RPCs cap eth_getLogs ranges): the next upstream is
# tried, but the refusing one stays in rotation for the requests it can serve.
big_hits, ok_hits = [], []
fo4 = Failover([stub([413], b"too large", big_hits), stub([200], b'{"result":"0x1"}', ok_hits)], cooldown=30, timeout=2)
assert fo4.forward(REQ, None)[0] == 200 and fo4.forward(REQ, None)[0] == 200
assert (len(big_hits), len(ok_hits)) == (2, 2), "a 413 must not put the upstream in cooldown"

# Through the real HTTP handler, and the key never appears in what the proxy reports.
srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Failover([pub], cooldown=0.3, timeout=2)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_port}/"
out = urllib.request.urlopen(urllib.request.Request(url, data=REQ, headers={"Content-Type": "application/json"})).read()
assert json.loads(out)["result"] == "0x10"
health = urllib.request.urlopen(url).read().decode()
assert "SECRETKEY" not in health and json.loads(health)["ok"] is True

print("rpc_failover: OK — falls back on 403, skips a cooling primary, returns to it once healthy, "
      "passes JSON-RPC errors through, never reports the key")
