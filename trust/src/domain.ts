/** Domain normalisation and the candidate names a blocklist entry may be written under. */

/** Shared hosting / platform suffixes: a listing of one of THESE as a whole would flag every site on them, so a
 * parent-domain match never climbs to them (a subdomain is matched only by its own exact name). */
export const SHARED_SUFFIXES = new Set([
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'onrender.com', 'fly.dev', 'railway.app', 'replit.app', 'repl.co', 'glitch.me', 'gitbook.io',
  'notion.site', 'webflow.io', 'framer.website', 'framer.app', 'wixsite.com', 'weebly.com', 'weeblysite.com',
  'blogspot.com', 'wordpress.com', 'carrd.co', 'super.site', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
  'amazonaws.com', 'r2.dev', 'ipfs.io', 'dweb.link', 'fleek.co', 'on-fleek.app', 'surge.sh', 'translate.goog',
  '000webhostapp.com', 'myshopify.com', 'square.site', 'godaddysites.com', 'sites.google.com', 'medium.com', 'substack.com',
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'com.cn', 'co.kr', 'com.tr', 'com.mx',
]);

/** Outcome of reading the host name of a link or domain input (see hostOf). */
export interface HostInfo {
  /** Normalized domain ('' unless status is 'domain'). */
  domain: string;
  /** domain: a usable domain name. empty: no input. not_a_domain: a well-formed name with no dot (localhost, an
   * intranet name) or an IP literal in brackets, which no domain blocklist can list. unreadable: a host a browser may
   * still resolve but that cannot be reduced to a plain domain name (the parser rejects it, or it keeps characters or a
   * label structure no domain name has); a safety check must treat it as unsafe rather than skip it. */
  status: 'domain' | 'empty' | 'not_a_domain' | 'unreadable';
}

const HOST_CHARS = /^[a-z0-9_.-]+$/;

/**
 * Reads the host the way a browser does: the WHATWG URL parser (Node and Cloudflare Workers alike) applies IDNA
 * mapping (so the label separators U+3002, U+FF0E and U+FF61 become '.', full-width letters become ASCII), percent-
 * decodes the host, turns Unicode labels into punycode (xn--), lower-cases, drops userinfo and port, and treats '\' as
 * '/'. Input with or without a scheme gives the same answer (any scheme is read as https so the host is always parsed as
 * a special-scheme host). Then trailing dots are dropped and leading "www." labels are removed while a dot remains.
 */
export function hostOf(input: string): HostInfo {
  let s = String(input ?? '').trim();
  if (!s) return { domain: '', status: 'empty' };
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  let host: string;
  try { host = new URL('https://' + s).hostname; } catch { return { domain: '', status: 'unreadable' }; }
  if (host.startsWith('[')) return { domain: '', status: 'not_a_domain' };  // IPv6 literal
  host = host.replace(/\.+$/, '');
  while (host.startsWith('www.') && host.indexOf('.', 4) > 0) host = host.slice(4);
  if (!host) return { domain: '', status: 'empty' };
  if (!HOST_CHARS.test(host) || host.startsWith('.') || host.includes('..')) return { domain: '', status: 'unreadable' };
  if (!host.includes('.')) return { domain: '', status: 'not_a_domain' };
  return { domain: host, status: 'domain' };
}

/** 'HTTPS://WWW.Example.com./x', 'Example.com' or 'u:p@Example.com:8080' -> 'example.com'; 'bücher.de' ->
 * 'xn--bcher-kva.de'; 'example\u3002com' and 'example%2Ecom' -> 'example.com' (see hostOf). Returns '' when there is no
 * usable domain name: callers that guard publishing must not read '' as safe (use hostOf to tell why). Idempotent. */
export function normalizeDomain(input: string): string {
  return hostOf(input).domain;
}

/** Names under which a blocklist would list `domain`: the domain itself, its www. form, and each parent domain with at
 * least two labels that is not a shared platform suffix (so `app.evil.example` matches a listing of `evil.example`,
 * but `mysite.vercel.app` never matches a listing of `vercel.app`). */
export function candidates(domain: string): string[] {
  const d = normalizeDomain(domain);
  if (!d) return [];
  const out = [d, 'www.' + d];
  const labels = d.split('.');
  for (let i = 1; i <= labels.length - 2; i++) {
    const parent = labels.slice(i).join('.');
    if (SHARED_SUFFIXES.has(parent)) break;
    out.push(parent);
  }
  return out;
}
