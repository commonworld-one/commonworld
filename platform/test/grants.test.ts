import { describe, expect, it } from 'vitest';
import { GRANTS_NOTE, grantsPath, parseTxHash, toGrantItem, txUrl } from '../src/grants-lib';

describe('grants helpers', () => {
  it('builds explorer links only for valid Base tx hashes', () => {
    const hash = '0x' + 'a'.repeat(64);
    expect(txUrl(hash)).toBe(`https://basescan.org/tx/${hash}`);
    expect(txUrl('0xshort')).toBeNull();
    expect(txUrl(null)).toBeNull();
  });

  it('maps DB rows to API items with illustrative flag', () => {
    const item = toGrantItem({
      number: 3,
      id: 'grant_x',
      from_party: 'Treasury',
      to_party: '@citizen',
      amount: '1 USDC',
      currency: 'USDC',
      purpose: 'Example',
      tx_hash: null,
      illustrative: 1,
      created_at: '2026-10-25T08:15:00.000Z',
    });
    expect(item).toMatchObject({ ref: 'grant-3', from: 'Treasury', illustrative: true, tx_url: null });
  });

  it('builds stable list paths', () => {
    expect(grantsPath('/v1/grants')).toBe('/v1/grants');
    expect(grantsPath('/grants', 12)).toBe('/grants?before=12');
  });

  it('validates tx hashes for future admin writes', () => {
    const ok = '0x' + 'b'.repeat(64);
    expect(parseTxHash(ok)).toBe(ok);
    expect(parseTxHash(null)).toBeNull();
    expect(() => parseTxHash('not-a-hash')).toThrow();
  });

  it('documents the public note constant', () => {
    expect(GRANTS_NOTE).toMatch(/illustrative/i);
    expect(GRANTS_NOTE).toMatch(/Authentication never widens/);
  });
});
