import os, json, urllib.request
tok = os.environ.get('ASP_SCREEN_TOKEN', '')
req = urllib.request.Request(
    'https://solasp-production.up.railway.app/solana/publish-roots',
    data=json.dumps({'chainId': 900002}).encode(),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok},
    method='POST',
)
try:
    print(urllib.request.urlopen(req, timeout=120).read().decode()[:800])
except Exception as e:
    body = e.read().decode() if hasattr(e, 'read') else str(e)
    print('code', getattr(e, 'code', None))
    print(body[:800])
