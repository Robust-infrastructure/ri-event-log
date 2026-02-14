/**
 * ri-event-log — Hash computation tests
 */

import { describe, it, expect } from 'vitest';
import { deterministicSerialize, sha256, computeEventHash } from './hash.js';

describe('deterministicSerialize', () => {
  it('produces the same output regardless of key order', () => {
    const a = deterministicSerialize({ z: 1, a: 2, m: 3 });
    const b = deterministicSerialize({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  it('handles nested objects with key-order independence', () => {
    const a = deterministicSerialize({ outer: { z: 1, a: 2 }, key: 'val' });
    const b = deterministicSerialize({ key: 'val', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    const a = deterministicSerialize({ items: [1, 2, 3] });
    const b = deterministicSerialize({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it('handles null values', () => {
    const result = deterministicSerialize({ a: null, b: 'test' });
    expect(result).toBe('{"a":null,"b":"test"}');
  });

  it('handles empty objects', () => {
    expect(deterministicSerialize({})).toBe('{}');
  });

  it('handles primitive values', () => {
    expect(deterministicSerialize('hello')).toBe('"hello"');
    expect(deterministicSerialize(42)).toBe('42');
    expect(deterministicSerialize(true)).toBe('true');
    expect(deterministicSerialize(null)).toBe('null');
  });
});

describe('sha256', () => {
  it('produces deterministic output for the same input', async () => {
    const hash1 = await sha256('hello world');
    const hash2 = await sha256('hello world');
    expect(hash1).toBe(hash2);
  });

  it('produces different output for different input', async () => {
    const hash1 = await sha256('hello');
    const hash2 = await sha256('world');
    expect(hash1).not.toBe(hash2);
  });

  it('produces lowercase hex string of 64 characters', async () => {
    const hash = await sha256('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches known SHA-256 value for empty string', async () => {
    const hash = await sha256('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes empty payload correctly', async () => {
    const hash = await sha256('{}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes large payload within reasonable time', async () => {
    const largePayload = 'x'.repeat(100_000);
    const start = performance.now();
    const hash = await sha256(largePayload);
    const duration = performance.now() - start;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(duration).toBeLessThan(100); // 100ms budget for 100KB
  });
});

describe('computeEventHash', () => {
  const baseEvent = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'space_created' as const,
    spaceId: 'space-1',
    timestamp: '2026-02-14T00:00:00.000Z',
    sequenceNumber: 1,
    previousHash: null,
    version: 1,
    payload: { name: 'Test Space' },
  };

  it('produces deterministic hash for the same event', async () => {
    const hash1 = await computeEventHash(baseEvent);
    const hash2 = await computeEventHash(baseEvent);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different payload', async () => {
    const hash1 = await computeEventHash(baseEvent);
    const hash2 = await computeEventHash({
      ...baseEvent,
      payload: { name: 'Different Space' },
    });
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different sequenceNumber', async () => {
    const hash1 = await computeEventHash(baseEvent);
    const hash2 = await computeEventHash({
      ...baseEvent,
      sequenceNumber: 2,
    });
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hash for different previousHash', async () => {
    const hash1 = await computeEventHash(baseEvent);
    const hash2 = await computeEventHash({
      ...baseEvent,
      previousHash: 'some-hash',
    });
    expect(hash1).not.toBe(hash2);
  });

  it('is key-order independent for payload', async () => {
    const hash1 = await computeEventHash({
      ...baseEvent,
      payload: { a: 1, b: 2, c: 3 },
    });
    const hash2 = await computeEventHash({
      ...baseEvent,
      payload: { c: 3, a: 1, b: 2 },
    });
    expect(hash1).toBe(hash2);
  });

  it('returns 64-character hex string', async () => {
    const hash = await computeEventHash(baseEvent);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
