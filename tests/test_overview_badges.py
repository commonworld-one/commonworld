"""Pending overview packages must not crash or inherit legacy verification."""
import copy
from datetime import datetime, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import badges
import build
import overviews

class OverviewBadgeTests(unittest.TestCase):
    def card(self, state='draft', visit=None):
        return {'slug':'example','name':'Example','status':'live','category':'social','entity_type':'platform','canonical_url':'https://example.org/','_url':'/atlas/platforms/example/','_tags':[], 'verdict':'include_verified','_verified':datetime(2026,10,1,tzinfo=timezone.utc), '_overview':{'state':state,'visited_at':visit,'text':'An agent tool.','sources':['https://example.org/']}}
    def test_pending_and_invalid_visits_are_listed_without_legacy_fallback(self):
        for state in ['draft','held','reviewed']:
            for visit in [None,'','not-a-date','2026-02-30T00:00:00Z']:
                c=self.card(state,visit)
                self.assertEqual(badges.status_of(c),('listed','Listed'))
                for svg in badges.card_svgs(c): self.assertNotIn('Verified',svg)
        self.assertEqual(badges.status_of(self.card('draft','2026-11-22T00:00:00Z')),('listed','Listed'))
    def test_absent_or_null_overview_preserves_legacy_fallback(self):
        c=self.card();c['_overview']=None
        self.assertEqual(badges.status_of(c),('verified','Verified · 2026-10-01'))
        del c['_overview']
        self.assertEqual(badges.status_of(c),('verified','Verified · 2026-10-01'))
    def test_date_eligibility_preserves_schema_supported_utc_precision(self):
        for visit in ['2026-11-22T18:30:00Z','2026-11-22T18:30:00+00:00','2026-11-22T18:30Z','2026-11-22T18:30:00.1Z','2026-02-30T00:00:00Z']:
            expected=('listed','Listed') if visit in ['2026-11-22T18:30:00+00:00','2026-02-30T00:00:00Z'] else ('verified','Verified · 2026-11-22')
            self.assertEqual(badges.status_of(self.card('reviewed',visit)),expected)
    def test_reviewed_date_and_closed_precedence(self):
        c=self.card('reviewed','2026-11-22T18:30:00Z')
        self.assertEqual(badges.status_of(c),('verified','Verified · 2026-11-22'))
        c['status']='closed';self.assertEqual(badges.status_of(c),('closed','Closed · history'))
    def test_actual_draft_render_and_badge_panel_do_not_claim_verified(self):
        c=self.card();site=SimpleNamespace(base='/atlas',cfg={'site':{'corrections_url':'https://example.org/correct'}}, by_cat={'social':[c]},abs=lambda p:'https://commonworld.one'+p)
        panel=build.badge_block(site,c)
        self.assertIn('Listed',panel);self.assertNotIn('Atlas: Verified',panel)
        class Render:
            CAT_LABEL=build.CAT_LABEL;TYPE_LABEL=build.TYPE_LABEL;cw=build.cw
            ext_link=staticmethod(build.ext_link);breadcrumbs=staticmethod(lambda *a:('',{}));shot_figure=staticmethod(lambda *a:'');badge_block=staticmethod(build.badge_block)
            parse_time=staticmethod(build.parse_time);time_tag=staticmethod(build.time_tag);trim=staticmethod(build.trim);fit_title=staticmethod(build.fit_title);domain=staticmethod(build.domain)
            og_generic=staticmethod(lambda *a,**kw:{});page=staticmethod(lambda *a,**kw:kw['body'])
            tag_href=staticmethod(build.tag_href)
        html=overviews.render_html(site,c,Render)
        self.assertIn('Draft, not ready for publication.',html)
        self.assertIn('Draft · not verified',html)
        self.assertNotIn('Live · Verified',html)
