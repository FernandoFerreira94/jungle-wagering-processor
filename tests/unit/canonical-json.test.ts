import { describe, expect, test } from 'bun:test';
import { canonicalJson, sha256Hex } from '../../src/shared/canonical-json';

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });

  test('keeps array order', () => {
    expect(canonicalJson({ list: [3, 1, { z: 1, y: 2 }] })).toBe('{"list":[3,1,{"y":2,"z":1}]}');
  });

  test('produces the same hash regardless of key order', () => {
    const a = sha256Hex(canonicalJson({ kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }));
    const b = sha256Hex(canonicalJson({ money: { currency: 'BRL', amount: '1.00' }, kind: 'BET' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
