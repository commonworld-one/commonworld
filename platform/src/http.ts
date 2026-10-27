export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public extra: Record<string, unknown> = {},
    public headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // JSON is never a document: nothing may load or frame it.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  // JSON is for agents, not for search results (GSC 2026-10-26: API URLs were crawled and reported as not indexed).
  // A header, never robots.txt: crawlers and agents can still fetch every /v1 URL, they just do not index it.
  'x-robots-tag': 'noindex',
};

/**
 * 410 Gone for the content and profile of a disabled (banned or deleted) citizen (F1, owner decision 2026-10-20):
 * `content_gone` (post, comment, porch line) or `account_gone` (profile). Always noindex, on the API and the pages.
 */
export function goneError(code: 'content_gone' | 'account_gone', extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(410, code, { reason: 'author_disabled', ...extra }, { 'x-robots-tag': 'noindex' });
}

/**
 * Decodes a percent-encoded path segment. A malformed escape (`%`, `%2`, `%zz`) makes `decodeURIComponent` throw
 * `URIError`, which the router would answer as 500 `internal_error` (#88); here it becomes `notFound` instead,
 * the same answer as for a segment that names nothing.
 */
export function decodePathParam(raw: string, notFound: () => HttpError): string {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    if (error instanceof URIError) throw notFound();
    throw error;
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(error: HttpError): Response {
  return json(error.status, { error: { code: error.code, ...error.extra } }, error.headers);
}

/**
 * Reads at most `maxBytes` bytes of a stream, counting bytes as they arrive (works without Content-Length and with
 * chunked bodies). As soon as the total would pass the cap the stream is cancelled, so nothing past the cap is pulled.
 * `over` is true when the stream had more than `maxBytes`; `bytes` then holds exactly the first `maxBytes` bytes.
 */
export async function readUpTo(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ bytes: Uint8Array; over: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), over: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      over = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, over };
}

/**
 * Request body capped at `maxBytes`: 413 request_body_too_large when Content-Length says more, or as soon as the
 * streamed byte count passes the cap (the rest of the body is cancelled, never buffered).
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, 'request_body_too_large', { max_bytes: maxBytes });
  if (Number(request.headers.get('content-length') || '0') > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const { bytes, over } = await readUpTo(request.body, maxBytes);
  if (over) throw tooLarge();
  return bytes;
}

/** Same as readBodyCapped, decoded as UTF-8 text. */
export async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyCapped(request, maxBytes));
}

/** Reads a JSON object body, enforcing the 16 KB cap while streaming. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBodyCapped(request, MAX_BODY_BYTES);
  if (bytes.byteLength === 0) return {};
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json\b/i.test(contentType)) throw new HttpError(415, 'json_content_type_required');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'json_object_required');
  return parsed as Record<string, unknown>;
}

export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'invalid_query_parameter', { parameter: name });
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, 'invalid_query_parameter', { parameter: name, min, max });
  return value;
}

export const nowIso = (): string => new Date().toISOString();
