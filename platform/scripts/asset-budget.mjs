/**
 * File-count budget for the Static Assets directory (issue #133). Cloudflare allows 20,000 files per Worker version on
 * Workers Free and 100,000 on Workers Paid (Wrangler 4.34.0 or higher):
 * https://developers.cloudflare.com/workers/platform/limits/ (section Static Assets). The account runs Workers Paid, so the
 * build warns from 50,000 files and fails above 90,000, before the upload would be refused.
 */
export const FILE_WARN = 50_000;
export const FILE_FAIL = 90_000;

/** 'ok' up to FILE_WARN - 1, 'warn' from FILE_WARN to FILE_FAIL, 'fail' above FILE_FAIL. */
export function fileCountVerdict(files) {
  if (files > FILE_FAIL) return 'fail';
  if (files >= FILE_WARN) return 'warn';
  return 'ok';
}
