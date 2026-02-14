/**
 * ri-event-log — State Reconstructor
 *
 * Reconstructs the state of a space at any point in time by finding
 * the nearest snapshot and replaying subsequent events.
 */

import type { Result } from '../types.js';
import type { EventLogDatabase } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import type { StateReducer } from './snapshot-manager.js';

/**
 * Reconstruct the state of a space at a given point in time.
 *
 * Strategy:
 * 1. Find the nearest snapshot BEFORE `atTimestamp` (or the latest snapshot if no timestamp).
 * 2. Start from the snapshot state (or null if no snapshot exists).
 * 3. Replay events from after the snapshot up to `atTimestamp`.
 * 4. Return the reconstructed state.
 *
 * @param db - Database instance.
 * @param spaceId - The space to reconstruct.
 * @param stateReducer - Function that folds events into state.
 * @param atTimestamp - Optional ISO 8601 timestamp. If omitted, reconstructs latest state.
 * @returns The reconstructed state.
 */
export async function reconstructState(
  db: EventLogDatabase,
  spaceId: string,
  stateReducer: StateReducer,
  atTimestamp?: string,
): Promise<Result<unknown>> {
  try {
    // Validate timestamp if provided
    if (atTimestamp !== undefined) {
      const d = new Date(atTimestamp);
      if (isNaN(d.getTime())) {
        return {
          ok: false,
          error: {
            code: 'INVALID_QUERY' as const,
            field: 'atTimestamp',
            reason: 'Invalid ISO 8601 timestamp',
          },
        };
      }
    }

    // Check if the space has any events
    const totalEvents = await db.events.where('spaceId').equals(spaceId).count();
    if (totalEvents === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_QUERY' as const,
          field: 'spaceId',
          reason: 'No events found for space',
        },
      };
    }

    // If atTimestamp is provided, check it doesn't predate all events
    if (atTimestamp !== undefined) {
      const firstEvent = await db.events
        .where('[spaceId+sequenceNumber]')
        .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
        .first();

      if (firstEvent !== undefined && atTimestamp < firstEvent.timestamp) {
        return {
          ok: false,
          error: {
            code: 'INVALID_QUERY' as const,
            field: 'atTimestamp',
            reason: 'Timestamp predates all events for this space',
          },
        };
      }
    }

    // Find the nearest snapshot
    let state: unknown = null;
    let startAfterSeq = 0;

    if (atTimestamp !== undefined) {
      // Find latest snapshot with timestamp <= atTimestamp
      // We need to get snapshots for this space and find the best one
      const snapshots = await db.snapshots
        .where('[spaceId+eventSequenceNumber]')
        .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
        .toArray();

      // Find the latest snapshot that was created at or before atTimestamp
      // Since snapshots might have been created at different times,
      // we use the eventSequenceNumber to find the right one
      // We want the snapshot whose corresponding events are all <= atTimestamp
      let bestSnapshot: typeof snapshots[number] | undefined;
      for (const snap of snapshots) {
        // Check if the event at this sequence number has timestamp <= atTimestamp
        const eventAtSeq = await db.events
          .where('[spaceId+sequenceNumber]')
          .equals([spaceId, snap.eventSequenceNumber])
          .first();

        if (eventAtSeq !== undefined && eventAtSeq.timestamp <= atTimestamp) {
          if (bestSnapshot === undefined || snap.eventSequenceNumber > bestSnapshot.eventSequenceNumber) {
            bestSnapshot = snap;
          }
        }
      }

      if (bestSnapshot !== undefined) {
        state = bestSnapshot.state;
        startAfterSeq = bestSnapshot.eventSequenceNumber;
      }
    } else {
      // No timestamp — use the latest snapshot
      const latestSnapshot = await db.snapshots
        .where('[spaceId+eventSequenceNumber]')
        .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
        .last();

      if (latestSnapshot !== undefined) {
        state = latestSnapshot.state;
        startAfterSeq = latestSnapshot.eventSequenceNumber;
      }
    }

    // Query events after the snapshot point
    let events = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, startAfterSeq + 1], [spaceId, Infinity], true, true)
      .toArray();

    // If atTimestamp is provided, filter events up to that time
    if (atTimestamp !== undefined) {
      events = events.filter((e) => e.timestamp <= atTimestamp);
    }

    // Apply events through reducer
    for (const stored of events) {
      const event = toEvent(stored);
      state = stateReducer(state, event);
    }

    return { ok: true, value: state };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'reconstructState',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
