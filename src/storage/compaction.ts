/**
 * ri-event-log — Compaction
 *
 * Creates a snapshot at the current position for a space so that future
 * state reconstruction can skip replaying old events from genesis.
 *
 * Compaction does NOT delete events — the append-only guarantee is preserved.
 * It creates a snapshot checkpoint that accelerates reconstruction.
 */

import type { CompactionReport, Result } from '../types.js';
import type { EventLogDatabase } from './database.js';
import { createSnapshot } from '../snapshots/snapshot-manager.js';
import type { StateReducer } from '../snapshots/snapshot-manager.js';

/**
 * Compact a space by creating a snapshot at the latest event.
 *
 * After compaction, state reconstruction will use the snapshot as a
 * starting point instead of replaying from genesis. No events are
 * deleted — the append-only guarantee is maintained.
 *
 * @param db - The event log database.
 * @param spaceId - The space to compact.
 * @param stateReducer - The state reducer for building snapshot state.
 * @returns A CompactionReport with details about the compaction.
 */
export async function compact(
  db: EventLogDatabase,
  spaceId: string,
  stateReducer: StateReducer,
): Promise<Result<CompactionReport>> {
  try {
    // Check how many events exist for this space
    const totalEvents = await db.events
      .where('spaceId')
      .equals(spaceId)
      .count();

    if (totalEvents === 0) {
      return {
        ok: false,
        error: {
          code: 'SNAPSHOT_FAILED' as const,
          spaceId,
          reason: 'No events found for space — nothing to compact',
        },
      };
    }

    // Find the latest snapshot to know what's already compacted
    const latestSnapshot = await db.snapshots
      .where('[spaceId+eventSequenceNumber]')
      .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
      .last();

    const lastSnapshotSeq = latestSnapshot?.eventSequenceNumber ?? 0;

    // Count events since last snapshot
    const eventsSinceSnapshot = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, lastSnapshotSeq + 1], [spaceId, Infinity], true, true)
      .count();

    if (eventsSinceSnapshot === 0) {
      return {
        ok: false,
        error: {
          code: 'SNAPSHOT_FAILED' as const,
          spaceId,
          reason: 'No new events since last snapshot — already compacted',
        },
      };
    }

    // Estimate bytes for events that will be covered by the new snapshot
    let estimatedBytesSaved = 0;
    const eventsToCompact = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, lastSnapshotSeq + 1], [spaceId, Infinity], true, true)
      .toArray();

    for (const event of eventsToCompact) {
      try {
        estimatedBytesSaved += JSON.stringify(event).length;
      } catch {
        // Skip events that can't be serialized
      }
    }

    // Create the snapshot
    const snapshotResult = await createSnapshot(db, spaceId, stateReducer);
    if (!snapshotResult.ok) {
      return snapshotResult;
    }

    const report: CompactionReport = Object.freeze({
      spaceId,
      eventsCompacted: eventsSinceSnapshot,
      estimatedBytesSaved,
      snapshotId: snapshotResult.value.id,
    });

    return { ok: true, value: report };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'compact',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
