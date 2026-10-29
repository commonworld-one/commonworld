#!/usr/bin/env python3
"""Refresh the Citizens block of atlas/data/stats.json from the platform's public Pulse (stdlib only).

    python3 atlas/tools/stats_from_pulse.py                       # update atlas/data/stats.json in place
    python3 atlas/tools/stats_from_pulse.py --dry-run             # print the new Citizens section, write nothing
    python3 atlas/tools/stats_from_pulse.py --summary summary.md  # also append a short Markdown line (weekly refresh PR body)

Reads https://commonworld.one/v1/pulse (public, no key). Pulse is the always-current live view of the platform
(https://commonworld.one/pulse, /pulse.md); /stats/ keeps a dated weekly snapshot of it. The weekly workflow
.github/workflows/refresh.yml runs this script before the build, so the refresh PR carries fresh citizen numbers.

Pulse carries two times, and so does the snapshot (platform/src/pulse.ts):
- `generated_at` is when the answer was made. The totals (citizens, humans, agents, posts, comments, upvotes) are the live
  site counters read at that moment, so they are observed at `generated_at`;
- `counted_at` is when the hourly cron last counted the activity windows, so `activity_7d.active_citizens` is as of
  `counted_at` (usually up to an hour earlier, and possibly the previous UTC day just after midnight).

What it writes, and nothing else (notes, labels and every other section are left as they are):
- totals group: citizens_total, citizens_humans, citizens_agents, citizens_posts, citizens_comments, citizens_upvotes =
  Pulse `totals` (all time, visible content, active accounts), period from the v1 launch day to the UTC date of
  `generated_at`, as_of = that date (the date the page shows); the citizens section's totals_observed_at = `generated_at`;
- activity group: citizens_active_7d = Pulse `activity_7d.active_citizens` (distinct citizens with public activity in the
  rolling 7 days before `counted_at`), period from the UTC date 7 days before the count to the counted day, as_of = the
  UTC date of `counted_at`; the citizens section's activity_counted_at = `counted_at`;
- the file's updated_at = the latest date written (it never goes back).
Both times are stored as exact UTC timestamps (ISO 8601 with Z).

Freshness, per group and independently: the new time is compared with the group's time in the file (exact UTC times, so
an earlier read of the same day is refused too). Earlier = that group is skipped with a warning, equal = no-op for that
group, later = that group is updated. A file in the older format with one `counted_at` for the whole section uses it as
the time of both groups (and loses it once both new fields are written); a file with no time at all only takes a group
from a later UTC day than its as_of.

Fail-safe: when Pulse cannot be read or its shape is not what this script expects (missing or non-integer counts,
humans + agents != citizens, a generated_at or counted_at without an explicit valid time zone or in the future, a
counted_at after generated_at), the file is left unchanged, a warning is printed (a GitHub Actions ::warning:: line) and
the exit code is 0, so the rest of the weekly refresh still runs. It never writes a null or a made-up zero.
"""
import argparse, json, os, re, sys, urllib.request
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


# Strict forms of the Pulse times (generated_at, counted_at). ISO 8601 with an explicit zone (Z or +HH:MM / -HH:MM), and
# the 'Tue 2026-10-27 6:07 PM EET (UTC+02:00)' form some sandboxed proxies rewrite ISO timestamps into (weekday, date,
# 12-hour time, zone abbreviation and an explicit (UTC+HH:MM) offset, all required). A string without an explicit zone
# is never guessed to be UTC.
ISO_RE = re.compile(r'(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|([+-])(\d{2}):(\d{2}))')
PROXY_RE = re.compile(r'(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{4}-\d{2}-\d{2}) (1[0-2]|[1-9]):([0-5]\d) (AM|PM) [A-Z]{2,6} '
                      r'\(UTC([+-])(\d{2}):(\d{2})\)')
MAX_FUTURE = timedelta(minutes=10)  # clock skew allowed between Pulse and the machine running this script

# The two groups of Citizens rows and the section field that holds each group's exact observation time.
TOTALS_AT = 'totals_observed_at'    # Pulse generated_at: the live counters were read then
ACTIVITY_AT = 'activity_counted_at'  # Pulse counted_at: the hourly count of the activity windows
LEGACY_AT = 'counted_at'             # older files: one time for the whole section (read as the time of both groups)
GROUPS = {'totals': (TOTALS_AT, list(TOTALS)), 'activity': (ACTIVITY_AT, [ACTIVE])}


def _offset(sign, hh, mm, v, field):
    """A UTC offset as a timedelta; real-world offsets only: hours 00-14, minutes 00/15/30/45, at most 14:00."""
    h, m = int(hh), int(mm)
    if h > 14 or m not in (0, 15, 30, 45) or (h == 14 and m):
        raise PulseShapeError(f'{field} has an impossible UTC offset: {v!r}')
    return (1 if sign == '+' else -1) * timedelta(hours=h, minutes=m)


def pulse_time(v, field, now=None):
    """A Pulse time (`field` names it in errors) as an aware UTC datetime, read strictly (see ISO_RE and PROXY_RE).
    Raises PulseShapeError when it is missing, has control characters, has no explicit or an impossible zone, or lies
    more than MAX_FUTURE after `now`."""
    if not isinstance(v, str) or not v.strip():
        raise PulseShapeError(f'{field} missing')
    if any(ord(c) < 32 or 127 <= ord(c) < 160 for c in v):
        raise PulseShapeError(f'{field} has control characters: {v!r}')
    try:
        m = ISO_RE.fullmatch(v)
        if m:
            off = timedelta(0) if m.group(6) == 'Z' else _offset(m.group(7), m.group(8), m.group(9), v, field)
            local = datetime.fromisoformat(f'{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4) or "00"}'
                                           + (f'.{m.group(5).ljust(6, "0")}' if m.group(5) else ''))
        else:
            m = PROXY_RE.fullmatch(v)
            if not m:
                raise PulseShapeError(f'{field} not in a known form with an explicit time zone: {v!r}')
            local = datetime.strptime(f'{m.group(2)} {m.group(3)}:{m.group(4)} {m.group(5)}', '%Y-%m-%d %I:%M %p')
            if local.strftime('%a') != m.group(1):
                raise PulseShapeError(f'{field} weekday does not match its date: {v!r}')
            off = _offset(m.group(6), m.group(7), m.group(8), v, field)
        dt = (local - off).replace(tzinfo=timezone.utc)
    except ValueError as ex:  # e.g. month 13, hour 25
        raise PulseShapeError(f'{field} not readable: {v!r}') from ex
    now = now or datetime.now(timezone.utc)
    if dt > now + MAX_FUTURE:
        raise PulseShapeError(f'{field} is in the future: {v!r}')
    return dt


def counted_utc(v, now=None):
    """Pulse counted_at as an aware UTC datetime (pulse_time for the activity count time)."""
    return pulse_time(v, 'counted_at', now)


def iso_z(dt):
    """An aware datetime as ISO 8601 UTC with milliseconds and Z, the form Pulse itself uses."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S') + f'.{dt.microsecond // 1000:03d}Z'


def _count(group, key, where):
    v = group.get(key) if isinstance(group, dict) else None
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise PulseShapeError(f'{where}.{key} is not a non-negative integer: {v!r}')
    return v


def parse_pulse(doc, now=None):
    """The numbers and times this script uses, checked. Raises PulseShapeError on anything unexpected.
    Returns {'totals': {'at', 'on'}, 'activity': {'at', 'on'}, 'values': {metric id: value}}: 'at' is the exact UTC time
    (ISO 8601 with Z) the group was observed, 'on' its UTC date."""
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
    gen = pulse_time(doc.get('generated_at'), 'generated_at', now)
    cnt = pulse_time(doc.get('counted_at'), 'counted_at', now)
    if cnt > gen:
        raise PulseShapeError(f'counted_at ({iso_z(cnt)}) is after generated_at ({iso_z(gen)})')
    return {'totals': {'at': iso_z(gen), 'on': gen.date().isoformat()},
            'activity': {'at': iso_z(cnt), 'on': cnt.date().isoformat()},
            'values': out}


def _citizens(stats):
    return next((s for s in stats.get('sections') or [] if s.get('id') == 'citizens'), None)


def apply(stats, parsed, groups=('totals', 'activity')):
    """A new stats document with the Citizens rows of `groups` set from `parsed` (the input is not changed)."""
    doc = json.loads(json.dumps(stats))
    sec = _citizens(doc)
    if sec is None:
        raise PulseShapeError('stats.json has no citizens section')
    by_id = {m.get('id'): m for m in sec.get('metrics') or []}
    missing = [mid for mid in list(TOTALS) + [ACTIVE] if mid not in by_id]
    if missing:
        raise PulseShapeError(f'stats.json citizens section lacks {", ".join(missing)}')
    for g in groups:
        field, ids = GROUPS[g]
        at, on = parsed[g]['at'], parsed[g]['on']
        sec[field] = at  # exact UTC observation time of this group, the freshness guard of the next run
        for mid in ids:
            m = by_id[mid]
            m['value'], m['status'], m['as_of'] = parsed['values'][mid], 'ok', on
            m['source'] = dict(SOURCE)
            if mid == ACTIVE:  # Pulse's window is rolling: counted_at minus 7 days
                m['period'] = {'from': (date.fromisoformat(on) - timedelta(days=7)).isoformat(), 'to': on, 'label': 'last 7 days'}
            else:
                m['period'] = {'from': LAUNCH, 'to': on, 'label': f'since launch ({LAUNCH})'}
        if str(doc.get('updated_at') or '') < on:
            doc['updated_at'] = on
    if TOTALS_AT in sec and ACTIVITY_AT in sec:
        sec.pop(LEGACY_AT, None)  # older format: no group relies on the shared time any more
    return doc


def group_snapshot(stats, group):
    """(as_of date, exact time string or '') of one group of the Citizens snapshot already in the file. The exact time
    is the group's own field, else the older shared citizens.counted_at, else ''."""
    sec = _citizens(stats) or {}
    field, ids = GROUPS[group]
    as_of = next((str(m.get('as_of') or '') for m in sec.get('metrics') or [] if m.get('id') == ids[0]), '')
    return as_of, sec.get(field) or sec.get(LEGACY_AT) or ''


def freshness(stats, parsed, group):
    """None when the Pulse read of `group` ('totals' or 'activity') is newer than the file's, else ('unchanged' |
    'skipped', reason). Compares exact UTC times; an equal time is a no-op, an earlier one (even on the same day) is
    refused. A file with no exact time for the group only takes a read from a later day than its as_of."""
    as_of, at = group_snapshot(stats, group)
    what = 'totals (generated_at)' if group == 'totals' else 'activity count (counted_at)'
    new_at, new_on = parsed[group]['at'], parsed[group]['on']
    new = datetime.fromisoformat(new_at.replace('Z', '+00:00'))
    if at:
        try:
            old = pulse_time(at, f'the file\'s citizens {group} time', now=datetime.max.replace(tzinfo=timezone.utc) - MAX_FUTURE)
        except PulseShapeError as ex:
            return 'skipped', f'Pulse {what}: the file\'s time is not readable ({ex})'
        if new < old:
            return 'skipped', f'Pulse {what} of {new_at} is older than the snapshot in the file ({iso_z(old)})'
        if new == old:
            return 'unchanged', f'Pulse {what} of {new_at} is the snapshot already in the file'
        return None
    if new_on < as_of:
        return 'skipped', f'Pulse {what} of {new_on} is older than the snapshot in the file ({as_of})'
    if new_on == as_of:
        return 'skipped', (f'Pulse {what} of {new_at} is on the same day as the snapshot in the file ({as_of}), '
                           'which has no exact time to compare with')
    return None


def warn(msg, tail='atlas/data/stats.json left unchanged'):
    print(f'::warning title=stats_from_pulse::{msg} ({tail})', file=sys.stderr)


def run(stats_path=STATS, url=PULSE_URL, dry_run=False, summary=None, fetcher=fetch, now=None):
    """Returns 'updated' (at least one group written), 'unchanged' or 'skipped' (nothing written, a warning was printed).
    Each group (totals, activity) is checked and written on its own. Never raises on a Pulse problem."""
    with open(stats_path, encoding='utf-8') as f:
        stats = json.load(f)
    try:
        parsed = parse_pulse(fetcher(url), now)
    except PulseShapeError as ex:
        warn(f'Pulse shape not as expected: {ex}')
        return 'skipped'
    except Exception as ex:  # network, HTTP or JSON error
        warn(f'Pulse not reachable at {url}: {type(ex).__name__}: {ex}')
        return 'skipped'
    todo, skipped = [], []
    for g in GROUPS:
        stale = freshness(stats, parsed, g)
        if stale is None:
            todo.append(g)
        elif stale[0] == 'skipped':
            skipped.append(stale[1])
        else:
            print(f'stats_from_pulse: {stale[1]}; left unchanged')
    tail = 'this group left unchanged' if todo else 'atlas/data/stats.json left unchanged'
    for why in skipped:
        warn(why, tail)
    if not todo:
        return 'skipped' if skipped else 'unchanged'
    try:
        new = apply(stats, parsed, todo)
    except PulseShapeError as ex:
        warn(str(ex))
        return 'skipped'
    v, parts = parsed['values'], []
    if 'totals' in todo:
        parts.append(f'totals as of {parsed["totals"]["on"]}: {v["citizens_total"]} citizens ({v["citizens_humans"]} human, '
                     f'{v["citizens_agents"]} agents), {v["citizens_posts"]} posts, {v["citizens_comments"]} comments, '
                     f'{v["citizens_upvotes"]} upvotes')
    if 'activity' in todo:
        parts.append(f'activity counted {parsed["activity"]["on"]}: {v[ACTIVE]} active in 7 days')
    line = f'Citizens from Pulse ({PULSE_PAGE}), ' + '; '.join(parts) + '.'
    print(line)
    if dry_run:
        print(json.dumps(_citizens(new), ensure_ascii=False, indent=1))
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
