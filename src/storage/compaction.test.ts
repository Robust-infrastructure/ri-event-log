/**
 * ri-event-log — Compaction tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { compact } from './compaction.js';
import { EventLogDatabase } from './database.js';
import { writeEvent } from './event-writer.js';
import type { WriteEventInput } from './event-writer.js';
import { reconstructState } from '../snapshots/state-reconstructor.js';
import type { Event } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<WriteEventInput> = {}): WriteEventInput {
  return {
    type: 'state_changed',
    spaceId: 'space-1',
    timestamp: '2026-02-14T00:00:00.000Z',
    version: 1,
    payload: { key: 'value' },
    ...overrides,
  };
}

async function writeMany(
  db: EventLogDatabase,
  count: number,
  overrides: Partial<WriteEventInput> = {},
): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
    const result = await writeEvent(db, makeInput({
      timestamp: ts,
      payload: { index: i },
      ...overrides,
    }));
    if (!result.ok) throw new Error(`writeEvent failed: ${result.error.code}`);
    events.push(result.value);
  }
  return events;
}

/** Counter reducer: counts events. */
function counterReducer(state: unknown, _event: Event): unknown {
  const count = typeof state === 'number' ? state : 0;
  return count + 1;
}

/** Accumulator reducer: collects all payloads. */
function accumulatorReducer(state: unknown, event: Event): unknown {
  const arr: unknown[] = Array.isArray(state) ? (state as unknown[]) : [];
  return [...arr, event.payload];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compact', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-compact-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('creates a snapshot during compaction', async () => {
    await writeMany(db, 10);

    const snapshotsBefore = await db.snapshots.count();
    expect(snapshotsBefore).toBe(0);

    const result = await compact(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);

    const snapshotsAfter = await db.snapshots.count();
    expect(snapshotsAfter).toBe(1);
  });

  it('returns compaction report with correct event count', async () => {
    await writeMany(db, 10);

    const result = await compact(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.spaceId).toBe('space-1');
    expect(result.value.eventsCompacted).toBe(10);
    expect(result.value.snapshotId).toBeTruthy();
  });

  it('reports positive estimated bytes saved', async () => {
    await writeMany(db, 10);

    const result = await compact(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.estimatedBytesSaved).toBeGreaterThan(0);
  });

  it('returns error for space with no events', async () => {
    const result = await compact(db, 'nonexistent', counterReducer);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('SNAPSHOT_FAILED');
  });

  it('preserves all events after compaction (append-only)', async () => {
    const events = await writeMany(db, 10);

    await compact(db, 'space-1', counterReducer);

    // All events should still be in the database
    const eventCount = await db.events.where('spaceId').equals('space-1').count();
    expect(eventCount).toBe(10);

    // Verify we can still read them
    const stored = await db.events
      .where('[spaceId+sequenceNumber]')
      .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
      .toArray();
    expect(stored).toHaveLength(10);
    expect(stored[0]?.id).toBe(events[0]?.id);
  });

  it('reconstruction works correctly after compaction', async () => {
    await writeMany(db, 10);

    // Reconstruct before compaction
    const before = await reconstructState(db, 'space-1', counterReducer);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // Compact
    await compact(db, 'space-1', counterReducer);

    // Reconstruct after compaction — should get same result
    const after = await reconstructState(db, 'space-1', counterReducer);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(after.value).toBe(before.value);
  });

  it('reconstruction after compaction + new events works correctly', async () => {
    await writeMany(db, 5);
    await compact(db, 'space-1', counterReducer);

    // Write more events
    for (let i = 5; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 1, 15, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { index: i } }));
    }

    const result = await reconstructState(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 5 from compacted snapshot + 5 replayed = 10
    expect(result.value).toBe(10);
  });

  it('returns error when already fully compacted', async () => {
    await writeMany(db, 5);
    await compact(db, 'space-1', counterReducer);

    // Try to compact again — no new events
    const result = await compact(db, 'space-1', counterReducer);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('SNAPSHOT_FAILED');
  });

  it('incremental compaction after new events', async () => {
    await writeMany(db, 5);
    const first = await compact(db, 'space-1', counterReducer);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.eventsCompacted).toBe(5);

    // Write more events
    for (let i = 5; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 1, 15, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { index: i } }));
    }

    const second = await compact(db, 'space-1', counterReducer);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Only the 5 new events should be compacted
    expect(second.value.eventsCompacted).toBe(5);
    expect(second.value.snapshotId).not.toBe(first.value.snapshotId);
  });

  it('compacts different spaces independently', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });

    const resultA = await compact(db, 'alpha', counterReducer);
    const resultB = await compact(db, 'beta', accumulatorReducer);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.value.eventsCompacted).toBe(3);
    expect(resultB.value.eventsCompacted).toBe(5);

    // Verify both spaces reconstruct correctly
    const stateA = await reconstructState(db, 'alpha', counterReducer);
    const stateB = await reconstructState(db, 'beta', accumulatorReducer);
    expect(stateA.ok).toBe(true);
    expect(stateB.ok).toBe(true);
    if (!stateA.ok || !stateB.ok) return;

    expect(stateA.value).toBe(3);
    expect(stateB.value).toHaveLength(5);
  });
});
