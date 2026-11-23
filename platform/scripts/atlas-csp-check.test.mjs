import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAtlasCsp } from './atlas-csp-check.mjs';

test('CSP in global block, directives and headers preserved', () => {
  assert.equal(hasAtlasCsp("/*\n  X-Frame-Options: SAMEORIGIN\n  Content-Security-Policy: default-src 'none'; script-src 'self' https://example.org; img-src 'self'\n"), true);
});
test('CSP required in correct block and as directive', () => {
  for (const text of ["/*\n  X-Test: no\n", "/other\n  Content-Security-Policy: script-src 'self'\n", "/*\n  Content-Security-Policy: default-src 'self'\n", "/*\n  X-Test: Content-Security-Policy: script-src 'self'\n", "/*\n  Content-Security-Policy: default-src script-src 'self'\n", "/*\n  Content-Security-Policy: script-src https://other.org\n"]) assert.equal(hasAtlasCsp(text),false,text);
});
test('large unmatched whitespace input completes without backtracking', () => {
  assert.equal(hasAtlasCsp('/*\n'+(' '.repeat(1800)+'\n').repeat(10000)+'  X-Only: absent\n'),false);
});
