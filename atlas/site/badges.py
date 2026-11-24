"""Commonworld Atlas status badges: one static SVG per published card (light + dark variant). Standard library only.

    /atlas/badge/<slug>.svg        for light backgrounds
    /atlas/badge/<slug>-dark.svg   for dark backgrounds

Left: the Commonworld mark + "Commonworld Atlas". Right: the card's status:
  Verified · YYYY-MM-DD   live card published as verified (date = newest observation on the card, UTC)
  Listed                  published card that is not (or no longer) verified, e.g. under review
  Closed · history        closed platform kept as a history record

The SVG is a plain image: no scripts, no links, no external fonts or requests, no tracking. Text widths come from
the DejaVu Sans advance-width tables below (11 px), and every text run carries textLength, so the badge never clips
whatever font the viewer falls back to. Same input -> byte-identical file (build.py rebuilds them on every refresh).
"""
from xml.sax.saxutils import escape

# palette: og_images.py / cw-components.css light tokens
BG, INK, ACCENT, OLIVE, LIVE, DEAD = '#f4f1ea', '#202522', '#bf472c', '#63705b', '#2f7d4f', '#a24e3d'
DARK_LEFT, DARK_EDGE = '#2c322e', '#4a514c'
TONE = {'verified': LIVE, 'listed': OLIVE, 'closed': DEAD}
LABEL = 'Commonworld Atlas'
H = 20
FONT = 'Verdana,DejaVu Sans,Geneva,sans-serif'
SIZE = 11

# advance widths, units per em 2048, for ' ' .. '~' then '·' and '–' (DejaVu Sans / DejaVu Sans Bold)
_CH = ''.join(chr(c) for c in range(32, 127)) + '\u00b7\u2013'
_REG = [651, 821, 942, 1716, 1303, 1946, 1597, 563, 799, 799, 1024, 1716, 651, 739, 651, 690, 1303, 1303, 1303, 1303, 1303, 1303, 1303, 1303,
        1303, 1303, 690, 690, 1716, 1716, 1716, 1087, 2048, 1401, 1405, 1430, 1577, 1294, 1178, 1587, 1540, 604, 604, 1343, 1141, 1767, 1532,
        1612, 1235, 1612, 1423, 1300, 1251, 1499, 1401, 2025, 1403, 1251, 1403, 799, 690, 799, 1716, 1024, 1024, 1255, 1300, 1126, 1300, 1260,
        721, 1300, 1298, 569, 569, 1186, 569, 1995, 1298, 1253, 1300, 1300, 842, 1067, 803, 1298, 1212, 1675, 1212, 1212, 1075, 1303, 690, 1303,
        1716, 651, 1024]
_BOLD = [713, 934, 1067, 1716, 1425, 2052, 1786, 627, 936, 936, 1071, 1716, 778, 850, 778, 748, 1425, 1425, 1425, 1425, 1425, 1425, 1425, 1425,
         1425, 1425, 819, 819, 1716, 1716, 1716, 1188, 2048, 1585, 1561, 1503, 1700, 1399, 1399, 1681, 1714, 762, 762, 1587, 1305, 2038, 1714,
         1741, 1501, 1741, 1577, 1475, 1397, 1663, 1585, 2259, 1579, 1483, 1485, 936, 748, 936, 1716, 1024, 1024, 1382, 1466, 1214, 1466, 1389,
         891, 1466, 1458, 702, 702, 1362, 702, 2134, 1458, 1407, 1466, 1466, 1010, 1219, 979, 1458, 1335, 1892, 1321, 1335, 1192, 1458, 748, 1458,
         1716, 778, 1024]
_W = {False: dict(zip(_CH, _REG)), True: dict(zip(_CH, _BOLD))}


def text_width(s, bold=False, size=SIZE):
    """Rendered width in px (unknown characters count as an 'M', so the estimate errs wide, never narrow)."""
    t = _W[bold]
    return sum(t.get(ch, t['M']) for ch in s) * size / 2048


def status_of(card):
    """('verified'|'listed'|'closed', right-hand text) for a card dict as build.py holds it (_verified = aware UTC datetime)."""
    if card.get('_overview') and card.get('status') != 'closed':
        return 'verified', 'Verified · ' + card['_overview']['visited_at'][:10]
    if card.get('_limitation') or card.get('current_limitation'):
        return 'listed', 'Listed'
    if card.get('status') == 'closed':
        return 'closed', 'Closed · history'
    dt = card.get('_verified')
    if card.get('verdict') == 'include_verified' and dt:
        return 'verified', 'Verified · ' + dt.strftime('%Y-%m-%d')
    return 'listed', 'Listed'


def alt_text(card):
    return f'{LABEL}: {status_of(card)[1]}'


# The vector Commonworld mark (static/cw-mark-light.svg, viewBox 0 0 768 768): ink C + coral W, drawn on the badge's own tile.
MARK_C = 'M330 213 L378 285 L262 285 A102 92.5 0 0 0 262 470 L318 470 L350 540 L255 540 A167 163.5 0 0 1 255 213 Z'
MARK_W = 'M283 325 L345 325 L403 412 L470 318 L494 318 L550 410 L626 297 L690 297 L556 535 L541 535 L482 436 L412 530 L396 530 Z'
MARK_CORAL = '#cb7756'


def _mark(x, y, dark):
    """Commonworld mark (ink C + coral W on a paper tile), 14x14 at (x, y)."""
    tile = BG if not dark else '#e9e4d9'
    return (f'<rect x="{x}" y="{y}" width="14" height="14" rx="3" fill="{tile}"/>'
            f'<g transform="translate({x} {y}) scale({14 / 768:.6f})"><path fill="{INK}" d="{MARK_C}"/><path fill="{MARK_CORAL}" d="{MARK_W}"/></g>')


def _n(v):
    s = f'{v:.1f}'
    return s[:-2] if s.endswith('.0') else s


def svg(tone, right, dark=False, title=True):
    """The badge as an SVG string. title=False drops <title> (for inline use inside an HTML page; aria-label stays)."""
    lw = text_width(LABEL)
    rw = text_width(right, bold=True)
    w1 = round(22 + lw + 7)
    w2 = round(7 + rw + 7)
    w = w1 + w2
    left_fill = DARK_LEFT if dark else INK
    label_fill = BG
    aria = escape(f'{LABEL}: {right}', {'"': '&quot;'})
    edge = (f'<rect x=".5" y=".5" width="{w - 1}" height="{H - 1}" rx="2.5" fill="none" stroke="{DARK_EDGE}" stroke-opacity=".9"/>' if dark else '')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{H}" viewBox="0 0 {w} {H}" role="img" aria-label="{aria}">'
            + (f'<title>{escape(LABEL + ": " + right)}</title>' if title else '')
            + f'<rect width="{w}" height="{H}" rx="3" fill="{TONE[tone]}"/><rect width="{w1}" height="{H}" rx="3" fill="{left_fill}"/>'
            f'<rect x="{w1 - 4}" width="4" height="{H}" fill="{left_fill}"/>'
            f'{edge}{_mark(4, 3, dark)}'
            f'<g font-family="{FONT}" font-size="{SIZE}" text-rendering="geometricPrecision">'
            f'<text x="22" y="14" fill="{label_fill}" textLength="{_n(lw)}" lengthAdjust="spacing">{escape(LABEL)}</text>'
            f'<text x="{w1 + 7}" y="14" fill="#fff" font-weight="bold" textLength="{_n(rw)}" lengthAdjust="spacing">{escape(right)}</text>'
            '</g></svg>\n')


def card_svgs(card):
    """(light svg, dark svg) for one card."""
    tone, right = status_of(card)
    return svg(tone, right), svg(tone, right, dark=True)
