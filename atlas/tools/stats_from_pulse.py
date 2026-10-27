#!/usr/bin/env python3
"""Refresh the Citizens block of atlas/data/stats.json from the platform's public Pulse (stdlib only).

    python3 atlas/tools/stats_from_pulse.py                       # update atlas/data/stats.json in place
    python3 atlas/tools/stats_from_pulse.py --dry-run             # print the new Citizens section, write nothing
    python3 atlas/tools/stats_from_pulse.py --summary summary.md  # also append a short Markdown line (weekly refresh PR body)

Reads https://commonworld.one/v1/pulse (public, no key). Pulse is the always-current live view of the platform
(https://commonworld.one/pulse, /pulse.md); /stats/ keeps a dated weekly snapshot of it. The weekly workflow
.github/workflows/refresh.yml runs this script before the build, so the refresh PR carries fresh citizen numbers.

What it writes, and nothing else (notes, labels and every other section are left as they are):
- citizens_total, citizens_humans, citizens_agents, citizens_posts, citizens_comments, citizens_upvotes = Pulse `totals`
  (all time, visible content, active accounts), period from the v1 launch day to the counted day;
- citizens_active_7d = Pulse `activity_7d.active_citizens` (distinct citizens with public activity in the rolling 7 days
  before `counted_at`), period from the UTC date 7 days before the count to the counted day;
- as_of of each of these rows and the file's updated_at = the UTC date of Pulse `counted_at`.

Fail-safe: when Pulse cannot be read, its shape is not what this script expects (missing or non-integer counts,
humans + agents != citizens, no counted_at) or its count is older than the snapshot already in the file, the file is
left unchanged, a warning is printed (a GitHub Actions ::warning:: line) and the exit code is 0, so the rest of the weekly
refresh still runs. It never writes a null or a made-up zero.
"""
import argparse, json, os, sys, urllib.request
from datetime import date, datetime, timedelta, timezone

PULSE_URL = 'https://commonworld.one/v1/pulse'
PULSE_PAGE = 'https://commonworld.one/pulse'
HERE = os.path.dirname(os.path.abspath(__file__))
STATS = os.path.normpath(os.path.join(HERE, '..', 'data', 'stats.json'))
LAUNCH = '2026-10-20'  # Commonworld v1 went live in production on this day; citizen counts start here
SOURCE = {'name': 'Commonworld v1 platform, Pulse (/v1/pulse)', 'url': PULSE_URL}

# stats.json metric id -> (Pulse group, Pulse key). Totals are all time; active citizens is the 7-day window.
TOTALS = {
    'citizens_total': 'citizens',
    'citizens_humans': 'humans',
    'citizens_agents': 'agents',
    'citizens_posts': 'posts',
    'citizens_comments': 'comments',
    'citizens_upvotes': 'upvotes',
}
ACTIVE = 'citizens_active_7d'


class PulseShapeError(ValueError):
    """Pulse answered, but not in the shape this script relies on."""


def fetch(url=PULSE_URL, timeout=30):
    req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'commonworld-stats'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def counted_utc(v):
    """Pulse counted_at (ISO 8601 UTC, '2026-10-27T16:07:00.000Z') as an aware UTC datetime. Also accepts the
    'Tue 2026-10-27 6:07 PM EET (UTC+02:00)' form some sandboxed proxies rewrite timestamps into."""
    if not isinstance(v, str) or not v.strip():
        raise PulseShapeError('counted_at missing')
    try:
        dt = datetime.fromisoformat(v.strip().replace('Z', '+00:00'))
        if dt.tzinfo is None:
            raise PulseShapeError(f'counted_at has no time zone: {v!r}')
        return dt.astimezone(timezone.utc)
    except ValueError:
        pass
    try:
        parts = v.split()
        off = v[v.index('(UTC') + 4:v.index(')', v.index('(UTC'))] if '(UTC' in v else '+00:00'
        dt = datetime.strptime(f'{parts[1]} {parts[2]} {parts[3]}', '%Y-%m-%d %I:%M %p')
        sign = 1 if off[0] == '+' else -1
        h, m = (int(x) for x in off[1:].split(':'))
        return (dt - sign * timedelta(hours=h, minutes=m)).replace(tzinfo=timezone.utc)
    except (ValueError, IndexError) as ex:
        raise PulseShapeError(f'counted_at not readable: {v!r}') from ex


def _count(group, key, where):
    v = group.get(key) if isinstance(group, dict) else None
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise PulseShapeError(f'{where}.{key} is not a non-negative integer: {v!r}')
    return v


def parse_pulse(doc):
    """The numbers this script uses, checked. Raises PulseShapeError on anything unexpected."""
    if not isinstance(doc, dict):
        raise PulseShapeError('Pulse answer is not a JSON object')
    totals, week = doc.get('totals'), doc.get('activity_7d')
    if not isinstance(totals, dict) or not isinstance(week, dict):
        raise PulseShapeError('Pulse answer lacks totals or activity_7d')
    out = {mid: _count(totals, key, 'totals') for mid, key in TOTALS.items()}
    out[ACTIVE] = _count(week, 'active_citizens', 'activity_7d')
    if out['citizens_total'] == 0:
        raise PulseShapeError('totals.citizens is 0 (the live platform has citizens; refusing to publish a zero)')
    if out['citizens_humans'] + out['citizens_agents'] != out['citizens_total']:
        raise PulseShapeError('totals.humans + totals.agents != totals.citizens')
    if out[ACTIVE] > out['citizens_total']:
        raise PulseShapeError('activity_7d.active_citizens is larger than totals.citizens')
    day = counted_utc(doc.get('counted_at')).date()
    return {'counted_on': day.isoformat(), 'values': out}


def apply(stats, parsed):
    """A new stats document with the Citizens rows set from `parsed` (the input is not changed)."""
    doc = json.loads(json.dumps(stats))
    sec = next((s for s in doc.get('sections') or [] if s.get('id') == 'citizens'), None)
    if sec is None:
        raise PulseShapeError('stats.json has no citizens section')
    by_id = {m.get('id'): m for m in sec.get('metrics') or []}
    missing = [mid for mid in list(TOTALS) + [ACTIVE] if mid not in by_id]
    if missing:
        raise PulseShapeError(f'stats.json citizens section lacks {", ".join(missing)}')
    on = parsed['counted_on']
    week_from = (date.fromisoformat(on) - timedelta(days=7)).isoformat()  # Pulse's window is rolling: counted_at minus 7 days
    for mid, v in parsed['values'].items():
        m = by_id[mid]
        m['value'], m['status'], m['as_of'] = v, 'ok', on
        m['source'] = dict(SOURCE)
        if mid == ACTIVE:
            m['period'] = {'from': week_from, 'to': on, 'label': 'last 7 days'}
        else:
            m['period'] = {'from': LAUNCH, 'to': on, 'label': f'since launch ({LAUNCH})'}
    if str(doc.get('updated_at') or '') < on:
        doc['updated_at'] = on
    return doc


def current_as_of(stats):
    for s in stats.get('sections') or []:
        for m in s.get('metrics') or []:
            if m.get('id') == 'citizens_total':
                return str(m.get('as_of') or '')
    return ''


def warn(msg):
    print(f'::warning title=stats_from_pulse::{msg} (atlas/data/stats.json left unchanged)', file=sys.stderr)


def run(stats_path=STATS, url=PULSE_URL, dry_run=False, summary=None, fetcher=fetch):
    """Returns 'updated', 'unchanged' or 'skipped' (a warning was printed). Never raises on a Pulse problem."""
    with open(stats_path, encoding='utf-8') as f:
        stats = json.load(f)
    try:
        parsed = parse_pulse(fetcher(url))
    except PulseShapeError as ex:
        warn(f'Pulse shape not as expected: {ex}')
        return 'skipped'
    except Exception as ex:  # network, HTTP or JSON error
        warn(f'Pulse not reachable at {url}: {type(ex).__name__}: {ex}')
        return 'skipped'
    if parsed['counted_on'] < current_as_of(stats):
        warn(f'Pulse count of {parsed["counted_on"]} is older than the snapshot in the file ({current_as_of(stats)})')
        return 'skipped'
    try:
        new = apply(stats, parsed)
    except PulseShapeError as ex:
        warn(str(ex))
        return 'skipped'
    v = parsed['values']
    line = (f'Citizens from Pulse ({PULSE_PAGE}), counted {parsed["counted_on"]}: {v["citizens_total"]} citizens '
            f'({v["citizens_humans"]} human, {v["citizens_agents"]} agents), {v[ACTIVE]} active in 7 days, '
            f'{v["citizens_posts"]} posts, {v["citizens_comments"]} comments, {v["citizens_upvotes"]} upvotes.')
    print(line)
    if dry_run:
        print(json.dumps(next(s for s in new['sections'] if s['id'] == 'citizens'), ensure_ascii=False, indent=1))
        return 'unchanged'
    if new == stats:
        return 'unchanged'
    with open(stats_path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(new, ensure_ascii=False, indent=1) + '\n')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f'\n**Stats:** {line}\n')
    return 'updated'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='print the new Citizens section, write nothing')
    ap.add_argument('--url', default=PULSE_URL, help='Pulse JSON address (default: %(default)s)')
    ap.add_argument('--file', default=STATS, help='stats.json to update (default: atlas/data/stats.json)')
    ap.add_argument('--summary', help='append a one-line Markdown summary to this file when the stats change')
    a = ap.parse_args(argv)
    print(f'stats_from_pulse: {run(a.file, a.url, a.dry_run, a.summary)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
