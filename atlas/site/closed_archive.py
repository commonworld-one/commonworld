"""Closed Atlas history: retain content, never provide an outbound transition."""
import copy
import html
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

URL = re.compile(r'https?://[^\s<>\"\)]+', re.I)

# DNS names in historical free text, including an absolute trailing dot.
# No enumerated TLD list: the corpus contains resolver authority names too.
HOST = re.compile(r"(?<![\w.\]])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?(?![\w.-])",re.I)
# No suffix exception: polar.sh is a domain, skill.md can be a filename or
# a domain. Both remain readable with [.] in historical display text.
FILE_SUFFIXES = set()
IPV4 = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])")
OWN = {'commonworld.one','www.commonworld.one'}

def inert_text(value):
    # Protect actual internal destinations, including their filename components.
    internal=[]
    def protect(m):
        internal.append(m[0]);return 'CWLINKTOKEN'+str(len(internal)-1)+'END'
    value=re.sub(r'https?://(?:www\.)?commonworld\.one(?:/[^\s<>\"\)]+)?|(?<![\w:])/atlas/[^\s<>\"\)]+',protect,value,flags=re.I)
    def url(m):
        text=m.group(0)
        if re.match(r'https?://(?:www\.)?commonworld\.one(?:[/:?#]|$)',text,re.I):return text
        # Always disable both scheme and every host dot, even if a previous
        # projection already disabled one of them. Idempotent by construction.
        return re.sub(r'(?<!\[)\.(?!\])','[.]',re.sub(r'(https?)://',lambda x:x[1].lower()+'[:]//',text,flags=re.I))
    value=URL.sub(url,value)
    value=HOST.sub(lambda m:m[0] if m[0].lower() in OWN or m[0].lower().rsplit('.',1)[-1] in FILE_SUFFIXES else m[0].replace('.','[.]'),value)
    value=IPV4.sub(lambda m:m[0].replace('.','[.]'),value)
    for i,text in enumerate(internal):value=value.replace('CWLINKTOKEN'+str(i)+'END',text)
    return value

def inert(value):
    if isinstance(value,str): return inert_text(value)
    if isinstance(value,list): return [inert(v) for v in value]
    if isinstance(value,dict): return {k:inert(v) for k,v in value.items() if not k.startswith('_')}
    return value

def closure_date(c):
    events=[x.get('at') for x in c.get('status_history',[]) if x.get('to')=='closed' and x.get('at')]
    # An observation is not a recorded closure decision. Never invent one.
    return events[-1] if events else None

def record(site,c):
    history={k:copy.deepcopy(v) for k,v in c.items() if not k.startswith('_')}
    return {'id':c['slug'],'name':inert_text(c['name']),'url':site.abs(c['_url']),
            'json_url':site.abs(site.base+'/platforms/'+c['slug']+'.json'),
            'category':c['category'],'category_label':site.category_labels[c['category']] if hasattr(site,'category_labels') else c['category'],
            'type':c.get('entity_type'),'status':'closed','closed_recorded_at':closure_date(c),
            'archive':{'kind':'closed_history','external_links':'disabled','history':inert(history)}}

class DisableLinks(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=False);self.parts=[];self.stack=[];self.in_main=False;self.script_type=None
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='script':self.script_type=attrs.get('type','javascript')
        if tag=='main': self.in_main=True
        if tag=='a':
            href=attrs.get('href','');u=urlsplit(href)
            off=self.in_main and bool(u.scheme or href.startswith('//')) and u.netloc not in ('commonworld.one','www.commonworld.one')
            self.stack.append(off)
            if off:
                self.parts.append('<span class="archive-link-disabled">');return
        attrs={k:(inert_text(v) if v and k in ('alt','title','content','data-share-text') else v) for k,v in attrs.items() if k not in ('onclick','onmouseover')}
        self.parts.append('<'+tag+''.join(' '+k+(('="'+html.escape(v,quote=True)+'"') if v is not None else '') for k,v in attrs.items())+'>')
    def handle_endtag(self,tag):
        if tag=='main': self.in_main=False
        if tag=='script':self.script_type=None
        if tag=='a' and self.stack and self.stack.pop():self.parts.append('</span>')
        else:self.parts.append('</'+tag+'>')
    def handle_data(self,data):
        if self.script_type and self.script_type != 'application/ld+json':self.parts.append(data);return
        self.parts.append(inert_text(data).replace('↗','') if self.in_main else inert_text(data))
    def handle_entityref(self,name):self.parts.append('&'+name+';')
    def handle_charref(self,name):self.parts.append('&#'+name+';')
    def handle_decl(self,decl):self.parts.append('<!'+decl+'>')
    def handle_comment(self,data):self.parts.append('<!--'+data+'-->')

def html_document(raw):
    p=DisableLinks();p.feed(raw);out=''.join(p.parts)
    out=out.replace(' and reopens automatically if the site answers again.', '. No further automated checks or reopening actions apply to this archived card.')
    out=out.replace('https[:]//schema[.]org','https://schema.org')
    out=out.replace('QA re-checked','Historical QA').replace('Last verified','Last historical observation').replace('Checked claims','Historical claims').replace('last verified','last historical observation').replace('Verified facts','Historical facts').replace('Independent QA re-check','Historical independent QA')
    return out.replace('<main id="main">','<main id="main"><p class="overview-draft"><b>Closed archive.</b> Historical content is retained. External links are disabled and are no longer checked. Closed does not mean dangerous.</p>')

def markdown(raw):
    # Retain labels and inert addresses, but never Markdown outbound destinations.
    raw=re.sub(r'\[([^\]]*)\]\((https?://[^\s)]+)\)',lambda m:m[1]+' ('+inert_text(m[2])+')',raw)
    raw=raw.replace('Last verified','Last historical observation').replace('Checked claims','Historical claims').replace('last verified','last historical observation').replace('Verified facts','Historical facts').replace('Independent QA re-check','Historical independent QA').replace('## Facts','## Historical facts').replace('QA re-checked','Historical QA')
    return inert_text(raw).replace('reopens automatically if the site answers again', 'has no further automated checking or reopening')
