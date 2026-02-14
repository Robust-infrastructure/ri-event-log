/**
 * ri-event-log — Event writer
 *
 * Appends events to the log with SHA-256 hash chain integrity.
 * Uses per-space write locks to serialize concurrent writes.
 */

import type { Event, EventType, Result } from '../types.js';
import type { EventLogError } from '../errors.js';
import { invalidEvent, databaseError } from '../errors.js';
import type { EventLogDatabase } from './database.js';
import { toEvent } from './database.js';
import { computeEventHash } from '../hash-chain/hash.js';
import { getLastEventHash, getNextSequenceNumber } from '../hash-chain/chain.js';

/** The fields the caller provides when writing an event. */
export interface WriteEventInput {
  readonly type: EventType;
  readonly spaceId: string;
  readonly timestamp: string;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Generate a UUID v4. Uses crypto.randomUUID when available, fallback otherwise. */
function generateUuidV4(): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- randomUUID may not exist in all environments
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const array = new Uint8Array(1);
    globalThis.crypto.getRandomValues(array);
    const r = (array[0] ?? 0) % 16;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'space_created',
  'space_evolved',
  'space_forked',
  'space_deleted',
  'state_changed',
  'action_invoked',
  'intent_submitted',
  'intent_queued',
  'intent_resolved',
  'user_feedback',
  'system_event',
]);

/** Validate event input fields. Returns an error or null if valid. */
function validateInput(input: WriteEventInput): EventLogError | null {
  if (input.spaceId.trim() === '') {
    return invalidEvent('spaceId', 'must not be empty');
  }

  if (!VALID_EVENT_TYPES.has(input.type)) {
    return invalidEvent('type', `invalid event type: ${input.type}`);
  }

  if (input.timestamp.trim() === '') {
    return invalidEvent('timestamp', 'must not be empty');
  }

  // Validate ISO 8601 timestamp
  if (Number.isNaN(Date.parse(input.timestamp))) {
    return invalidEvent('timestamp', 'must be a valid ISO 8601 timestamp');
  }

  if (typeof input.version !== 'number' || input.version < 1) {
    return invalidEvent('version', 'must be a positive integer');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Per-space write lock — serializes concurrent writes to the same space
// ---------------------------------------------------------------------------

/** Map of spaceId → promise chain. Ensures writes to the same space are serialized. */
const spaceLocks = new Map<string, Promise<void>>();

/**
 * Acquire a per-space lock and execute `fn` exclusively.
 * Writes to different spaces can proceed concurrently.
 */
async function withSpaceLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const currentLock = spaceLocks.get(spaceId) ?? Promise.resolve();

  let resolve: () => void;
  const nextLock = new Promise<void>((r) => {
    resolve = r;
  });
  spaceLocks.set(spaceId, nextLock);

  // Wait for previous write to this space to complete
  await currentLock;

  try {
    return await fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolve is assigned synchronously in the Promise constructor
    resolve!();
    // Clean up if this is the last lock in the chain
    if (spaceLocks.get(spaceId) === nextLock) {
      spaceLocks.delete(spaceId);
    }
  }
}

/**
 * Write a new event to the log.
 *
 * Concurrent writes to the same space are serialized via a per-space lock.
 * Writes to different spaces proceed concurrently with independent chains.
 */
export async function writeEvent(
  db: EventLogDatabase,
  input: WriteEventInput,
): Promise<Result<Event>> {
  // Validate input
  const validationError = validateInput(input);
  if (validationError !== null) {
    return { ok: false, error: validationError };
  }

  return withSpaceLock(input.spaceId, async () => {
    try {
      // Step 1: Read chain state
      const previousHash = await getLastEventHash(db, input.spaceId);
      const sequenceNumber = await getNextSequenceNumber(db, input.spaceId);

      // Step 2: Generate ID and compute hash
      const id = generateUuidV4();

      const eventWithoutHash: Omit<Event, 'hash'> = {
        id,
        type: input.type,
        spaceId: input.spaceId,
        timestamp: input.timestamp,
        sequenceNumber,
        previousHash,
        version: input.version,
        payload: input.payload,
      };

      const hash = await computeEventHash(eventWithoutHash);

      // Step 3: Write to IndexedDB
      const storedEvent = {
        id,
        type: input.type,
        spaceId: input.spaceId,
        timestamp: input.timestamp,
        sequenceNumber,
        hash,
        previousHash,
        version: input.version,
        payload: { ...input.payload },
      };

      await db.events.add(storedEvent);

      return { ok: true as const, value: toEvent(storedEvent) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: databaseError('writeEvent', message) };
    }
  });
}
