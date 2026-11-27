import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_FAIL, FILE_WARN, fileCountVerdict } from './asset-budget.mjs';

test('budgets are the agreed numbers', () => {
  assert.equal(FILE_WARN, 50_000);
  assert.equal(FILE_FAIL, 90_000);
});
test('today\'s build size is ok', () => assert.equal(fileCountVerdict(3_758), 'ok'));
test('just below the warning is ok, the warning starts at 50,000', () => {
  assert.equal(fileCountVerdict(49_999), 'ok');
  assert.equal(fileCountVerdict(50_000), 'warn');
});
test('exactly 90,000 only warns, 90,001 fails', () => {
  assert.equal(fileCountVerdict(90_000), 'warn');
  assert.equal(fileCountVerdict(90_001), 'fail');
});
test('the Paid limit itself (100,000) fails', () => assert.equal(fileCountVerdict(100_000), 'fail'));
