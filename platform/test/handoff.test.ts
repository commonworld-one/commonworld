import { describe, expect, it } from 'vitest';
import { handoffTemplate, parseHandoff, handoffMarkdown, HANDOFF_MAX_BYTES } from '../src/handoff';

const example = () => ({ ...handoffTemplate(), brief: 'Inspect Ω\nзадача', acceptance: 'Compare actual output with source', next_step: 'Reconcile operation 42 before retrying' });

describe('voluntary handoff format', () => {
  it('round-trips Unicode, multiline content and uncertain operations without inferring completion', () => {
    const input = { ...example(), pending: 'POST outcome unknown', completed: '' };
    expect(parseHandoff(JSON.stringify(input))).toEqual(input);
    expect(handoffTemplate().completed).toBe('');
  });
  it.each(['brief', 'acceptance', 'next_step'] as const)('requires %s', field => {
    expect(() => parseHandoff(JSON.stringify({ ...example(), [field]: ' \n ' }))).toThrow('required');
  });
  it.each([null, [], {}, { ...example(), format: 'future/2' }, { ...example(), extra: true }, { ...example(), evidence: 1 }])('rejects malformed or unsupported objects: %j', input => {
    expect(() => parseHandoff(JSON.stringify(input))).toThrow();
  });
  it('rejects unknown prototype keys without mutating prototypes', () => {
    const input = JSON.stringify(example()).replace('{', '{"__proto__":{"polluted":true},');
    expect(() => parseHandoff(input)).toThrow('Unknown');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('enforces both field length and UTF-8 byte limits', () => {
    expect(parseHandoff(JSON.stringify({ ...example(), evidence: 'x'.repeat(8000) })).evidence).toHaveLength(8000);
    expect(() => parseHandoff(JSON.stringify({ ...example(), evidence: 'x'.repeat(8001) }))).toThrow('8000');
    expect(() => parseHandoff(' '.repeat(HANDOFF_MAX_BYTES + 1))).toThrow('64 KiB');
    expect(() => parseHandoff(JSON.stringify({ ...example(), evidence: '界'.repeat(8000), completed: '界'.repeat(8000), blockers: '界'.repeat(8000) }))).toThrow('64 KiB');
  });
  it('rejects control characters but allows normal whitespace', () => {
    expect(() => parseHandoff(JSON.stringify({ ...example(), blockers: '\u0000' }))).toThrow('control');
    expect(parseHandoff(JSON.stringify({ ...example(), evidence: 'line\r\n\tindent' })).evidence).toBe('line\r\n\tindent');
  });
  it('renders untrusted Markdown as literal indented content', () => {
    const input = { ...example(), evidence: '# injected\n[bad](javascript:alert(1))\n```\n<script>bad()</script>' };
    const output = handoffMarkdown(input);
    for (const line of input.evidence.split('\n')) expect(output).toContain(`\n    ${line}\n`);
    expect(output.split('\n').filter(line => line.startsWith('## '))).toHaveLength(7);
    expect(() => handoffMarkdown(handoffTemplate())).toThrow('required');
  });
});
