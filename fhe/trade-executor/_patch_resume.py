import json, os
import sqlalchemy as sa

outp = '_recover_out.txt'
def w(msg):
    with open(outp, 'a', encoding='utf-8') as f:
        f.write(msg + '\n')
    print(msg, flush=True)
open(outp, 'w').close()

uri = os.environ.get('DATABASE_URI') or os.environ.get('DATABASE_URL')
w('has_db=' + str(bool(uri)))
w('pool=' + str(os.getenv('METEORA_POOL')))
eng = sa.create_engine(uri)
with eng.begin() as conn:
    row = conn.execute(sa.text('select id,status,strategy_type,settlement,execution_error from strategy where id=:id'), {'id': '005ba56e-3b1e-4304-8b25-3b7aafa18410'}).mappings().first()
    w('status=' + str(row['status']))
    w('type=' + str(row['strategy_type']))
    w('err=' + str(row['execution_error'] or '')[:200])
    raw = json.loads(row['settlement'] or '{}')
    resume = dict(raw.get('resume') or {})
    resume.update(stage='SWAPPED', amount_out='326143', mint_out='DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie')
    resume.pop('deposit', None)
    new_settlement = json.dumps({'resume': resume, 'recovered': 'circle_to_dteu'})
    conn.execute(sa.text('update strategy set status=:st, settlement=:se where id=:id'), {'st': 'SETTLING', 'se': new_settlement, 'id': row['id']})
    w('patched amount_out=326143')
