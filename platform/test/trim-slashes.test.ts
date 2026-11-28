import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../src/trim-slashes';

const regexTrim = (s: string) => s.replace(/\/+$/, '');

describe('trimTrailingSlashes', () => {
  const cases = ['', '/', '////', 'a', 'a/', 'a///', '/a/b/', '/a//b//', 'https://x.test/', 'https://x.test///', 'a/\n', 'a\n/', 'é/ü//', '日本/語///', '😀//', '\ud800//', ' /'];
  for (const c of cases) {
    it(`matches the old regex for ${JSON.stringify(c)}`, () => {
      expect(trimTrailingSlashes(c)).toBe(regexTrim(c));
    });
  }

  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('/a//b///')).toBe('/a//b');
    expect(trimTrailingSlashes('////')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('abc')).toBe('abc');
  });

  it('leaves a trailing newline alone, like the regex', () => {
    expect(trimTrailingSlashes('a/\n')).toBe('a/\n');
  });

  it('handles a long run of slashes in the middle in linear work', () => {
    const s = '/a' + '/'.repeat(200_000) + 'x/';
    expect(trimTrailingSlashes(s)).toBe('/a' + '/'.repeat(200_000) + 'x');
  });
});
