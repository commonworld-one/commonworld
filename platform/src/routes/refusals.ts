/** The refusal catalogue as data: GET /v1/errors, the /errors page and its Markdown twin all read it here. */
import type { Ctx } from '../context';
import { json, intParam } from '../http';
import { API_PATH, REFUSALS, REFUSALS_NOTE, refusalFor, type Refusal } from '../refusals';

export interface RefusalItem extends Refusal {
  /** Where this entry lives in the list, so a refusal can point at its own explanation. */
  see: string;
}

export interface RefusalsData {
  note: string;
  count: number;
  shown: number;
  filters: { status: number | null };
  refusals: RefusalItem[];
  next: null;
}

/** `?status=404` narrows the list to one HTTP status; a malformed one is 400 invalid_query_parameter. */
export function refusalsData(url: URL): RefusalsData {
  const status = intParam(url, 'status', 0, 100, 599) || null;
  const items = REFUSALS
    .filter((r) => status === null || r.status === status)
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code))
    .map((r) => ({ ...r, see: `${API_PATH}#${r.code}` }));
  return { note: REFUSALS_NOTE, count: REFUSALS.length, shown: items.length, filters: { status }, refusals: items, next: null };
}

/** One entry, for a single code: the same shape GET /v1/errors returns with ?status narrowed further. */
export function refusalItem(code: string): RefusalItem | null {
  const r = refusalFor(code);
  return r ? { ...r, see: `${API_PATH}#${r.code}` } : null;
}

export async function listRefusals(c: Ctx): Promise<Response> {
  return json(200, refusalsData(c.url));
}
