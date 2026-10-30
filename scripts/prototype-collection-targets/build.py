import json, glob, sys
d = 'communiques/'
targets = []
for f in sorted(glob.glob('../../data/communiques/batch*-targets.jsonl')):
    for line in open(f):
        line = line.strip()
        if not line: continue
        t = json.loads(line)
        t['regions'] = [r for r in (t.get('regions') or []) if r in ('OR','WA','ID','BC','NM')]
        t['months'] = [int(m) for m in (t.get('months') or [])]
        t['bees'] = t.get('bees') or []
        t['links'] = t.get('links') or []
        targets.append(t)
# the communiques repeat a target for weeks: keep the latest wording, remember every date it ran
merged = {}
for t in sorted(targets, key=lambda t: t['date']):
    k = ((t.get('plant') or '').lower(), tuple(sorted(t['bees'])), tuple(sorted(t['regions'])))
    if k in merged:
        m = merged[k]; m['dates'].append(t['date']); m['months'] = sorted(set(m['months']) | set(t['months']))
        m['links'] = list(dict.fromkeys(m['links'] + t['links'])); m.update(why=t['why'], source=t['source'] or m['source'], date=t['date'])
    else:
        t['dates'] = [t['date']]; merged[k] = t
targets = sorted(merged.values(), key=lambda t: t['date'], reverse=True)
regions = [{'id': r['id'], 'st': r['state'], 'name': r['name'], 'geom': r['g'] if isinstance(r['g'], dict) else json.loads(r['g'])} for r in json.load(open('out/regions.json'))]
plants = json.load(open('out/plants.json'))
bees = json.load(open('out/bees.json'))
effort = json.load(open('out/effort.json'))
cpm = [[x['r'], x['g'], x['m'], x['s'], x['s26']] for x in json.load(open('out/cpm.json'))]
for p in plants: p.pop('regs', None)
data = dict(regions=regions, plants=plants, bees=bees, effort=effort, cpm=cpm, targets=targets)
s = json.dumps(data, separators=(',', ':'))
html = open('page.html').read().replace('/*DATA*/null', s)
open('out/collection-targets.html', 'w').write(html)
print(len(targets), 'targets;', round(len(html)/1e6, 2), 'MB')
