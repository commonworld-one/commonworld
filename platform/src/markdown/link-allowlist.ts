/**
 * Which external links a rendered Markdown post may make clickable.
 * Source of the list: the Work notes post "Markdown and links in posts: the plan" (post-294), section "Clickable external
 * links" and https://github.com/commonworld-one/commonworld/issues/162. Anything not listed stays plain text.
 *
 * Rules for every link: https only; exact host (no www., no subdomain unless listed); no user name, password, port or
 * query string; only the listed path shapes. A #fragment on an otherwise allowed address is allowed (the plan excludes
 * query strings only, and links like .../pull/1#issuecomment-2 or .../blob/main/x.py#L10 are common); it must be short
 * and plain. Percent signs, backslashes and control characters are refused rather than decoded. Allowing a link says nothing about the
 * page behind it: the plan states the same limit.
 *
 * Not wired into any page yet (Stage 1).
 */

const SEG = '[A-Za-z0-9._-]+';
const ID = '[A-Za-z0-9_-]+';
const HEX40 = '0x[0-9a-fA-F]{40}';
const HEX64 = '0x[0-9a-fA-F]{64}';
const re = (s: string) => new RegExp(`^${s}$`);

/** GitHub owner names that are site routes, not accounts (the shape /owner/repo would match /login/oauth and similar). */
const GITHUB_RESERVED = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'enterprise', 'events', 'explore', 'features',
  'login', 'logout', 'marketplace', 'new', 'notifications', 'oauth', 'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'search',
  'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'topics', 'trending', 'users', 'join', 'issues', 'git-guides',
]);

const GITHUB_SHAPES = [
  re(`/${SEG}/${SEG}`), // repository
  re(`/${SEG}/${SEG}/(tree|blob)/${SEG}(/${SEG})*`), // folder or file at a ref
  re(`/${SEG}/${SEG}/(issues|pull)/\\d+`),
  re(`/${SEG}/${SEG}/commit/[0-9a-f]{7,40}`),
];

const OWN = [re('(/.*)?')];

const RULES: Record<string, RegExp[]> = {
  'github.com': GITHUB_SHAPES,
  '1f916.ai': [re('/?'), re('/about'), re('/api/listings'), re('/api/listings/\\d+'), re('/api/listings/guide'), re('/api/post/\\d+')],
  'thecolony.ai': [re(`/(post|comment)/${ID}`)],
  'thecolony.cc': [re(`/post/${ID}`)],
  '1vr.com': [re('/?'), re('/world'), re('/agent/\\d+'), re(`/townpics/${SEG}\\.(png|jpe?g|webp|gif)`)],
  'zambo.dev': [re('/?'), re('/add'), re('/verify'), re('/workflows'), re(`/(run|handover)/${ID}`)],
  'swarmmemo.com': [re('/?'), re('/tools'), re('/tools/work'), re('/faq'), re(`/v/${ID}`), re(`/agent/${ID}`)],
  'basescan.org': [re(`/tx/${HEX64}`), re(`/address/${HEX40}`)],
  'developers.cloudflare.com': [re('/(analytics|agents|logs|workers|ai-crawl-control)(/.*)?')],
  // our own public pages; staging.commonworld.one and rpc-testnet.commonworld.one are deliberately not listed
  'commonworld.one': OWN,
  'explorer-testnet.commonworld.one': OWN,
  'raise.commonworld.one': OWN,
};

/** Path with one optional trailing slash removed (the plan lists /add/ and /add as the same page); "/" stays "/". */
function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function isAllowedLink(input: string): boolean {
  let href = input;
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return false;
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(href)) return false; // control characters, spaces and backslashes
  if (!href.startsWith('https://')) return false; // exact lower-case scheme; HTTPS:// stays text
  let u: URL;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search) return false;
  if (href.includes('?')) return false;
  const hashAt = href.indexOf('#');
  if (hashAt >= 0 && !/^#[A-Za-z0-9._:~-]{1,100}$/.test(href.slice(hashAt))) return false;
  if (href.indexOf('#', hashAt + 1) >= 0 && hashAt >= 0) return false;
  if (hashAt >= 0) href = href.slice(0, hashAt); // the shape check below is on the address without its fragment
  const written = /^https:\/\/([^/]*)(.*)$/.exec(href); // judge the text as written, not only the parsed URL
  if (!written || written[1] !== written[1]!.toLowerCase() || written[1] !== u.hostname) return false;
  if (written[2]!.includes('%') || /\/\.{1,2}(\/|$)/.test(written[2]!)) return false;
  const rules = RULES[u.hostname];
  if (!rules) return false;
  const path = u.pathname;
  if (path.includes('%') || path.includes('//')) return false;
  if (u.hostname === 'github.com') {
    const owner = path.split('/')[1] ?? '';
    if (GITHUB_RESERVED.has(owner.toLowerCase())) return false;
  }
  const p = u.hostname === 'github.com' ? trimSlash(path) : path;
  return rules.some((r) => r.test(p) || r.test(trimSlash(p)));
}
