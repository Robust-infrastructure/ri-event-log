/**
 * ri-event-log — Storage Budget Monitor
 *
 * Tracks storage utilization across the event log database,
 * providing total counts, byte estimates, and per-space breakdowns.
 */

import type { StorageReport, SpaceStorageInfo, Result } from '../types.js';
import type { EventLogDatabase } from './database.js';

/**
 * Estimate the byte size of a stored event by serializing to JSON.
 *
 * Uses `JSON.stringify` length as a rough byte estimate. This is an
 * approximation — actual IndexedDB storage varies by engine.
 */
function estimateBytes(record: unknown): number {
  try {
    return JSON.stringify(record).length;
  } catch {
    return 0;
  }
}

/**
 * Get storage usage statistics for the entire event log.
 *
 * @param db - The event log database.
 * @returns A StorageReport with total counts, byte estimates, and per-space breakdown.
 */
export async function getStorageUsage(
  db: EventLogDatabase,
): Promise<Result<StorageReport>> {
  try {
    // Count totals
    const totalEvents = await db.events.count();
    const totalSnapshots = await db.snapshots.count();

    // Compute byte estimates and per-space breakdown
    const spaceMap = new Map<string, { eventCount: number; estimatedBytes: number }>();
    let totalEstimatedBytes = 0;
    let oldestTimestamp: string | undefined;
    let newestTimestamp: string | undefined;

    // Iterate all events to gather stats
    await db.events.each((event) => {
      const bytes = estimateBytes(event);
      totalEstimatedBytes += bytes;

      // Track oldest/newest
      if (oldestTimestamp === undefined || event.timestamp < oldestTimestamp) {
        oldestTimestamp = event.timestamp;
      }
      if (newestTimestamp === undefined || event.timestamp > newestTimestamp) {
        newestTimestamp = event.timestamp;
      }

      // Per-space accumulation
      const existing = spaceMap.get(event.spaceId);
      if (existing !== undefined) {
        existing.eventCount += 1;
        existing.estimatedBytes += bytes;
      } else {
        spaceMap.set(event.spaceId, { eventCount: 1, estimatedBytes: bytes });
      }
    });

    // Also count snapshot bytes
    await db.snapshots.each((snapshot) => {
      totalEstimatedBytes += estimateBytes(snapshot);
    });

    // Build per-space array
    const spaces: readonly SpaceStorageInfo[] = Array.from(spaceMap.entries())
      .map(([spaceId, info]) => Object.freeze({
        spaceId,
        eventCount: info.eventCount,
        estimatedBytes: info.estimatedBytes,
      }))
      .sort((a, b) => a.spaceId.localeCompare(b.spaceId));

    const report: StorageReport = Object.freeze({
      totalEvents,
      totalSnapshots,
      estimatedBytes: totalEstimatedBytes,
      oldestEvent: oldestTimestamp,
      newestEvent: newestTimestamp,
      spaces,
    });

    return { ok: true, value: report };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'getStorageUsage',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
