#!/usr/bin/env python3
"""Offline cross-surface check of an isolated overview build, never a release gate.

It tests the draft-specific invariant (noindex, same overview on HTML/MD/JSON/MCP)
without treating the intentionally empty preview sitemap as a production pass.
"""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'atlas/site'))
import overviews

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]; self.robots=''; self.text=[]; self.ids=set()
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if attrs.get('id'):self.ids.add(attrs['id'])
        if tag=='a' and attrs.get('name'):self.ids.add(attrs['name'])
        if tag=='meta' and attrs.get('name')=='robots':self.robots=attrs.get('content','')
        if tag in ('a','img','script','link'):
            self.links.append(attrs.get('href') or attrs.get('src') or '')
    def handle_data(self,text):self.text.append(text)


def check(source,dist):
    doc=json.loads(source.read_text()); failures=[]; seen=set()
    all_records=json.loads((dist/'atlas/platforms.json').read_text())['platforms']
    catalog={r['id']:r for r in all_records}
    mcp=json.loads((dist/'api/v1/atlas/mcp-index.json').read_text())
    rows=[]
    if 'shards' in mcp:
        for shard in mcp['shards']:
            rows.extend(json.loads((dist/shard['path'].lstrip('/')).read_text())['rows'])
    else:rows=mcp['rows']
    mcp_by={r['id']:r for r in rows}
    for slug,r in doc['cards'].items():
        public=overviews.public(r)
        path=dist/'atlas/platforms'/slug
        html=(path/'index.html').read_text();md=(path/'index.md').read_text()
        parser=Links();parser.feed(html)
        if 'noindex' not in parser.robots:failures.append(slug+': draft indexable')
        if r['text'] not in ''.join(parser.text) or r['text'] not in md:failures.append(slug+': overview text mismatch')
        if r.get('visited_at') is None and 'Not yet recorded for this overview' not in html:failures.append(slug+': fabricated visit display')
        for marker in ('id="h-claims"','id="h-task"','id="h-evidence"'):
            if marker in html:failures.append(slug+': old claim UI')
        for record in (catalog.get(slug,{}),mcp_by.get(slug,{}),json.loads((dist/'api/v1/atlas/platforms'/(slug+'.json')).read_text())):
            if record.get('overview')!=public:failures.append(slug+': machine overview differs')
        if 'editor_note' in json.dumps(public) or 'prepared_by' in public or 'check' in public:failures.append(slug+': internal fields exported')
        seen.add(slug)
    broken=[];pages=0
    for path in dist.rglob('*.html'):
        # typed error documents contain JSON/Markdown, not HTML pages.
        raw=path.read_text(); parser=Links();parser.feed(raw)
        if '<!doctype html>' not in raw.lower():continue
        pages+=1
        if 'noindex' not in parser.robots:failures.append(str(path.relative_to(dist))+': preview route indexable')
        for link in parser.links:
            u=urlsplit(link)
            if not link or (u.scheme and u.netloc!='commonworld.one') or link.startswith('//'):continue
            if not u.path and u.fragment:
                target=path
            elif u.path.startswith('/'):
                target=dist/u.path.lstrip('/')
            else:
                target=path.parent/u.path
            if not target.exists():
                # Product links are served by the Worker, not the static Atlas.
                if u.path.startswith(('/atlas/','/api/v1/')):broken.append(u.path)
            elif u.fragment:
                page_target=target/'index.html' if target.is_dir() else target
                if page_target.suffix=='.html' and page_target.exists():
                    fragment_parser=Links();fragment_parser.feed(page_target.read_text())
                    if u.fragment not in fragment_parser.ids:
                        broken.append(u.path+'#'+u.fragment)
    if broken:failures.append('missing static internal links: '+str(sorted(set(broken))[:15]))
    return {'mode':'local_draft_preview_not_release','overviews_checked':len(seen),'html_pages_checked':pages,
        'machine_surfaces':['HTML','Markdown','per-card API v1','catalog JSON','compact MCP'],
        'failures':failures,'network_requests':0,'independent_content_review':False,'privacy_scan':'not performed by this checker'}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',required=True);p.add_argument('--dist',required=True);p.add_argument('--report')
    a=p.parse_args();result=check(Path(a.source),Path(a.dist))
    text=json.dumps(result,indent=2)+'\n';print(text)
    if a.report:Path(a.report).write_text(text)
    raise SystemExit(bool(result['failures']))

if __name__=='__main__':main()
