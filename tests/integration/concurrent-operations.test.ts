/**
 * ri-event-log — Concurrent operations integration tests
 *
 * Tests that concurrent writes and queries behave correctly.
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
  return `test-concurrent-${Math.random().toString(36).slice(2)}`;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Concurrent Operations', () => {
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

  it('10 concurrent writes to same space: all succeed, chain intact', async () => {
    const log = trackedLog();

    // Fire 10 writes concurrently
    const promises = Array.from({ length: 10 }, (_, i) =>
      log.writeEvent(makeEvent('space-1', i)),
    );
    const results = await Promise.all(promises);

    // All should succeed
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // Verify chain integrity
    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) return;
    expect(integrity.value.valid).toBe(true);
    expect(integrity.value.totalEvents).toBe(10);
  });

  it('5 concurrent writes to 5 different spaces: all succeed independently', async () => {
    const log = trackedLog();

    const promises = Array.from({ length: 5 }, (_, i) =>
      log.writeEvent(makeEvent(`space-${String(i)}`, i)),
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // Each space should have exactly 1 event
    for (let i = 0; i < 5; i++) {
      const q = await log.queryBySpace(`space-${String(i)}`);
      expect(q.ok).toBe(true);
      if (!q.ok) continue;
      expect(q.value.total).toBe(1);
    }
  });

  it('write + query simultaneously: query returns consistent snapshot', async () => {
    const log = trackedLog();

    // Pre-populate
    for (let i = 0; i < 10; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    // Fire write and query concurrently
    const [writeResult, queryResult] = await Promise.all([
      log.writeEvent(makeEvent('space-1', 10)),
      log.queryBySpace('space-1'),
    ]);

    expect(writeResult.ok).toBe(true);
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;

    // Query should return at least 10 events (may or may not include the concurrent write)
    expect(queryResult.value.total).toBeGreaterThanOrEqual(10);
    expect(queryResult.value.total).toBeLessThanOrEqual(11);
  });

  it('write + verify simultaneously: verification result is consistent', async () => {
    const log = trackedLog();

    // Pre-populate
    for (let i = 0; i < 10; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    // Fire write and verify concurrently
    const [writeResult, verifyResult] = await Promise.all([
      log.writeEvent(makeEvent('space-1', 10)),
      log.verifyIntegrity('space-1'),
    ]);

    expect(writeResult.ok).toBe(true);
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;

    // Chain should be valid regardless of timing
    expect(verifyResult.value.valid).toBe(true);
  });
});
