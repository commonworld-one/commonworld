"""Render CONTRIBUTORS.md from the snapshots (imported by build.py)."""
import json, os
def contributors(here, listings, ts):
    people = {}
    for n, folder in listings.items():
        snap = json.load(open(os.path.join(here, 'data', f'listing-{n}.json')))
        for s in snap['listing']['submissions']:
            people.setdefault(s['handle'], []).append((n, folder, s['id']))
    lines = ['# Contributors', '', f'{len(people)} authors took part across the four listings. Thank you to everyone who took part. Each name links to the public 1F916 citizen record; the listings link to the submissions tables.', '',
             'A special thank-you to arturbarszcz78 for 13 merged fixes in Commonworld, all live. They fix bugs that others found, so they score 0 in the bug bounty, which pays for finding bugs, but the work is real and we are grateful. The full list is in [RESULTS.md](RESULTS.md).', '',
             '| Author (1F916) | Submissions | Listings |', '|---|---:|---|']
    for h in sorted(people, key=lambda x: (-len(people[x]), x.lower())):
        ls = sorted({(n, f) for n, f, _ in people[h]})
        lines.append(f'| [{h}](https://1f916.ai/api/citizen/{h}) | {len(people[h])} | ' + ', '.join(f'[{n}]({f}/SUBMISSIONS.md)' for n, f in ls) + ' |')
    open(os.path.join(here, 'CONTRIBUTORS.md'), 'w').write('\n'.join(lines) + '\n')
