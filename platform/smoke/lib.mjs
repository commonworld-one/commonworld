/**
 * Route smoke list: validation and evaluation (no I/O of its own; the caller passes fetch).
 * The list is platform/smoke/routes.json, the runner platform/scripts/smoke.mjs, the docs docs/DEPLOY.md
 * ("Route smoke list after every deploy"). Read-only by construction: only GET and HEAD are accepted.
 *
 * Placeholders in path, header values and expected strings:
 *   {base}         the base URL the run targets, without a trailing slash (https://staging.commonworld.one)
 *   {environment}  the expected /health environment (staging, production); from --environment or the host name
 *   {post}         the number of the newest public post, read at run time from /v1/posts?limit=1
 */

export const ALLOWED_METHODS = ['GET', 'HEAD'];
export const PLACEHOLDERS = ['base', 'environment', 'post'];
/** Request headers that carry credentials; never sent by the smoke list (case-insensitive). */
export const FORBIDDEN_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token)$/i;
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrMap = (v) => isMap(v) && Object.values(v).every((x) => typeof x === 'string');
const ENTRY_KEYS = new Set(['id', 'path', 'method', 'headers', 'status', 'redirect', 'header_contains', 'body_contains',
  'body_not_contains', 'json_contains', 'added_by', 'note', 'skip']);

/** Placeholder names used anywhere in an entry's request or expectations. */
export function placeholdersOf(entry) {
  const found = new Set();
  const scan = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(/\{([a-z_]+)\}/g)) found.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  // JSON pointers are literal ({slug} in an OpenAPI path); a malformed json_contains is reported by validateList
  const jsonContains = Array.isArray(entry.json_contains) ? entry.json_contains.map((j) => (isMap(j) ? j.contains : undefined)) : [];
  scan([entry.path, entry.headers, entry.redirect, entry.header_contains, entry.body_contains, entry.body_not_contains, jsonContains]);
  return [...found];
}

/** Every problem in the list as a sentence; empty = valid. */
export function validateList(list) {
  const errors = [];
  if (!list || typeof list !== 'object' || !Array.isArray(list.checks)) return ['the list must be an object with a "checks" array'];
  if (list.version !== 1) errors.push('"version" must be 1');
  const ids = new Set();
  const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
  list.checks.forEach((e, i) => {
    const at = `checks[${i}]${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object') { errors.push(`${at}: not an object`); return; }
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`);
    if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(e.id)) errors.push(`${at}: "id" must be lowercase letters, digits, dots and dashes`);
    else if (ids.has(e.id)) errors.push(`${at}: duplicate id`);
    else ids.add(e.id);
    if (typeof e.path !== 'string' || !e.path.startsWith('/') || e.path.startsWith('//')) errors.push(`${at}: "path" must start with one "/"`);
    if (e.method !== undefined && !ALLOWED_METHODS.includes(e.method)) errors.push(`${at}: "method" must be GET or HEAD (the smoke list is read-only)`);
    if (!Number.isInteger(e.status) || e.status < 100 || e.status > 599) errors.push(`${at}: "status" must be an HTTP status code`);
    if (typeof e.added_by !== 'string' || !/^#\d+( #\d+)*$/.test(e.added_by)) errors.push(`${at}: "added_by" must name the PR or issue, e.g. "#224"`);
    if (e.headers !== undefined && !isStrMap(e.headers)) errors.push(`${at}: "headers" must map names to strings`);
    if (isMap(e.headers) && Object.keys(e.headers).some((h) => FORBIDDEN_HEADER.test(h))) errors.push(`${at}: no credentials in the smoke list`);
    if (e.header_contains !== undefined && !isStrMap(e.header_contains)) errors.push(`${at}: "header_contains" must map header names to strings`);
    for (const k of ['body_contains', 'body_not_contains']) if (e[k] !== undefined && !isStrArr(e[k])) errors.push(`${at}: "${k}" must be a list of non-empty strings`);
    if (e.json_contains !== undefined && !(Array.isArray(e.json_contains) && e.json_contains.every((j) => isMap(j) && typeof j.pointer === 'string' && (j.pointer === '' || j.pointer.startsWith('/')) && typeof j.contains === 'string'))) errors.push(`${at}: "json_contains" must be a list of {pointer, contains}`);
    if (e.redirect !== undefined && (typeof e.redirect !== 'string' || !(e.status >= 300 && e.status < 400))) errors.push(`${at}: "redirect" needs a string target and a 3xx "status"`);
    if (e.method === 'HEAD' && (e.body_contains || e.body_not_contains || e.json_contains)) errors.push(`${at}: a HEAD check has no body to look into`);
    if (e.skip !== undefined && (typeof e.skip !== 'string' || !e.skip.trim())) errors.push(`${at}: "skip" must say why the check is skipped`);
    for (const p of placeholdersOf(e)) if (!PLACEHOLDERS.includes(p)) errors.push(`${at}: unknown placeholder {${p}}`);
  });
  return errors;
}

/** Replace {name} with vars[name]; throws on a placeholder without a value. */
export function expand(s, vars) {
  return s.replace(/\{([a-z_]+)\}/g, (_, k) => {
    if (vars[k] === undefined || vars[k] === null || vars[k] === '') throw new Error(`no value for {${k}}`);
    return String(vars[k]);
  });
}

/** Expected /health environment from the host when --environment is not given. */
export function environmentFor(base) {
  const host = new URL(base).hostname;
  if (host === 'commonworld.one' || host === 'www.commonworld.one') return 'production';
  if (host === 'staging.commonworld.one') return 'staging';
  return undefined;
}

function pointerGet(doc, pointer) {
  if (pointer === '') return doc;
  let cur = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Compare one response with an entry. `res` = {status, headers (Headers or a lower-case object), body (string)}.
 * Returns the list of failures; empty = PASS.
 */
export function evaluate(entry, res, vars) {
  const fails = [];
  const header = (n) => (typeof res.headers.get === 'function' ? res.headers.get(n) : res.headers[n.toLowerCase()]) ?? null;
  if (res.status !== entry.status) fails.push(`status ${res.status}, expected ${entry.status}`);
  if (entry.redirect !== undefined) {
    const want = new URL(expand(entry.redirect, vars), vars.base + '/').href;
    const loc = header('location');
    const got = loc === null ? null : new URL(loc, vars.base + '/').href;
    if (got !== want) fails.push(`redirect to ${loc ?? '(no Location)'}, expected ${want}`);
  }
  for (const [name, sub] of Object.entries(entry.header_contains ?? {})) {
    const v = header(name); const s = expand(sub, vars);
    if (v === null || !v.includes(s)) fails.push(`header ${name} ${v === null ? 'missing' : `"${v.slice(0, 160)}"`} lacks "${s}"`);
  }
  for (const sub of entry.body_contains ?? []) { const s = expand(sub, vars); if (!res.body.includes(s)) fails.push(`body lacks "${s}"`); }
  for (const sub of entry.body_not_contains ?? []) { const s = expand(sub, vars); if (res.body.includes(s)) fails.push(`body has "${s}"`); }
  if (entry.json_contains?.length) {
    let doc; try { doc = JSON.parse(res.body); } catch { fails.push('body is not JSON'); }
    if (doc !== undefined) for (const j of entry.json_contains) {
      const v = pointerGet(doc, j.pointer); const s = expand(j.contains, vars);
      const text = typeof v === 'string' ? v : v === undefined ? undefined : JSON.stringify(v);
      if (text === undefined) fails.push(`JSON ${j.pointer} missing`);
      else if (!text.includes(s)) fails.push(`JSON ${j.pointer} lacks "${s}"`);
    }
  }
  return fails;
}

/** Fill {post}: the newest public post (GET /v1/posts?limit=1). Leaves it unset when that fails. */
export async function discover(vars, fetchImpl, opts = {}) {
  try {
    const r = await fetchImpl(`${vars.base}/v1/posts?limit=1`, { headers: { accept: 'application/json', 'user-agent': opts.userAgent ?? 'commonworld-smoke' }, redirect: 'manual', signal: opts.signal?.() });
    const j = r.status === 200 ? await r.json() : null;
    const n = j?.items?.[0]?.number;
    if (Number.isInteger(n)) vars.post = n;
    else vars.discoveryError = `GET /v1/posts?limit=1 gave ${r.status} and no post number`;
  } catch (err) {
    vars.discoveryError = `GET /v1/posts?limit=1 failed: ${err?.message ?? err}`;
  }
  return vars;
}

/** Why an entry may not be sent (a write method, credential headers, malformed headers); null = it is read-only. */
export function readOnlyRefusal(entry) {
  const method = entry?.method ?? 'GET';
  if (!ALLOWED_METHODS.includes(method)) return `method ${String(method)} is not GET or HEAD (the smoke list is read-only)`;
  if (entry.headers !== undefined && !isStrMap(entry.headers)) return '"headers" must map names to strings';
  const bad = Object.keys(entry.headers ?? {}).filter((h) => FORBIDDEN_HEADER.test(h));
  if (bad.length) return `credential header ${bad.join(', ')} is never sent`;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one entry: {result: 'PASS' | 'FAIL' | 'SKIP', line, fails}. Retries a failed check (new deploys and the edge
 * cache, s-maxage up to 300 s on the catalog, can lag for a moment); the last attempt decides.
 */
export async function runEntry(entry, vars, fetchImpl, opts = {}) {
  const method = entry.method ?? 'GET';
  const label = `${entry.id} ${method} ${entry.path} [${entry.added_by}]`;
  // Read-only even when called directly (without validateList): refuse before any request is made.
  const refused = readOnlyRefusal(entry);
  if (refused) return { result: 'FAIL', line: `FAIL ${label}: refused, ${refused}`, fails: [`refused, ${refused}`] };
  if (entry.skip) return { result: 'SKIP', line: `SKIP ${label}: ${entry.skip}`, fails: [] };
  let url; let headers;
  try {
    url = vars.base + expand(entry.path, vars);
    headers = { 'user-agent': opts.userAgent ?? 'commonworld-smoke', ...Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, expand(v, vars)])) };
    for (const p of placeholdersOf(entry)) expand(`{${p}}`, vars); // every placeholder must have a value before we start
  } catch (err) {
    const why = `${err.message}${vars.discoveryError && /\{post\}/.test(err.message) ? ` (${vars.discoveryError})` : ''}`;
    return { result: 'FAIL', line: `FAIL ${label}: ${why}`, fails: [why] };
  }
  const attempts = Math.max(1, (opts.retries ?? 0) + 1);
  let fails = []; let status = 0;
  for (let a = 1; a <= attempts; a++) {
    try {
      const r = await fetchImpl(url, { method, headers, redirect: 'manual', signal: opts.signal?.() });
      status = r.status;
      const body = method === 'HEAD' ? '' : await r.text();
      fails = evaluate(entry, { status: r.status, headers: r.headers, body }, vars);
    } catch (err) {
      status = 0; fails = [`request failed: ${err?.message ?? err}`];
    }
    if (!fails.length) break;
    if (a < attempts) await sleep(opts.delayMs ?? 10_000);
  }
  return fails.length
    ? { result: 'FAIL', line: `FAIL ${label} -> ${status}: ${fails.join('; ')}`, fails }
    : { result: 'PASS', line: `PASS ${label} -> ${status}`, fails };
}
