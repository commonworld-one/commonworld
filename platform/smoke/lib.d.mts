// Types for lib.mjs (the runner is plain Node so the deploy jobs need no build step; the tests import it from TypeScript).
export interface SmokeEntry {
  id: string;
  path: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  status: number;
  redirect?: string;
  header_contains?: Record<string, string>;
  body_contains?: string[];
  body_not_contains?: string[];
  json_contains?: { pointer: string; contains: string }[];
  added_by: string;
  note?: string;
  skip?: string;
}
export interface SmokeList { version: number; checks: SmokeEntry[]; [k: string]: unknown }
export interface SmokeVars { base: string; environment?: string; post?: number; discoveryError?: string }
export interface SmokeResponse { status: number; headers: Headers | Record<string, string>; body: string }
export interface RunOpts { retries?: number; delayMs?: number; userAgent?: string; signal?: () => AbortSignal | undefined }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const ALLOWED_METHODS: string[];
export const PLACEHOLDERS: string[];
export const FORBIDDEN_HEADER: RegExp;
export function readOnlyRefusal(entry: unknown): string | null;
export function placeholdersOf(entry: SmokeEntry): string[];
export function validateList(list: unknown): string[];
export function expand(s: string, vars: SmokeVars): string;
export function environmentFor(base: string): string | undefined;
export function evaluate(entry: SmokeEntry, res: SmokeResponse, vars: SmokeVars): string[];
export function discover(vars: SmokeVars, fetchImpl: FetchLike, opts?: RunOpts): Promise<SmokeVars>;
export function runEntry(entry: SmokeEntry, vars: SmokeVars, fetchImpl: FetchLike, opts?: RunOpts):
  Promise<{ result: 'PASS' | 'FAIL' | 'SKIP'; line: string; fails: string[] }>;
