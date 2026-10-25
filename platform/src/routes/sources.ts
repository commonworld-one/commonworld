/** Public source discovery, not an endorsement or a link checker. No outbound fetches. */
import type { Ctx, ReadCtx } from '../context';
import { HttpError, json } from '../http';
import { linkDomains } from '../link-check';
import { shownCommentSql, shownPostSql } from '../views';

export const SOURCES_SCAN = 40;
export const SOURCE_DOMAINS_SHOWN = 20;
export const SOURCES_NOTE = 'Domains cited in public text, not verified sources, endorsements, proof of work or payments. No destination is fetched. Each page scans at most 40 posts and 40 comments; follow next even when items is empty.';
const OWN_HOSTS = new Set(['commonworld.one', 'www.commonworld.one', 'staging.commonworld.one']);
type Cursor = { p: number; c: number };
interface Row { number: number; body: string; title?: string; post_number?: number; handle: string; created_at: string }

export interface SourceItem {
  ref: string; url: string; type: 'post' | 'comment'; post_number: number;
  author: string; created_at: string; domains: string[]; domains_total: number; domains_truncated: boolean;
}
export interface SourcesData {
  items: SourceItem[]; domain: string | null; scanned: { posts: number; comments: number };
  has_more: boolean; next_cursor: string | null; next: string | null; note: string;
}

function cursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw Error();
    const s = raw.replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(atob(s + '='.repeat((4-s.length%4)%4)));
    if (!Array.isArray(j) || j.length !== 2 || j.some(n => !Number.isSafeInteger(n) || n < 0 || n > 999999999999999)) throw Error();
    return { p:j[0], c:j[1] };
  } catch { throw new HttpError(400, 'invalid_sources_cursor'); }
}
const encode = (x: Cursor) => btoa(JSON.stringify([x.p,x.c])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

export function sourceDomain(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  const d = raw.trim().toLowerCase();
  // A host only: accepting a URL here would silently broaden an exact filter.
  if (d.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) {
    throw new HttpError(400, 'invalid_source_domain');
  }
  const normalized = linkDomains([`https://${d}`]);
  if (normalized.length !== 1) throw new HttpError(400, 'invalid_source_domain');
  return normalized[0];
}

export function sourcesPath(base: string, domain: string | null, next?: string | null): string {
  const q = new URLSearchParams();
  if (domain) q.set('domain', domain);
  if (next) q.set('cursor', next);
  return base + (q.size ? '?' + q.toString() : '');
}

export async function sourcesData(c: ReadCtx): Promise<SourcesData> {
  const domain = sourceDomain(c.url.searchParams.get('domain'));
  const at = cursor(c.url.searchParams.get('cursor'));
  const own = new Set([...OWN_HOSTS, c.url.hostname]);
  // Strict descending number cursors are independent: an exhausted stream stays
  // at zero while the other continues. New writes cannot enter older pages.
  const [posts,comments] = await Promise.all([
    c.env.DB.prepare(`SELECT p.number, p.title, p.body, p.created_at, a.handle
      FROM posts p JOIN accounts a ON a.id=p.author_id
      WHERE ${shownPostSql('p')} AND a.status <> 'disabled' AND p.withdrawn_at IS NULL
      AND p.number < ? ORDER BY p.number DESC LIMIT ?`)
      .bind(at?.p ?? 1000000000000000, SOURCES_SCAN+1).all<Row>(),
    c.env.DB.prepare(`SELECT c.number, c.post_number, c.body, c.created_at, a.handle
      FROM comments c JOIN accounts a ON a.id=c.author_id
      WHERE ${shownCommentSql('c')} AND c.withdrawn_at IS NULL
      AND c.number < ? ORDER BY c.number DESC LIMIT ?`)
      .bind(at?.c ?? 1000000000000000, SOURCES_SCAN+1).all<Row>(),
  ]);
  const pp = posts.results.slice(0,SOURCES_SCAN), cc = comments.results.slice(0,SOURCES_SCAN);
  const items: SourceItem[] = [];
  const add = (r:Row,type:'post'|'comment') => {
    const all = linkDomains([r.title ?? '',r.body]).filter(d => !own.has(d));
    if (!all.length || domain && !all.includes(domain)) return;
    const post = type==='post' ? r.number : r.post_number!;
    const domains = domain ? [domain] : all.slice(0,SOURCE_DOMAINS_SHOWN);
    items.push({ref:`${type}-${r.number}`,url:`/posts/${post}${type==='comment'?'#comment-'+r.number:''}`,
      type,post_number:post,author:r.handle,created_at:r.created_at,domains,
      domains_total:all.length,domains_truncated:!domain && all.length>domains.length});
  };
  pp.forEach(r=>add(r,'post')); cc.forEach(r=>add(r,'comment'));
  items.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.ref.localeCompare(b.ref));
  const more = posts.results.length>SOURCES_SCAN || comments.results.length>SOURCES_SCAN;
  const next = more ? encode({p:posts.results.length>SOURCES_SCAN?pp[pp.length-1].number:0,
    c:comments.results.length>SOURCES_SCAN?cc[cc.length-1].number:0}) : null;
  return {items,domain,scanned:{posts:pp.length,comments:cc.length},has_more:more,next_cursor:next,
    next:next?sourcesPath('/v1/sources',domain,next):null,note:SOURCES_NOTE};
}

export async function listSources(c:Ctx):Promise<Response> { return json(200,await sourcesData(c)); }
