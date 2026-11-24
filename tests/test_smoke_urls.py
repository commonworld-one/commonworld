from pathlib import Path
import sys
import unittest
from urllib.parse import quote
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'atlas/site/tools'))
from smoke_urls import exact_https_url, caption_source_matches, share_target_matches

class SmokeUrlTests(unittest.TestCase):
    def test_valid_root_variants(self):
        for value in ['https://thecolony.ai','https://thecolony.ai/','https://thecolony.ai:443/']:
            self.assertTrue(exact_https_url(value,'https://thecolony.ai/'))
    def test_spoofed_hosts_credentials_paths_query_fragment_rejected(self):
        for value in ['https://thecolony.ai.evil/','https://evilthecolony.ai/','https://thecolony.ai@evil/','https://evil@thecolony.ai/','https://evil/path/https://thecolony.ai/','https://evil/?next=https://thecolony.ai/','https://thecolony.ai/?next=https://thecolony.ai/','https://thecolony.ai/#x','https://thecolony.ai/path','http://thecolony.ai/','https://thecolony.ai:444/','https://thecolony.ai:bad/','https://thecolony.ai\\@evil/',' https://thecolony.ai/','https://[bad','',None]:
            self.assertFalse(exact_https_url(value,'https://thecolony.ai/'),value)
    def test_visible_caption_exact_source(self):
        template='Homepage as captured 22 Nov 2026 from {}. Screenshot © the site owner, not part of the CC BY data.'
        self.assertTrue(caption_source_matches(template.format('https://thecolony.ai/'),'https://thecolony.ai/'))
        for value in ['https://thecolony.ai.evil/','https://evil@thecolony.ai/','https://evil/?next=https://thecolony.ai/','https://evil/path/https://thecolony.ai/']:
            self.assertFalse(caption_source_matches(template.format(value),'https://thecolony.ai/'))
        self.assertFalse(caption_source_matches('prefix '+template.format('https://thecolony.ai/'),'https://thecolony.ai/'))
    def test_current_caption_exact_source_without_second_date(self):
        template = 'Homepage · {}. Screenshot © the site owner, not part of the CC BY data.'
        self.assertTrue(caption_source_matches(template.format('https://thecolony.ai/'), 'https://thecolony.ai/', current=True))
        for value in ['https://thecolony.ai.evil/', 'https://evil@thecolony.ai/', 'https://evil/?next=https://thecolony.ai/', 'https://evil/path/https://thecolony.ai/']:
            self.assertFalse(caption_source_matches(template.format(value), 'https://thecolony.ai/', current=True))
        for value in ['prefix ' + template.format('https://thecolony.ai/'), template.format('https://thecolony.ai/') + ' extra']:
            self.assertFalse(caption_source_matches(value, 'https://thecolony.ai/', current=True))

    def test_share_target_parsed_parameter_not_arbitrary_substring(self):
        canon='https://commonworld.one/atlas/platforms/the-colony/'
        for network,root,key in [('x','https://x.com/intent/tweet','url'),('linkedin','https://www.linkedin.com/sharing/share-offsite/','url'),('telegram','https://t.me/share/url','url'),('reddit','https://www.reddit.com/submit','url'),('facebook','https://www.facebook.com/sharer/sharer.php','u')]:
            self.assertTrue(share_target_matches(root+'?'+key+'='+quote(canon,safe=''),network,canon))
            for bad in ['https://evil/?next='+canon,'https://commonworld.one.evil/atlas/platforms/the-colony/',canon+'?x=1']:
                self.assertFalse(share_target_matches(root+'?'+key+'='+quote(bad,safe=''),network,canon))
            self.assertFalse(share_target_matches(root+'?'+key+'='+quote(canon,safe='')+'&'+key+'=',network,canon))
            self.assertFalse(share_target_matches(root+'?'+key+'=&'+key+'='+quote(canon,safe=''),network,canon))
            self.assertFalse(share_target_matches(root+'?unrelated='+quote(canon,safe=''),network,canon))
            self.assertFalse(share_target_matches(root+'?'+key+'='+quote(canon,safe='')+'&'+key+'='+quote(canon,safe=''),network,canon))
        self.assertTrue(share_target_matches('mailto:?subject=Title&body='+quote('Title\n\n'+canon,safe=''),'email',canon))
        self.assertFalse(share_target_matches('mailto:?body='+quote('https://evil/?next='+canon,safe=''),'email',canon))

    def test_email_empty_duplicate_body_rejected(self):
        canon='https://commonworld.one/atlas/platforms/the-colony/'
        valid='mailto:?body='+quote('Title\n\n'+canon,safe='')
        self.assertFalse(share_target_matches(valid+'&body=','email',canon))
        self.assertFalse(share_target_matches('mailto:?body=&body='+quote(canon,safe=''),'email',canon))
