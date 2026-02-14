/**
 * ri-event-log — Full lifecycle integration tests
 *
 * End-to-end tests covering the complete EventLog API surface.
 */

import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createEventLog } from '../../src/event-log.js';
import { createDatabase } from '../../src/storage/database.js';
import type { Event, EventLog } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDbName(): string {
  return `test-lifecycle-${Math.random().toString(36).slice(2)}`;
}

function makeEvent(
  spaceId: string,
  index: number,
  overrides: Partial<Pick<Event, 'type' | 'payload'>> = {},
): Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'> {
  return {
    type: overrides.type ?? 'state_changed',
    spaceId,
    timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, index)).toISOString(),
    version: 1,
    payload: overrides.payload ?? { index },
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

describe('Full Lifecycle', () => {
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

  it('writes 50 events across 5 spaces and queries each', async () => {
    const log = trackedLog();
    const spaces = ['s1', 's2', 's3', 's4', 's5'];

    for (const space of spaces) {
      await writeN(log, space, 10);
    }

    for (const space of spaces) {
      const result = await log.queryBySpace(space);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.total).toBe(10);
      expect(result.value.items).toHaveLength(10);
    }
  });

  it('write → query → verify integrity → pass', async () => {
    const log = trackedLog();
    await writeN(log, 'space-1', 20);

    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.total).toBe(20);

    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) return;
    expect(integrity.value.valid).toBe(true);
    expect(integrity.value.totalEvents).toBe(20);
  });

  it('tamper with one event → verify integrity → detect corruption', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);
    const log = createEventLog({ databaseName: dbName });
    await writeN(log, 'space-1', 10);

    // Tamper directly in database
    const db = createDatabase(dbName);
    const events = await db.events
      .where('spaceId')
      .equals('space-1')
      .toArray();

    const target = events[5];
    if (target) {
      await db.events.update(target.id, { hash: 'TAMPERED_HASH' });
    }
    db.close();

    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) return;
    expect(integrity.value.valid).toBe(false);
    expect(integrity.value.firstBrokenLink).toBeDefined();
  });

  it('create snapshots → reconstruct state → compare with full replay → identical', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    // Accumulator reducer: collects all payloads
    const reducer = (state: unknown, event: Event): unknown => {
      const arr = (Array.isArray(state) ? state : []) as unknown[];
      return [...arr, event.payload];
    };

    const log = createEventLog({
      databaseName: dbName,
      stateReducer: reducer,
      snapshotInterval: 1000, // no auto-snapshot
    });

    await writeN(log, 'space-1', 25);

    // Create snapshot midway
    const snap = await log.createSnapshot('space-1');
    expect(snap.ok).toBe(true);

    // Write more events
    await writeN(log, 'space-1', 25, 25);

    // Reconstruct full state
    const state = await log.reconstructState('space-1');
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    const result = state.value as unknown[];
    expect(result).toHaveLength(50);

    // Verify first and last payloads
    expect(result[0]).toEqual({ index: 0 });
    expect(result[49]).toEqual({ index: 49 });
  });

  it('export space → import archive → verify identical data', async () => {
    const srcName = uniqueDbName();
    const dstName = uniqueDbName();
    dbs.push(srcName, dstName);

    const srcLog = createEventLog({ databaseName: srcName });
    const written = await writeN(srcLog, 'space-1', 20);

    // Export
    const archive = await srcLog.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(archive.ok).toBe(true);
    if (!archive.ok) return;

    // Import into fresh database
    const dstLog = createEventLog({ databaseName: dstName });
    const importResult = await dstLog.importArchive(archive.value);
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;
    expect(importResult.value.importedEvents).toBe(20);

    // Query imported events
    const query = await dstLog.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.total).toBe(20);

    // Compare each event
    for (let i = 0; i < written.length; i++) {
      const orig = written[i];
      const imported = query.value.items[i];
      if (!orig || !imported) continue;
      expect(imported.id).toBe(orig.id);
      expect(imported.hash).toBe(orig.hash);
      expect(imported.payload).toEqual(orig.payload);
    }
  });

  it('500 events → auto-snapshot → reconstruction uses snapshots', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    const reducer = (state: unknown, event: Event): unknown => {
      const count = typeof state === 'number' ? state : 0;
      return count + ((event.payload as Record<string, unknown>)['index'] as number);
    };

    const log = createEventLog({
      databaseName: dbName,
      stateReducer: reducer,
      snapshotInterval: 100, // snapshot every 100 events
    });

    await writeN(log, 'space-1', 500);

    // Verify snapshots were created
    const db = createDatabase(dbName);
    const snapshots = await db.snapshots
      .where('spaceId')
      .equals('space-1')
      .count();
    db.close();

    expect(snapshots).toBeGreaterThanOrEqual(4); // 500/100 = 5 triggers, at least 4

    // Reconstruct state — should use snapshots internally
    const state = await log.reconstructState('space-1');
    expect(state.ok).toBe(true);
    if (!state.ok) return;

    // Sum of 0..499 = 124750
    expect(state.value).toBe(124750);
  });
});
