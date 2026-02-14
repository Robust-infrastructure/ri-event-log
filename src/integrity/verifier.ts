/**
 * ri-event-log — Integrity Verifier
 *
 * Walks the hash chain from genesis to latest event, recomputes hashes,
 * and verifies previousHash links. Supports per-space or full-database
 * verification with chunked processing.
 */

import type { IntegrityReport, Result } from '../types.js';
import type { EventLogDatabase, StoredEvent } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import { computeEventHash } from '../hash-chain/hash.js';

/** Number of events to process per verification chunk. */
const CHUNK_SIZE = 500;

/**
 * Verify hash chain integrity for a specific space or the entire database.
 *
 * For each event:
 * 1. Recomputes the SHA-256 hash from event fields and verifies it matches the stored hash.
 * 2. Verifies that `previousHash` matches the prior event's hash in the same space.
 *
 * @param db - The database instance.
 * @param spaceId - If provided, only verify events in this space. Otherwise all spaces.
 * @returns An IntegrityReport describing the verification result.
 */
export async function verifyIntegrity(
  db: EventLogDatabase,
  spaceId?: string,
): Promise<Result<IntegrityReport>> {
  const startTime = performance.now();

  try {
    if (spaceId !== undefined) {
      return await verifySpace(db, spaceId, startTime);
    }
    return await verifyAllSpaces(db, startTime);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'verifyIntegrity',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Verify integrity of a single space's hash chain.
 */
async function verifySpace(
  db: EventLogDatabase,
  spaceId: string,
  startTime: number,
): Promise<Result<IntegrityReport>> {
  const totalEvents = await db.events.where('spaceId').equals(spaceId).count();

  if (totalEvents === 0) {
    return {
      ok: true,
      value: {
        valid: true,
        totalEvents: 0,
        checkedEvents: 0,
        duration: performance.now() - startTime,
      },
    };
  }

  let checkedEvents = 0;
  let previousHash: string | null = null;
  let offset = 0;

  while (offset < totalEvents) {
    // Fetch a chunk ordered by sequenceNumber within this space
    const chunk = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
      .offset(offset)
      .limit(CHUNK_SIZE)
      .toArray();

    const result = await verifyChunk(chunk, previousHash, checkedEvents === 0);
    if (result.brokenLink !== undefined) {
      return {
        ok: true,
        value: {
          valid: false,
          totalEvents,
          checkedEvents: checkedEvents + result.checkedInChunk,
          firstBrokenLink: result.brokenLink,
          duration: performance.now() - startTime,
        },
      };
    }

    checkedEvents += result.checkedInChunk;
    previousHash = result.lastHash;
    offset += CHUNK_SIZE;
  }

  return {
    ok: true,
    value: {
      valid: true,
      totalEvents,
      checkedEvents,
      duration: performance.now() - startTime,
    },
  };
}

/**
 * Verify integrity across all spaces in the database.
 * Processes each space independently.
 */
async function verifyAllSpaces(
  db: EventLogDatabase,
  startTime: number,
): Promise<Result<IntegrityReport>> {
  // Get all distinct spaceIds
  const allEvents = await db.events.orderBy('spaceId').keys();
  const spaceIds = [...new Set(allEvents as string[])];

  let totalEvents = 0;
  let checkedEvents = 0;

  for (const sid of spaceIds) {
    const spaceResult = await verifySpace(db, sid, startTime);
    if (!spaceResult.ok) return spaceResult;

    totalEvents += spaceResult.value.totalEvents;
    checkedEvents += spaceResult.value.checkedEvents;

    if (!spaceResult.value.valid) {
      return {
        ok: true,
        value: {
          valid: false,
          totalEvents,
          checkedEvents,
          firstBrokenLink: spaceResult.value.firstBrokenLink,
          duration: performance.now() - startTime,
        },
      };
    }
  }

  return {
    ok: true,
    value: {
      valid: true,
      totalEvents,
      checkedEvents,
      duration: performance.now() - startTime,
    },
  };
}

/** Result of verifying a single chunk of events. */
interface ChunkVerificationResult {
  /** Number of events checked in this chunk. */
  readonly checkedInChunk: number;
  /** The hash of the last event in the chunk, for linking to the next chunk. */
  readonly lastHash: string | null;
  /** Details of the first broken link, if any. */
  readonly brokenLink?: {
    readonly eventId: string;
    readonly expected: string;
    readonly actual: string;
  };
}

/**
 * Verify a chunk of events for hash integrity and chain linking.
 *
 * @param chunk - Array of stored events, ordered by sequenceNumber.
 * @param expectedPreviousHash - The expected previousHash for the first event in the chunk.
 * @param isGenesis - Whether the first event in the chunk is the genesis event.
 */
async function verifyChunk(
  chunk: readonly StoredEvent[],
  expectedPreviousHash: string | null,
  isGenesis: boolean,
): Promise<ChunkVerificationResult> {
  let prevHash = expectedPreviousHash;
  let lastHash: string | null = null;
  let checkedInChunk = 0;

  for (let i = 0; i < chunk.length; i++) {
    const stored = chunk[i];
    if (stored === undefined) continue;

    const event = toEvent(stored);
    checkedInChunk++;

    // 1. Verify previousHash link
    if (isGenesis && i === 0) {
      // Genesis event must have null previousHash
      if (event.previousHash !== null) {
        return {
          checkedInChunk,
          lastHash: event.hash,
          brokenLink: {
            eventId: event.id,
            expected: 'null (genesis)',
            actual: event.previousHash,
          },
        };
      }
    } else {
      // Non-genesis: previousHash must match the prior event's hash
      const expectedPrev = prevHash ?? 'null';
      if (event.previousHash !== prevHash) {
        return {
          checkedInChunk,
          lastHash: event.hash,
          brokenLink: {
            eventId: event.id,
            expected: expectedPrev,
            actual: event.previousHash ?? 'null',
          },
        };
      }
    }

    // 2. Recompute hash and verify it matches the stored hash
    const recomputedHash = await computeEventHash(event);
    if (recomputedHash !== event.hash) {
      return {
        checkedInChunk,
        lastHash: event.hash,
        brokenLink: {
          eventId: event.id,
          expected: recomputedHash,
          actual: event.hash,
        },
      };
    }

    prevHash = event.hash;
    lastHash = event.hash;
  }

  return { checkedInChunk, lastHash };
}
