# PROTOTYPE (beeline-2zej.4). Writes site/data.js: the staff list of plants to work (from the communique targets),
# iNat phenology per genus and atlas, our weekly sample counts, and the communique events.
import json, glob, sys
comm = sys.argv[1] if len(sys.argv) > 1 else '../../data/communiques'
ALL = ['OR', 'WA', 'ID', 'BC', 'NM']
inat = json.load(open('inat.json'))
plants = {}
for f in sorted(glob.glob(comm + '/batch*-targets.jsonl')):
    for line in open(f):
        if not line.strip(): continue
        t = json.loads(line)
        if not t.get('plant') or not t['plant'][0].isupper(): continue
        g = t['plant'].split()[0]
        regs = [r for r in (t.get('regions') or []) if r in ALL] or ALL
        p = plants.setdefault(g, {'g': g, 'atlases': set(), 'bees': [], 'notes': []})
        p['atlases'] |= set(regs)
        for b in t.get('bees') or []:
            if b not in p['bees']: p['bees'].append(b)
        note = {'plant': t['plant'], 'why': t.get('why') or '', 'by': t.get('source'), 'date': t['date'], 'bees': t.get('bees') or [], 'atlases': regs if t.get('regions') else []}
        if not any(n['why'] == note['why'] and n['plant'] == note['plant'] for n in p['notes']): p['notes'].append(note)
out = []
for p in plants.values():
    tx = inat['taxa'].get(p['g'])
    p['taxon'] = tx and tx['id']; p['common'] = tx and tx['common']
    p['atlases'] = sorted(p['atlases']); p['notes'].sort(key=lambda n: n['date'], reverse=True)
    out.append(p)
ours = {}
for r in json.load(open('ours-weekly.json')):
    ours.setdefault(r['g'] + '|' + r['a'], {})[str(r['w'])] = r['s']
keep = {p['g'] + '|' + a for p in out for a in p['atlases']}
ours = {k: v for k, v in ours.items() if k in keep}
events = json.load(open('events.json'))
data = {'plants': sorted(out, key=lambda p: p['g']), 'inat': {'flowering': inat['flowering'], 'all': inat['all']}, 'ours': ours, 'events': events}
open('site/data.js', 'w').write('window.PLAN = ' + json.dumps(data, separators=(',', ':')) + ';\n')
print(len(out), 'plants;', len(events), 'events;', len(inat['all']), 'histograms')
