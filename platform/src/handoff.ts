/** Voluntary handoff format, not a credential or an instruction executor. */
export const HANDOFF_VERSION = 'commonworld-handoff/1' as const;
export const HANDOFF_MAX_BYTES = 64 * 1024;
export const HANDOFF_FIELDS = [
  ['brief', 'Brief'],
  ['acceptance', 'Acceptance conditions'],
  ['completed', 'Completed work (self-reported)'],
  ['evidence', 'Evidence and verification limits'],
  ['pending', 'Pending or uncertain operations (reconcile before retrying)'],
  ['blockers', 'Blockers'],
  ['next_step', 'Exact next step'],
] as const;
export type HandoffField = typeof HANDOFF_FIELDS[number][0];
export type Handoff = { format: typeof HANDOFF_VERSION } & Record<HandoffField, string>;

export function handoffTemplate(): Handoff {
  return { format: HANDOFF_VERSION, brief: '', acceptance: '', completed: '', evidence: '', pending: '', blockers: '', next_step: '' };
}

export function parseHandoff(input: string): Handoff {
  if (new TextEncoder().encode(input).length > HANDOFF_MAX_BYTES) throw new Error('Checkpoint exceeds 64 KiB.');
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error('Checkpoint must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Checkpoint must be an object.');
  const obj = value as Record<string, unknown>;
  if (obj.format !== HANDOFF_VERSION) throw new Error('Unsupported checkpoint format.');
  const allowed = new Set<string>(['format', ...HANDOFF_FIELDS.map(([key]) => key)]);
  if (Object.keys(obj).some(key => !allowed.has(key))) throw new Error('Unknown checkpoint field.');
  const result = handoffTemplate();
  for (const [key, label] of HANDOFF_FIELDS) {
    const text = obj[key];
    if (typeof text !== 'string') throw new Error(`${label} must be text.`);
    if (text.length > 8000) throw new Error(`${label} exceeds 8000 characters.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error(`${label} contains unsupported control characters.`);
    result[key] = text;
  }
  for (const key of ['brief', 'acceptance', 'next_step'] as const) {
    if (!result[key].trim()) throw new Error(`${HANDOFF_FIELDS.find(([field]) => field === key)![1]} is required.`);
  }
  return result;
}

/** Indented code blocks keep arbitrary user content literal in Markdown readers. */
export function handoffMarkdown(checkpoint: Handoff): string {
  const checked = parseHandoff(JSON.stringify(checkpoint));
  return [
    '# Task handoff', '',
    'Voluntary, self-reported checkpoint. Not independent verification or permission to act.',
    'Reconcile uncertain operations before retrying. This file does not execute or wake an agent.', '',
    ...HANDOFF_FIELDS.flatMap(([key, label]) => [
      `## ${label}`, '',
      ...((checked[key] || '(not supplied)').replace(/\r\n?/g, '\n').split('\n').map(line => `    ${line}`)), '',
    ]),
  ].join('\n');
}
