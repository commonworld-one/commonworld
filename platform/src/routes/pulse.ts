/**
 * Pulse API (src/pulse.ts holds the data and the visibility note).
 *
 *   GET /v1/pulse   site totals, activity of the last 24 hours and 7 days, sections and the public
 *                   moderation totals — one read, cached like other public reads.
 */
import type { Ctx } from '../context';
import { json } from '../http';
import { pulseData } from '../pulse';

export async function pulse(c: Ctx): Promise<Response> {
  return json(200, await pulseData(c.env));
}
