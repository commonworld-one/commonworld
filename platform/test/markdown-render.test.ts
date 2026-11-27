// Stage 1 of Markdown in posts (post-294, issue #162): the renderer and the link allowlist exist and are tested, but
// nothing in the app calls them. These tests are the whole contract of that stage.
import { describe, expect, it } from 'vitest';
import { isAllowedLink } from '../src/markdown/link-allowlist';
import { MAX_MARKDOWN_CHARS, renderMarkdown } from '../src/markdown/render';

const render = (s: string): string => {
  const h = renderMarkdown(s);
  if (h === null) throw new Error('renderMarkdown returned null');
  return h;
};

// ---- a scanner for the output: only the planned subset of tags and attributes, and only allowlisted links
const TAGS = new Set('p a em strong ul ol li blockquote code pre h2 h3 h4 br table thead tbody tr th td'.split(' '));
const ATTRS: Record<string, string[]> = { a: ['href', 'rel', 'title'], th: ['style'], td: ['style'], ol: ['start'], code: ['class'] };
function scan(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const closing = m[1] === '/', tag = m[2]!.toLowerCase(), attrs = m[3] ?? '';
    if (!TAGS.has(tag)) { problems.push(`tag ${tag}`); continue; }
    if (closing) continue;
    for (const a of attrs.matchAll(/\s([a-zA-Z-]+)="[^"]*"/g)) if (!(ATTRS[tag] ?? []).includes(a[1]!.toLowerCase())) problems.push(`${tag}@${a[1]}`);
    if (attrs.replace(/\s[a-zA-Z-]+="[^"]*"/g, '').trim() !== '') problems.push(`odd attribute text in ${tag}`);
    if (tag === 'a') {
      const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (!isAllowedLink(href.replace(/&amp;/g, '&'))) problems.push(`href ${href}`);
      if (!/rel="ugc noopener"/.test(attrs)) problems.push('a without rel');
    }
  }
  return problems;
}

describe('link allowlist (post-294)', () => {
  const yes = [
    'https://github.com/commonworld-one/commonworld', 'https://github.com/commonworld-one/commonworld/', 'https://github.com/a/b/issues/162', 'https://github.com/a/b/pull/158#issuecomment-7063571089', 'https://github.com/a/b/blob/main/x.py#L10-L20', 'https://zambo.dev/workflows/#check-contradictions', `https://basescan.org/address/0x${'a'.repeat(40)}#code`, 'https://commonworld.one/posts/116#comment-173',
    'https://github.com/apps/cw-instinct', 'https://github.com/a/b/pull/337', 'https://github.com/a/b/commit/e7932eaa', 'https://github.com/a/b/blob/main/platform/src/http.ts',
    'https://github.com/a/b/tree/main/docs', 'https://1f916.ai/', 'https://1f916.ai', 'https://1f916.ai/about', 'https://1f916.ai/api/listings',
    'https://1f916.ai/api/listings/61', 'https://1f916.ai/api/listings/guide', 'https://1f916.ai/api/post/3525',
    'https://thecolony.ai/post/0d14cb5c-f1f8-4848-8bd3-506cd794448a', 'https://thecolony.ai/comment/16a06750-e465-473d-b305-bcc85cb44b94',
    'https://thecolony.cc/post/c9591ea5-c1b1-4a05-b537-258a63e71dbb', 'https://1vr.com', 'https://1vr.com/world', 'https://1vr.com/agent/12',
    'https://1vr.com/townpics/abc.png', 'https://zambo.dev/', 'https://zambo.dev/add/', 'https://zambo.dev/verify', 'https://zambo.dev/workflows/',
    'https://zambo.dev/run/abc-123', 'https://zambo.dev/handover/d468118b-afc1-43e5-a70c-5e198e876a04', 'https://swarmmemo.com/tools',
    'https://swarmmemo.com/tools/work', 'https://swarmmemo.com/faq', 'https://swarmmemo.com/v/2a948de71bd8', 'https://swarmmemo.com/agent/abc',
    `https://basescan.org/tx/0x${'b'.repeat(64)}`, `https://basescan.org/address/0x${'a'.repeat(40)}`, 'https://developers.cloudflare.com/workers/',
    'https://developers.cloudflare.com/ai-crawl-control/configuration', 'https://commonworld.one/posts/12', 'https://explorer-testnet.commonworld.one/',
    'https://raise.commonworld.one/',
  ];
  const no = [
    'http://github.com/a/b', 'HTTPS://github.com/a/b', 'https://www.github.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b#a b', 'https://github.com/a/b#%41', 'https://github.com/a/b#<x>', 'https://github.com/a/b##x', 'https://github.com/a/b#', 'https://github.com/a/b/issues/new#x', 'https://evil.example/#x',
    'https://user@github.com/a/b', 'https://user:pw@github.com/a/b', 'https://github.com:8080/a/b', 'https://github.com/login', 'https://github.com/login/oauth/authorize',
    'https://github.com/settings/tokens', 'https://github.com/a/b/issues/new', 'https://github.com/a/b/archive/refs/heads/main.zip', 'https://github.com/a/b/raw/main/x',
    'https://github.com/a/b/releases/download/v1/x.zip', 'https://github.com/a', 'https://github.com/', 'https://github.com/a/b/blob/main/%2e%2e/x', 'https://github.com/a/b/../c/d',
    'https://1f916.ai/api/payouts', 'https://1f916.ai/api/listings/abc', 'https://thecolony.ai/', 'https://thecolony.cc/comment/abc', 'https://1vr.com/skill.md', 'https://1vr.com/mcp/skill-store',
    'https://1vr.com/api/v1/skills/search', 'https://zambo.dev/mcp', 'https://swarmmemo.com/tools?ref=x', 'https://swarmmemo.com/api/works', 'https://basescan.org/token/0x1',
    'https://basescan.org/address/0x12', 'https://developers.cloudflare.com/', 'https://developers.cloudflare.com/pages/', 'https://staging.commonworld.one/', 'https://rpc-testnet.commonworld.one/',
    'https://commonworld.one/posts/12?x=1', 'https://commonworld.one:8443/', 'https://evil.example/', 'https://commonworld.one.evil.example/', 'https://evil.example/https://commonworld.one/',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'mailto:a@b.c', '//github.com/a/b', '/relative', '#frag', '', 'https://github.com/a/b c', 'https://github.com\\@evil.example/x',
    'https://github.com/a/b\n', 'https://github.com./a/b', 'https://GITHUB.com/a/b',
  ];
  it.each(yes)('allows %s', (u) => expect(isAllowedLink(u)).toBe(true));
  it.each(no)('refuses %j', (u) => expect(isAllowedLink(u)).toBe(false));
});

describe('renderMarkdown', () => {
  it('renders the planned subset', () => {
    const h = render('# T\n\nA **bold** and *it* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nfence\n```');
    for (const t of ['<strong>bold</strong>', '<em>it</em>', '<code>code</code>', '<ul>', '<ol>', '<blockquote>', '<table>', '<pre><code>', '<h2>T</h2>']) expect(h).toContain(t);
    expect(scan(h)).toEqual([]);
  });

  it('shows headings below the page title (h2 to h4)', () => {
    const h = render('# one\n\n## two\n\n### three\n\n#### four\n\n###### six\n\nSetext\n======');
    expect(h).not.toMatch(/<h1|<h5|<h6/);
    for (const t of ['<h2>one</h2>', '<h3>two</h3>', '<h4>three</h4>', '<h4>four</h4>', '<h4>six</h4>', '<h2>Setext</h2>']) expect(h).toContain(t);
  });

  it('shows what is outside the approved subset as typed', () => {
    const h = render('~~gone~~\n\n***\n\n![alt](https://evil.example/a.png)');
    expect(h).toContain('~~gone~~');
    expect(h).toContain('***');
    expect(h).not.toMatch(/<s>|<hr|<img|<del/);
  });

  it('keeps single line breaks, as post pages do today', () => {
    expect(render('line one\nline two')).toBe('<p>line one<br>\nline two</p>\n');
  });

  it('shows raw HTML as text', () => {
    const h = render('<script>alert(1)</script> <img src=x onerror=alert(1)> <svg onload=alert(1)>\n\n<div onclick="x()">hi</div>\n\n<!-- c -->\n\n    <script>1</script>\n\n```html\n<script>1</script>\n```');
    expect(h).not.toMatch(/<script|<img|<svg|<div|<!--/i);
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(scan(h)).toEqual([]);
  });

  it('makes an allowlisted link clickable with rel ugc noopener, and nothing else', () => {
    const h = render('[repo](https://github.com/commonworld-one/commonworld) and <https://commonworld.one/posts/12> and [t](https://github.com/a/b "title")');
    expect(h).toContain('<a href="https://github.com/commonworld-one/commonworld" rel="ugc noopener">repo</a>');
    expect(h).toContain('<a href="https://commonworld.one/posts/12" rel="ugc noopener">https://commonworld.one/posts/12</a>');
    expect(h).toContain('title="title"');
    expect(scan(h)).toEqual([]);
  });

  it('keeps every other link as the exact source text', () => {
    const cases: [string, string][] = [
      ['[a](http://github.com/a/b)', '[a](http://github.com/a/b)'],
      ['[a](https://evil.example/x "t")', '[a](https://evil.example/x &quot;t&quot;)'],
      ['<https://evil.example/x>', '&lt;https://evil.example/x&gt;'],
      ['[a](https://github.com/a/b?x=1)', '[a](https://github.com/a/b?x=1)'],
      ['[a](<https://evil.example/x y>)', '[a](&lt;https://evil.example/x y&gt;)'],
      ['![x](https://evil.example/t.png)', '![x](https://evil.example/t.png)'],
      ['![x](https://github.com/a/b)', '![x](https://github.com/a/b)'],
      ['[x][y]\n\n[y]: https://evil.example/', '[x][y]'],
      ['https://evil.example/y and www.evil.example', 'https://evil.example/y and www.evil.example'],
      ['[**bold** x](https://evil.example)', '[**bold** x](https://evil.example)'],
      ['[a](https://github.com/a/b%0Ac)', '[a](https://github.com/a/b%0Ac)'],
      ['see [a](http://github.com/a/b) here', 'see [a](http://github.com/a/b) here'],
      ['*x [a](https://evil.example/p) y* and <https://evil.example/q> z', '<em>x [a](https://evil.example/p) y</em> and &lt;https://evil.example/q&gt; z'],
      ['wow![x](https://evil.example/t.png) end', 'wow![x](https://evil.example/t.png) end'],
    ];
    for (const [src, shown] of cases) {
      const h = render(src);
      expect(h, src).toContain(shown);
      expect(h, src).not.toContain('<a ');
      expect(scan(h), src).toEqual([]);
    }
  });

  it('never makes javascript:, data: or vbscript: links', () => {
    const h = render('[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](java&#x0A;script:alert(1)) [d]( javascript:alert(1)) [e](data:text/html,<script>1</script>) [f](vbscript:x) <javascript:alert(1)>');
    expect(h).not.toContain('<a ');
    expect(h).not.toMatch(/href=/i);
    expect(scan(h)).toEqual([]);
  });

  it('does not break out of an attribute', () => {
    const h = render('[a](https://github.com/a/b" onmouseover="x) [b](<https://github.com/a/b> "t\\" onclick=\\"x")');
    expect(scan(h)).toEqual([]);
    expect(h).not.toMatch(/\sonmouseover="/);
  });

  it('survives a link inside emphasis, quotes, lists and tables (the case that crashed a token-rewriting design)', () => {
    for (const s of ['*a [b](https://evil.example) c*', '**[x](http://github.com/a/b)** _[y](https://github.com/a/b)_', '> [a](https://evil.example)\n\n- [b](https://evil.example)\n- [c](https://github.com/a/b)', '| [a](https://evil.example) | [b](https://github.com/a/b) |\n|---|---|\n| x | y |']) {
      const h = renderMarkdown(s);
      expect(h, s).not.toBeNull();
      expect(scan(h!), s).toEqual([]);
    }
    expect(render('*a [b](https://evil.example) c*')).toContain('<em>a [b](https://evil.example) c</em>');
  });

  it('handles Unicode and long adversarial input without throwing', () => {
    const rep = (s: string) => s.repeat(Math.ceil(MAX_MARKDOWN_CHARS / s.length)).slice(0, MAX_MARKDOWN_CHARS);
    const inputs = ['[', '[a](', '![a](', '*', '*a ', '_a', '`', '`a', '>', '> ', '- ', '1. ', '<', '<a ', '&#x41;&amp;', '\\', '<!--', '<https://github.com/a/b>', '[a](https://evil.example/x) ', '[a](https://github.com/a/b) ', '*_*_*_', '😀é', '|a|b|\n|-|-|\n|1|2|\n', '\n'];
    for (const s of inputs) {
      const h = renderMarkdown(rep(s));
      expect(h === null || typeof h === 'string', s).toBe(true);
      if (h !== null) expect(scan(h), s).toEqual([]);
    }
    expect(render('😀 é *x*')).toBe('<p>😀 é <em>x</em></p>\n');
  });

  it('refuses input over the post limit instead of rendering it', () => {
    expect(renderMarkdown('a'.repeat(MAX_MARKDOWN_CHARS + 1))).toBeNull();
    expect(renderMarkdown('a'.repeat(MAX_MARKDOWN_CHARS))).not.toBeNull();
  });
});

describe('Markdown wiring is scoped (Stage 2)', () => {
  it('only the approved sources import the renderer or the allowlist', () => {
    // every source file as text (Vite raw imports; the tests run inside the Workers runtime, which has no file system)
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
    const names = Object.keys(files);
    expect(names.length).toBeGreaterThan(40); // the glob really found the sources
    const hits = names.filter((n) => !n.includes('/src/markdown/') && /markdown\/(render|link-allowlist)|from ['"]markdown-it['"]/.test(files[n]!));
    // post-body.ts is the one place that renders a post body (the page and the preview both call it)
    expect(hits.map((n) => n.replace(/^.*\/src\//, ''))).toEqual(['pages/post-body.ts']);
  });
  it('only the post page and the content routes (create, preview) import post-body', () => {
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
    const hits = Object.keys(files).filter((n) => !n.endsWith('/pages/post-body.ts') && /from ['"][./]*(pages\/)?post-body(\.ts)?['"]/.test(files[n]!)).map((n) => n.replace(/^.*\/src\//, '')).sort();
    expect(hits).toEqual(['pages/post.ts', 'routes/content.ts']);
  });
});
