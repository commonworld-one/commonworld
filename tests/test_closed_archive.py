"""Closed archive output and safety regressions, offline."""
import json,sys,tempfile,unittest,importlib.util
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'));sys.path.insert(0,str(ROOT/'atlas/tools'))
import closed_archive as ca,link_safety as ls
class ClosedArchive(unittest.TestCase):
 def test_inert_history_is_not_a_url_and_input_preserved(self):
  source={'description_en':'Visit https://old.example/a','claims':[{'source_url':'https://old.example/b'}]}
  before=json.dumps(source);out=ca.inert(source)
  self.assertNotIn('https://',json.dumps(out));self.assertIn('old[.]example',json.dumps(out));self.assertEqual(json.dumps(source),before)
 def test_html_blocks_project_navigation_retains_site_chrome_and_pixels(self):
  raw='<header><a href="https://x.com/commonworldone">X</a></header><main id="main"><a href="https://old.example"><img src="/atlas/screens/sample.webp"></a><p>https://old.example</p></main>'
  out=ca.html_document(raw)
  self.assertNotIn('href="https://old.example',out);self.assertIn('href="https://x.com/commonworldone"',out)
  self.assertIn('src="/atlas/screens/sample.webp"',out);self.assertIn('old[.]example',out)
 def test_markdown_preserves_internal_canonical_only(self):
  raw='Canonical https://commonworld.one/atlas/platforms/sample/ [site](https://old.example/a)'
  out=ca.markdown(raw);self.assertIn('https://commonworld.one/',out);self.assertNotIn('https://old.example',out)
 def test_closure_date_not_inferred_from_observation(self):
  self.assertIsNone(ca.closure_date({'claims':[{'observed_at':'2026-11-20T00:00:00Z'}]}))
  self.assertEqual(ca.closure_date({'status_history':[{'to':'closed','at':'2026-11-20T00:00:00Z'}]}),'2026-11-20T00:00:00Z')
 def test_closed_excluded_even_when_host_shared_with_live(self):
  with tempfile.TemporaryDirectory() as td:
   d=Path(td);snap={'count':2,'platforms':[{'slug':'live','status':'live','canonical_url':'https://shared.example/'},{'slug':'closed','status':'closed','canonical_url':'https://shared.example/'}]}
   (d/'overviews.json').write_text(json.dumps({'cards':{'closed':{'sources':['https://closed-source.example/']},'live':{'sources':['https://shared.example/']}}}));(d/'limitations.json').write_text('{"cards":{}}')
   hosts=ls.catalogue_hosts(d,snap,[]);self.assertEqual(hosts,{'shared.example':['live']})
   (d/'snapshot.json').write_text(json.dumps(snap));(d/'removed.json').write_text('{"removed":[],"decisions":[]}')
   report={'flagged':['shared.example'],'hosts':{'shared.example':{'entries':['live','closed'],'status':'flagged','flagged_by':['synthetic'],'sources':[{'name':'synthetic','verdict':'flagged','evidence_url':'https://evidence.example/'}]}},'sources':[{'id':'synthetic','name':'Synthetic'}],'standard':'https://evidence.example/','removed_hosts':{},'summary':{}}
   actions=ls.apply_removals(report,str(d/'snapshot.json'),str(d/'removed.json'),None,set(),'2026-11-24',[],preserve_inputs=True)
   self.assertEqual([a['slug'] for a in actions],['live']);self.assertEqual(json.loads((d/'snapshot.json').read_text()),snap)
   (d/'removed.json').write_text('{"removed":[],"decisions":[]}')
   report['flagged']=['shared.example'];report['hosts']['shared.example']['entries']=['live','closed']
   actions=ls.apply_removals(report,str(d/'snapshot.json'),str(d/'removed.json'),None,set(),'2026-11-24',[],preserve_inputs=False)
   self.assertEqual([a['slug'] for a in actions],['live']);self.assertEqual([c['slug'] for c in json.loads((d/'snapshot.json').read_text())['platforms']],['closed'])
 def test_built_closed_records_preserve_every_historical_field(self):
  dist=ROOT/'atlas/site/dist'
  if not (dist/'atlas/platforms.json').exists():self.skipTest('catalogue build not present')
  source=json.loads((ROOT/'atlas/catalogue/snapshot.json').read_text())['platforms']
  rows=json.loads((dist/'atlas/closed.json').read_text())['platforms'];by={r['id']:r for r in rows}
  closed=[c for c in source if c.get('status')=='closed'];self.assertEqual(len(closed),20)
  for c in closed:
   r=by[c['slug']];self.assertEqual(r['status'],'closed');self.assertEqual(r['archive']['external_links'],'disabled')
   for k,v in c.items():self.assertEqual(r['archive']['history'][k],ca.inert(v),(c['slug'],k))
   for k in ('website','link_safety','reachability','replications','badge_svg'):self.assertNotIn(k,r)
   self.assertTrue((dist/'atlas/platforms'/c['slug']/'index.html').exists())
 def test_legacy_queries_skip_closed_snapshot_and_curation_shared_host(self):
  with tempfile.TemporaryDirectory() as td:
   p=Path(td)/'curation.json';p.write_text(json.dumps({'cards':{'closed':{'source_url':'https://closed-only.example/'},'live':{'source_url':'https://shared.example/'}}}))
   snap={'platforms':[{'slug':'closed','status':'closed','canonical_url':'https://shared.example/','claims':[{'source_url':'https://old-only.example/'}]},{'slug':'live','status':'live','canonical_url':'https://shared.example/'}]}
   hosts=ls.linked_hosts(snap,[(str(p),'cards')])
   self.assertEqual(hosts,{'shared.example':['live']})
 def test_historical_captures_preserved_without_new_visit_or_active_source(self):
  import hashlib,screens
  archive=ROOT/'atlas/catalogue/archive-captures';meta=json.loads((archive/'manifest.json').read_text())['screens']
  loaded=screens.retain_archive_captures(None,{},set(meta))
  self.assertEqual(set(loaded),{'issuehunt','clawsino','agent-knowledge-network'})
  self.assertEqual(screens.retain_archive_captures(None,{},set()),{})
  for slug,rec in meta.items():
   self.assertEqual(hashlib.sha256((archive/rec['file']).read_bytes()).hexdigest(),rec['sha256'])
   self.assertEqual(loaded[slug]['captured_at'],rec['captured_at']);self.assertIsNone(rec['confirmed_at'])
   dist=ROOT/'atlas/site/dist'
   if not dist.exists():continue
   self.assertEqual((dist/'atlas/screens'/rec['file']).read_bytes(),(archive/rec['file']).read_bytes())
   public=json.loads((dist/'atlas/platforms'/f'{slug}.json').read_text());capture=public['archive']['history']['capture']
   self.assertEqual(capture['captured_at'],rec['captured_at']);self.assertNotIn('https://',capture['source_url'])
   page=(dist/'atlas/platforms'/slug/'index.html').read_text();self.assertIn('src="/atlas/screens/'+slug+'.webp"',page)
   self.assertNotIn('QA re-checked',page);self.assertNotIn('<dt>Last verified</dt>',page);self.assertNotIn('↗',page.split('<main id="main">',1)[1].split('</main>',1)[0])
 def test_bare_domains_and_partly_defanged_urls_are_uniform_and_idempotent(self):
  raw='https://web.archive.org/web/https://lobchan.ai/ lobchan.ai clawnews.io clawirc.duckdns.org app.bountysource.com moltx.io issuehunt.io gitcoin.co replit.com/bounties 64.23.221.102 HTTPS://old.example.com/ https://old[.]example[.]com/'
  out=ca.inert_text(raw)
  self.assertIsNone(ca.HOST.search(out));self.assertNotIn('https://',out.lower());self.assertNotIn('64.23.221.102',out)
  self.assertEqual(out,ca.inert_text(out));self.assertIn('https[:]//old[.]example[.]com/',out)
  self.assertEqual(ca.inert_text('https://commonworld.one/atlas/platforms/issuehunt/'),'https://commonworld.one/atlas/platforms/issuehunt/')
 def test_closed_published_free_text_has_no_bare_domains(self):
  dist=ROOT/'atlas/site/dist'
  if not dist.exists():self.skipTest('catalogue build absent')
  source=json.loads((ROOT/'atlas/catalogue/snapshot.json').read_text())['platforms']
  for c in source:
   if c['status']!='closed':continue
   slug=c['slug'];md=(dist/'atlas/platforms'/slug/'index.md').read_text()
   self.assertEqual(ca.inert_text(md),md,slug)
   public=json.loads((dist/'atlas/platforms'/f'{slug}.json').read_text())
   self.assertEqual(ca.inert(public),public,slug)
  for path in ('atlas/platforms.json','api/v1/atlas/mcp-index.json','atlas/data/snapshot.json','atlas/events.json'):
   def audit(v):
    if isinstance(v,dict):
     if v.get('status')=='closed' and v.get('archive'):self.assertEqual(ca.inert(v),v,path)
     for x in v.values():audit(x)
    elif isinstance(v,list):
     for x in v:audit(x)
   audit(json.loads((dist/path).read_text()))
 def test_absolute_dns_names_and_unlisted_suffixes(self):
  raw='moltx.io. merlin.ns.cloudflare.com. dns.cloudflare.com. https://host.unlistedtld/path'
  out=ca.inert_text(raw)
  self.assertEqual(out,'moltx[.]io[.] merlin[.]ns[.]cloudflare[.]com[.] dns[.]cloudflare[.]com[.] https[:]//host[.]unlistedtld/path')
  self.assertEqual(ca.inert_text(out),out)
 def test_corpus_derived_dns_candidates_are_inert_in_every_closed_history(self):
  source=json.loads((ROOT/'atlas/catalogue/snapshot.json').read_text())['platforms']
  def strings(v):
   if isinstance(v,str):yield v
   elif isinstance(v,dict):
    for x in v.values():yield from strings(x)
   elif isinstance(v,list):
    for x in v:yield from strings(x)
  hosts=set()
  for c in source:
   if c['status']!='closed':continue
   for text in strings(c):
    for m in ca.HOST.finditer(text):
     host=m[0]
     if host.lower() not in ca.OWN and host.lower().rsplit('.',1)[-1] not in ca.FILE_SUFFIXES:hosts.add(host)
   projected=ca.inert(c)
   for text in strings(projected):self.assertEqual(ca.inert_text(text),text,c['slug'])
  self.assertTrue({'moltx.io.','merlin.ns.cloudflare.com.','dns.cloudflare.com.'}.issubset(hosts))
  for host in hosts:self.assertNotEqual(ca.inert_text(host),host)
 def test_javascript_and_internal_paths_are_not_historical_text(self):
  js='<script>document.documentElement.classList.add("x");window.CW_GA="id";</script>'
  out=ca.html_document(js+'<main id="main">polar.sh</main>')
  self.assertIn(js,out);self.assertIn('polar[.]sh',out)
  path='https://commonworld.one/atlas/platforms/clawsino.json'
  self.assertEqual(ca.inert_text(path),path)
 def test_ambiguous_file_suffixes_never_exempt_historical_domains(self):
  self.assertEqual(ca.inert_text('polar.sh/docs/issue-funding/overview 404 confirmed'),'polar[.]sh/docs/issue-funding/overview 404 confirmed')
  self.assertEqual(ca.inert_text('skill.md script.py'),'skill[.]md script[.]py')
 def test_all_public_closed_history_strings_and_list_names(self):
  dist=ROOT/'atlas/site/dist'
  if not dist.exists():self.skipTest('catalogue build absent')
  rec=json.loads((dist/'atlas/platforms/polar-issue-funding.json').read_text())
  self.assertNotIn('polar.sh/',json.dumps(rec))
  for p in (dist/'atlas/platforms').rglob('*.html'):
   if 'Shellmates (shellmates.app)' in p.read_text():self.fail(str(p))
if __name__=='__main__':unittest.main()
