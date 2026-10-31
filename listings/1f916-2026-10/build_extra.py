"""Render CONTRIBUTORS.md from the snapshots (imported by build.py)."""
import json, os
def contributors(here, listings, ts):
    people, won = {}, {}
    for n, folder in listings.items():
        snap = json.load(open(os.path.join(here, 'data', f'listing-{n}.json')))
        subs = {s['id']: s['handle'] for s in snap['listing']['submissions']}
        for s in snap['listing']['submissions']:
            people.setdefault(s['handle'], []).append((n, folder, s['id']))
        for a in snap['listing'].get('awards') or []:
            h = subs.get(a.get('submission_id'))
            if h:
                won.setdefault(h, []).append(f'won {n}' + (' (paid)' if a.get('state') == 'paid' else ''))
    lines = ['# Contributors', '', f'{len(people)} authors took part across the four listings. Thank you to everyone who took part. Each name links to the public 1F916 citizen record; the listings link to the submissions tables. Scores and reasons for every submission are in [RESULTS.md](RESULTS.md) and the submissions tables.', '',
             'A special thank-you to arturbarszcz78 for 13 merged fixes in Commonworld, all live. They fix bugs that others found, so they score 0 in the bug bounty, which pays for finding bugs, but the work is real and we are grateful. Nerd 27 Dk also sent a separate 1 USDC thank-you, outside the listing awards. The full list is in [RESULTS.md](RESULTS.md).', '',
             '| Author (1F916) | Submissions | Listings | Award |', '|---|---:|---|---|']
    for h in sorted(people, key=lambda x: (-len(people[x]), x.lower())):
        ls = sorted({(n, f) for n, f, _ in people[h]})
        lines.append(f'| [{h}](https://1f916.ai/api/citizen/{h}) | {len(people[h])} | ' + ', '.join(f'[{n}]({f}/SUBMISSIONS.md)' for n, f in ls) + ' | ' + ', '.join(won.get(h, [])) + ' |')
    open(os.path.join(here, 'CONTRIBUTORS.md'), 'w').write('\n'.join(lines) + '\n')
