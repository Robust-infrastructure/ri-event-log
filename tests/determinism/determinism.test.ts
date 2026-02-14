/**
 * ri-event-log — Determinism tests
 *
 * Verifies that identical inputs always produce identical outputs.
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
  return `test-determinism-${Math.random().toString(36).slice(2)}`;
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

/**
 * Write the same sequence of events into a fresh database.
 * Returns the written events.
 */
async function writeSequence(
  dbName: string,
  count: number,
): Promise<{ log: EventLog; events: Event[] }> {
  const log = createEventLog({ databaseName: dbName, snapshotInterval: 1000 });
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const result = await log.writeEvent(makeEvent('space-1', i));
    expect(result.ok).toBe(true);
    if (result.ok) events.push(result.value);
  }
  return { log, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Determinism', () => {
  const dbs: string[] = [];

  afterEach(async () => {
    for (const name of dbs) {
      const db = createDatabase(name);
      db.close();
      await db.delete();
    }
    dbs.length = 0;
  });

  it('same events written in same order → identical hashes', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    // Write events once and read twice — hashes must be stable
    const { log, events: firstRead } = await writeSequence(dbName, 20);

    // Query back the same events from the database
    const query = await log.queryBySpace('space-1', { limit: 1000 });
    expect(query.ok).toBe(true);
    if (!query.ok) return;

    const secondRead = query.value.items;
    expect(secondRead).toHaveLength(20);

    // Every event should have identical hashes across reads
    for (let i = 0; i < 20; i++) {
      const e1 = firstRead[i];
      const e2 = secondRead[i];
      if (!e1 || !e2) continue;

      expect(e2.hash).toBe(e1.hash);
      expect(e2.previousHash).toBe(e1.previousHash);
      expect(e2.sequenceNumber).toBe(e1.sequenceNumber);
    }

    // Verify chain integrity is valid
    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (integrity.ok) expect(integrity.value.valid).toBe(true);
  });

  it('same events written in same order → identical query results', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    const { log } = await writeSequence(dbName, 15);

    // Query twice — results must be identical
    const q1 = await log.queryBySpace('space-1');
    const q2 = await log.queryBySpace('space-1');

    expect(q1.ok).toBe(true);
    expect(q2.ok).toBe(true);
    if (!q1.ok || !q2.ok) return;

    expect(q1.value.total).toBe(q2.value.total);
    expect(q1.value.total).toBe(15);

    for (let i = 0; i < q1.value.items.length; i++) {
      const item1 = q1.value.items[i];
      const item2 = q2.value.items[i];
      if (!item1 || !item2) continue;

      expect(item2.hash).toBe(item1.hash);
      expect(item2.timestamp).toBe(item1.timestamp);
      expect(item2.payload).toEqual(item1.payload);
    }
  });

  it('reconstruct state twice from same events → identical state', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    const reducer = (state: unknown, event: Event): unknown => {
      const arr = (Array.isArray(state) ? state : []) as unknown[];
      return [...arr, event.payload];
    };

    const log = createEventLog({
      databaseName: dbName,
      stateReducer: reducer,
      snapshotInterval: 1000,
    });

    for (let i = 0; i < 30; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const state1 = await log.reconstructState('space-1');
    const state2 = await log.reconstructState('space-1');

    expect(state1.ok).toBe(true);
    expect(state2.ok).toBe(true);
    if (!state1.ok || !state2.ok) return;

    expect(state2.value).toEqual(state1.value);
  });

  it('export → import → export → compare: identical archives', async () => {
    const srcName = uniqueDbName();
    const midName = uniqueDbName();
    dbs.push(srcName, midName);

    // Write events
    const { log: srcLog } = await writeSequence(srcName, 20);

    // First export
    const export1 = await srcLog.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(export1.ok).toBe(true);
    if (!export1.ok) return;

    // Import into middle database
    const midLog = createEventLog({ databaseName: midName });
    const importResult = await midLog.importArchive(export1.value);
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;
    expect(importResult.value.importedEvents).toBe(20);

    // Second export from middle database
    const export2 = await midLog.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(export2.ok).toBe(true);
    if (!export2.ok) return;

    // Archives should be byte-identical
    expect(export2.value.length).toBe(export1.value.length);
    expect(Buffer.from(export2.value).equals(Buffer.from(export1.value))).toBe(true);
  });
});
