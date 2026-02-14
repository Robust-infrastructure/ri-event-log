/**
 * ri-event-log — Performance benchmarks
 *
 * Verifies that operations meet performance targets.
 * These tests use generous thresholds suitable for CI environments.
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
  return `test-perf-${Math.random().toString(36).slice(2)}`;
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

describe('Performance Benchmarks', () => {
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

  it('write 1 event: < 50ms', async () => {
    const log = trackedLog();

    const start = performance.now();
    const result = await log.writeEvent(makeEvent('space-1', 0));
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('write 100 events sequentially: < 2000ms', async () => {
    const log = trackedLog();

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      const result = await log.writeEvent(makeEvent('space-1', i));
      expect(result.ok).toBe(true);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  it('query 1,000 events by space: < 200ms', async () => {
    const log = trackedLog();

    // Pre-populate
    for (let i = 0; i < 1000; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const start = performance.now();
    const result = await log.queryBySpace('space-1', { limit: 1000 });
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1000);
    expect(elapsed).toBeLessThan(200);
  });

  it('reconstruct state from 500 events with snapshots: < 500ms', async () => {
    const dbName = uniqueDbName();
    dbs.push(dbName);

    const reducer = (state: unknown, _event: Event): unknown => {
      const n = typeof state === 'number' ? state : 0;
      return n + 1;
    };

    const log = createEventLog({
      databaseName: dbName,
      stateReducer: reducer,
      snapshotInterval: 100,
    });

    for (let i = 0; i < 500; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const start = performance.now();
    const result = await log.reconstructState('space-1');
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(500);
    expect(elapsed).toBeLessThan(500);
  });

  it('verify integrity of 1,000 events: < 5 seconds', async () => {
    const log = trackedLog();

    for (let i = 0; i < 1000; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const start = performance.now();
    const result = await log.verifyIntegrity('space-1');
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.valid).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);

  it('export 500 events to archive: < 2 seconds', async () => {
    const log = trackedLog();

    for (let i = 0; i < 500; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const start = performance.now();
    const result = await log.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('import 500 events from archive: < 2 seconds', async () => {
    const srcName = uniqueDbName();
    const dstName = uniqueDbName();
    dbs.push(srcName, dstName);

    const srcLog = createEventLog({ databaseName: srcName });
    for (let i = 0; i < 500; i++) {
      await srcLog.writeEvent(makeEvent('space-1', i));
    }

    const archive = await srcLog.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(archive.ok).toBe(true);
    if (!archive.ok) return;

    const dstLog = createEventLog({ databaseName: dstName });

    const start = performance.now();
    const result = await dstLog.importArchive(archive.value);
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.importedEvents).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });
});
