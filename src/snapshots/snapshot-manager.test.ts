/**
 * ri-event-log — Snapshot manager tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createSnapshot, shouldAutoSnapshot } from './snapshot-manager.js';
import { EventLogDatabase } from '../storage/database.js';
import { writeEvent } from '../storage/event-writer.js';
import type { WriteEventInput } from '../storage/event-writer.js';
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

/** Accumulator reducer: collects all payloads into an array. */
function accumulatorReducer(state: unknown, event: Event): unknown {
  const arr: unknown[] = Array.isArray(state) ? (state as unknown[]) : [];
  return [...arr, event.payload];
}

/** Counter reducer: counts events. */
function counterReducer(state: unknown, _event: Event): unknown {
  const count = typeof state === 'number' ? state : 0;
  return count + 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSnapshot', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-snap-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('creates a snapshot with correct sequence number', async () => {
    const events = await writeMany(db, 5);
    const lastEvent = events[events.length - 1];
    if (lastEvent === undefined) throw new Error('No events written');

    const result = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.spaceId).toBe('space-1');
    expect(result.value.eventSequenceNumber).toBe(lastEvent.sequenceNumber);
  });

  it('snapshot state matches full replay through reducer', async () => {
    await writeMany(db, 3);

    const result = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = result.value.state as readonly unknown[];
    expect(state).toHaveLength(3);
    expect(state[0]).toEqual({ index: 0 });
    expect(state[1]).toEqual({ index: 1 });
    expect(state[2]).toEqual({ index: 2 });
  });

  it('snapshot hash is a valid SHA-256 hex string', async () => {
    await writeMany(db, 2);

    const result = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('snapshot hash is deterministic for the same state', async () => {
    // Two different databases with same events should produce same state hash
    const db2 = new EventLogDatabase(`test-snap-det-${Math.random().toString(36).slice(2)}`);
    try {
      await writeMany(db, 3);
      await writeMany(db2, 3);

      const r1 = await createSnapshot(db, 'space-1', accumulatorReducer);
      const r2 = await createSnapshot(db2, 'space-1', accumulatorReducer);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      expect(r1.value.hash).toBe(r2.value.hash);
    } finally {
      db2.close();
      await db2.delete();
    }
  });

  it('uses custom reducer correctly (counter)', async () => {
    await writeMany(db, 7);

    const result = await createSnapshot(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.state).toBe(7);
  });

  it('returns error for empty space', async () => {
    const result = await createSnapshot(db, 'nonexistent', accumulatorReducer);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('SNAPSHOT_FAILED');
  });

  it('creates incremental snapshot from previous snapshot', async () => {
    await writeMany(db, 3);
    const snap1 = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(snap1.ok).toBe(true);
    if (!snap1.ok) return;

    // Write more events
    await writeMany(db, 2, {
      timestamp: '2026-02-14T01:00:00.000Z',
      payload: { extra: true },
    });

    const snap2 = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(snap2.ok).toBe(true);
    if (!snap2.ok) return;

    // Should have all 5 events' payloads accumulated
    const state = snap2.value.state as readonly unknown[];
    expect(state).toHaveLength(5);
    expect(snap2.value.eventSequenceNumber).toBe(5);
    expect(snap2.value.eventSequenceNumber).toBeGreaterThan(snap1.value.eventSequenceNumber);
  });

  it('returns error when no new events since last snapshot', async () => {
    await writeMany(db, 3);
    const snap1 = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(snap1.ok).toBe(true);

    // Try to snapshot again without new events
    const snap2 = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(snap2.ok).toBe(false);
    if (snap2.ok) return;

    expect(snap2.error.code).toBe('SNAPSHOT_FAILED');
  });

  it('creates snapshots for different spaces independently', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });

    const snapA = await createSnapshot(db, 'alpha', counterReducer);
    const snapB = await createSnapshot(db, 'beta', counterReducer);

    expect(snapA.ok).toBe(true);
    expect(snapB.ok).toBe(true);
    if (!snapA.ok || !snapB.ok) return;

    expect(snapA.value.state).toBe(3);
    expect(snapB.value.state).toBe(5);
    expect(snapA.value.spaceId).toBe('alpha');
    expect(snapB.value.spaceId).toBe('beta');
  });

  it('snapshot id and timestamp are populated', async () => {
    await writeMany(db, 1);
    const result = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBeTruthy();
    expect(typeof result.value.id).toBe('string');
    expect(result.value.timestamp).toBeTruthy();
    // Timestamp should be a valid ISO string
    expect(new Date(result.value.timestamp).toISOString()).toBe(result.value.timestamp);
  });

  it('snapshot is frozen (immutable)', async () => {
    await writeMany(db, 1);
    const result = await createSnapshot(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.isFrozen(result.value)).toBe(true);
  });
});

describe('shouldAutoSnapshot', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-autosnap-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns false when events count is below interval', async () => {
    await writeMany(db, 5);
    const should = await shouldAutoSnapshot(db, 'space-1', 10);
    expect(should).toBe(false);
  });

  it('returns true when events count reaches interval', async () => {
    await writeMany(db, 10);
    const should = await shouldAutoSnapshot(db, 'space-1', 10);
    expect(should).toBe(true);
  });

  it('returns true when events count exceeds interval', async () => {
    await writeMany(db, 15);
    const should = await shouldAutoSnapshot(db, 'space-1', 10);
    expect(should).toBe(true);
  });

  it('resets count after a snapshot is created', async () => {
    await writeMany(db, 10);
    // Create snapshot to reset the counter
    await createSnapshot(db, 'space-1', accumulatorReducer);

    const should = await shouldAutoSnapshot(db, 'space-1', 10);
    expect(should).toBe(false);

    // Write more events to hit interval again
    for (let i = 0; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 1, 15, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { batch2: i } }));
    }

    const shouldNow = await shouldAutoSnapshot(db, 'space-1', 10);
    expect(shouldNow).toBe(true);
  });

  it('returns false for empty space', async () => {
    const should = await shouldAutoSnapshot(db, 'nonexistent', 10);
    expect(should).toBe(false);
  });

  it('checks per-space independently', async () => {
    await writeMany(db, 10, { spaceId: 'alpha' });
    await writeMany(db, 3, { spaceId: 'beta' });

    expect(await shouldAutoSnapshot(db, 'alpha', 10)).toBe(true);
    expect(await shouldAutoSnapshot(db, 'beta', 10)).toBe(false);
  });
});
