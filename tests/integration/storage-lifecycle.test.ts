/**
 * ri-event-log — Storage lifecycle integration tests
 *
 * Tests the full storage lifecycle: write → report → compact → export → import.
 */

import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createEventLog } from '../../src/event-log.js';
import { createDatabase } from '../../src/storage/database.js';
import { compact } from '../../src/storage/compaction.js';
import { getStoragePressure } from '../../src/storage/pressure.js';
import type { Event, EventLog, StorageReport } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDbName(): string {
  return `test-storage-${Math.random().toString(36).slice(2)}`;
}

function makeEvent(
  spaceId: string,
  index: number,
): Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'> {
  return {
    type: 'state_changed',
    spaceId,
    timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, index)).toISOString(),
    version: 1,
    payload: { index },
  };
}

async function writeN(
  log: EventLog,
  spaceId: string,
  count: number,
  startIndex = 0,
): Promise<Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const result = await log.writeEvent(makeEvent(spaceId, startIndex + i));
    expect(result.ok).toBe(true);
    if (result.ok) events.push(result.value);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Storage Lifecycle', () => {
  const dbs: string[] = [];

  function trackedLog(config?: Parameters<typeof createEventLog>[0]): EventLog {
    const name = config?.databaseName ?? uniqueDbName();
    dbs.push(name);
    return createEventLog({ ...config, databaseName: name });
  }

  afterEach(async () => {
    for (const name of dbs) {
      const db = createDatabase(name);
      db.close();
      await db.delete();
    }
    dbs.length = 0;
  });

  it('write → storage report → compact → reconstruction still works', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    const reducer = (state: unknown, _event: Event): unknown => {
      const count = typeof state === 'number' ? state : 0;
      return count + 1;
    };

    const log = createEventLog({
      databaseName: dbName,
      stateReducer: reducer,
      snapshotInterval: 1000,
    });

    await writeN(log, 'space-1', 50);

    // Check storage report
    const storage = await log.getStorageUsage();
    expect(storage.ok).toBe(true);
    if (!storage.ok) return;
    expect(storage.value.totalEvents).toBe(50);
    expect(storage.value.spaces).toHaveLength(1);

    // Compact
    const db = createDatabase(dbName);
    const compactResult = await compact(db, 'space-1', reducer);
    db.close();

    expect(compactResult.ok).toBe(true);
    if (!compactResult.ok) return;
    expect(compactResult.value.eventsCompacted).toBe(50);

    // Reconstruction should still work (using snapshot)
    const state = await log.reconstructState('space-1');
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value).toBe(50);
  });

  it('export events older than X → remaining events unaffected', async () => {
    const log = trackedLog();

    // Write 20 events (10 "old" + 10 "new")
    await writeN(log, 'space-1', 20);

    const cutoff = new Date(Date.UTC(2026, 1, 14, 0, 0, 10)).toISOString();

    // Export events before cutoff
    const archive = await log.exportArchive('space-1', cutoff);
    expect(archive.ok).toBe(true);
    if (!archive.ok) return;

    // All events are still in the database (append-only — export doesn't delete)
    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.total).toBe(20);

    // Integrity still valid
    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (integrity.ok) expect(integrity.value.valid).toBe(true);
  });

  it('import previously exported events → no duplicates', async () => {
    const log = trackedLog();
    await writeN(log, 'space-1', 10);

    // Export
    const archive = await log.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(archive.ok).toBe(true);
    if (!archive.ok) return;

    // Import into same database — all should be duplicates
    const importResult = await log.importArchive(archive.value);
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;
    expect(importResult.value.importedEvents).toBe(0);
    expect(importResult.value.skippedDuplicates).toBe(10);

    // Still 10 events total
    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (query.ok) expect(query.value.total).toBe(10);
  });

  it('storage pressure levels computed correctly', () => {
    const makeReport = (estimatedBytes: number): StorageReport => ({
      totalEvents: 0,
      totalSnapshots: 0,
      estimatedBytes,
      spaces: [],
    });

    // NORMAL (< 50%)
    expect(getStoragePressure(makeReport(10_000), 100_000_000).level).toBe('NORMAL');

    // COMPACT (50–70%)
    expect(getStoragePressure(makeReport(55_000_000), 100_000_000).level).toBe('COMPACT');

    // EXPORT_PROMPT (70–80%)
    expect(getStoragePressure(makeReport(75_000_000), 100_000_000).level).toBe('EXPORT_PROMPT');

    // AGGRESSIVE (80–90%)
    expect(getStoragePressure(makeReport(85_000_000), 100_000_000).level).toBe('AGGRESSIVE');

    // BLOCKED (≥90%)
    expect(getStoragePressure(makeReport(96_000_000), 100_000_000).level).toBe('BLOCKED');
  });
});
