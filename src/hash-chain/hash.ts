/**
 * ri-event-log — SHA-256 hash computation
 *
 * Deterministic serialization and hashing via Web Crypto API.
 * Uses Node.js crypto module as Web Crypto fallback for non-browser environments.
 */

import type { Event } from '../types.js';

/**
 * Deterministic JSON serialization.
 * Sorts object keys alphabetically at all levels to ensure
 * the same data always produces the same string regardless of property order.
 */
export function deterministicSerialize(value: unknown): string {
  return JSON.stringify(value, (_key: string, val: unknown): unknown => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(val as Record<string, unknown>).sort();
      for (const k of keys) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * Get the crypto.subtle implementation.
 * Works in both browser (globalThis.crypto) and Node.js (node:crypto).
 */
async function getSubtleCrypto(): Promise<SubtleCrypto> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- crypto may be undefined in some environments
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  // Node.js fallback
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.webcrypto.subtle as SubtleCrypto;
}

/**
 * Compute SHA-256 hash of arbitrary data.
 * Returns lowercase hex string.
 */
export async function sha256(data: string): Promise<string> {
  const subtle = await getSubtleCrypto();
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the SHA-256 hash of an event.
 *
 * The hash is computed over a deterministic serialization of the event fields
 * (excluding the `hash` field itself). Fields are sorted alphabetically.
 */
export async function computeEventHash(
  event: Omit<Event, 'hash'>,
): Promise<string> {
  const hashInput = {
    id: event.id,
    type: event.type,
    spaceId: event.spaceId,
    timestamp: event.timestamp,
    sequenceNumber: event.sequenceNumber,
    previousHash: event.previousHash,
    version: event.version,
    payload: event.payload,
  };
  const serialized = deterministicSerialize(hashInput);
  return sha256(serialized);
}
