# Polite iNat fetch (about one request a second): genus taxa, then week-of-year histograms per genus and atlas place,
# both for observations annotated "Flowering" and for all verifiable observations.
import json, glob, time, urllib.request, urllib.parse, os, sys
PLACES = {'OR': 10, 'WA': 46, 'ID': 22, 'BC': 7085, 'NM': 9}
UA = {'User-Agent': 'beeline-prototype (rainhead)'}
def get(path, **q):
    url = 'https://api.inaturalist.org/v1/' + path + '?' + urllib.parse.urlencode(q)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                time.sleep(1.5); return json.load(r)
        except Exception as e:
            print('retry', url, e, file=sys.stderr); time.sleep(60 * (attempt + 1))
    raise SystemExit('gave up: ' + url)
ts = [json.loads(l) for f in glob.glob(sys.argv[1] + '/batch*-targets.jsonl') for l in open(f) if l.strip()]
pairs = set()
for t in ts:
    if not t.get('plant'): continue
    g = t['plant'].split()[0]
    if not g[0].isupper(): continue
    for r in [x for x in (t.get('regions') or []) if x in PLACES] or list(PLACES): pairs.add((g, r))
out = json.load(open('inat.json')) if os.path.exists('inat.json') else {'taxa': {}, 'flowering': {}, 'all': {}}
for g in sorted({g for g, _ in pairs}):
    if g in out['taxa']: continue
    res = [x for x in get('taxa', q=g, rank='genus', iconic_taxa='Plantae', per_page=5)['results'] if x['name'] == g]
    out['taxa'][g] = {'id': res[0]['id'], 'common': res[0].get('preferred_common_name'), 'family': None} if res else None
    json.dump(out, open('inat.json', 'w'))
import threading
from concurrent.futures import ThreadPoolExecutor
lock = threading.Lock()
def one(pair):
    g, r = pair; k = g + '|' + r; tx = out['taxa'].get(g)
    if not tx or k in out['all']: return
    base = dict(taxon_id=tx['id'], place_id=PLACES[r], interval='week_of_year', verifiable='true')
    fl = get('observations/histogram', term_id=12, term_value_id=13, **base)['results']['week_of_year']
    al = get('observations/histogram', **base)['results']['week_of_year']
    with lock:
        out['flowering'][k] = fl; out['all'][k] = al
        json.dump(out, open('inat.json', 'w'))
with ThreadPoolExecutor(1) as ex: list(ex.map(one, sorted(pairs)))
print('done', len(out['taxa']), len(out['all']))
