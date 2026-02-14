/**
 * ri-event-log — Snapshot Manager
 *
 * Creates snapshots of space state by replaying events through a state reducer.
 * Snapshots accelerate state reconstruction by providing checkpoints.
 */

import type { Event, Snapshot, Result } from '../types.js';
import type { EventLogDatabase, StoredSnapshot } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import { sha256, deterministicSerialize } from '../hash-chain/hash.js';
import { generateUuidV4 } from '../storage/event-writer.js';

/** State reducer signature — folds an event into accumulated state. */
export type StateReducer = (state: unknown, event: Event) => unknown;

/**
 * Create a snapshot of the current state for a space.
 *
 * Replays all events (from the last snapshot forward) through the state reducer
 * to build the current state, then stores it as a snapshot.
 *
 * @param db - Database instance.
 * @param spaceId - The space to snapshot.
 * @param stateReducer - Function that folds events into state.
 * @returns The created Snapshot.
 */
export async function createSnapshot(
  db: EventLogDatabase,
  spaceId: string,
  stateReducer: StateReducer,
  idGenerator: () => string = generateUuidV4,
): Promise<Result<Snapshot>> {
  try {
    // Find the latest existing snapshot for this space
    const latestSnapshot = await db.snapshots
      .where('[spaceId+eventSequenceNumber]')
      .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
      .last();

    let state: unknown = null;
    let startAfterSeq = 0;

    if (latestSnapshot !== undefined) {
      state = latestSnapshot.state;
      startAfterSeq = latestSnapshot.eventSequenceNumber;
    }

    // Get all events after the last snapshot
    const events = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, startAfterSeq + 1], [spaceId, Infinity], true, true)
      .toArray();

    if (events.length === 0 && latestSnapshot === undefined) {
      // No events at all for this space
      return {
        ok: false,
        error: {
          code: 'SNAPSHOT_FAILED' as const,
          spaceId,
          reason: 'No events found for space',
        },
      };
    }

    // Apply events through reducer
    for (const stored of events) {
      const event = toEvent(stored);
      state = stateReducer(state, event);
    }

    // Determine the sequence number of the last event included
    const lastEvent = events[events.length - 1];

    // If no new events exist, don't create a duplicate snapshot
    if (lastEvent === undefined) {
      return {
        ok: false,
        error: {
          code: 'SNAPSHOT_FAILED' as const,
          spaceId,
          reason: 'No new events since last snapshot',
        },
      };
    }

    const eventSequenceNumber = lastEvent.sequenceNumber;

    // Derive timestamp from last included event (determinism: no Date.now())
    const timestamp = lastEvent.timestamp;
    const snapshotId = idGenerator();
    const stateHash = await sha256(deterministicSerialize(state));

    const storedSnapshot: StoredSnapshot = {
      id: snapshotId,
      spaceId,
      eventSequenceNumber,
      timestamp,
      state,
      hash: stateHash,
    };

    await db.snapshots.add(storedSnapshot);

    const snapshot: Snapshot = Object.freeze({
      id: snapshotId,
      spaceId,
      eventSequenceNumber,
      timestamp,
      state,
      hash: stateHash,
    });

    return { ok: true, value: snapshot };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'createSnapshot',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Check whether an auto-snapshot should be triggered for a space.
 *
 * Returns true if the number of events since the last snapshot
 * equals or exceeds the configured interval.
 *
 * @param db - Database instance.
 * @param spaceId - The space to check.
 * @param snapshotInterval - Number of events between auto-snapshots.
 */
export async function shouldAutoSnapshot(
  db: EventLogDatabase,
  spaceId: string,
  snapshotInterval: number,
): Promise<boolean> {
  // Find the latest snapshot for this space
  const latestSnapshot = await db.snapshots
    .where('[spaceId+eventSequenceNumber]')
    .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
    .last();

  const lastSnapshotSeq = latestSnapshot?.eventSequenceNumber ?? 0;

  // Count events after the last snapshot
  const eventsSinceSnapshot = await db.events
    .where('[spaceId+sequenceNumber]')
    .between([spaceId, lastSnapshotSeq + 1], [spaceId, Infinity], true, true)
    .count();

  return eventsSinceSnapshot >= snapshotInterval;
}
