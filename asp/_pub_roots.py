import os, json, urllib.request
tok = os.environ.get('ASP_SCREEN_TOKEN', '')
print('has_token', bool(tok), 'len', len(tok))
req = urllib.request.Request(
    'http://127.0.0.1:5056/solana/publish-roots' if False else 'https://solasp-production.up.railway.app/solana/publish-roots',
    data=json.dumps({'chainId': 900002}).encode(),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print(r.read().decode()[:1200])
except Exception as e:
    body = b''
    if hasattr(e, 'read'):
        try: body = e.read()
        except Exception: pass
    print('code', getattr(e, 'code', None))
    print((body.decode('utf-8', 'replace') if body else str(e))[:1200])
