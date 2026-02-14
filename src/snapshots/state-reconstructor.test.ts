/**
 * ri-event-log — State reconstructor tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { reconstructState } from './state-reconstructor.js';
import { createSnapshot } from './snapshot-manager.js';
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

/** Sum reducer: sums payload.value fields. */
function sumReducer(state: unknown, event: Event): unknown {
  const sum = typeof state === 'number' ? state : 0;
  const val = typeof event.payload['value'] === 'number' ? event.payload['value'] : 0;
  return sum + val;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconstructState', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-recon-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  // --- Reconstruction from genesis (no snapshots) ---

  it('reconstructs from genesis when no snapshots exist', async () => {
    await writeMany(db, 5);

    const result = await reconstructState(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(5);
  });

  it('reconstructs accumulator state from genesis', async () => {
    await writeMany(db, 3);

    const result = await reconstructState(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = result.value as readonly unknown[];
    expect(state).toHaveLength(3);
    expect(state[0]).toEqual({ index: 0 });
    expect(state[2]).toEqual({ index: 2 });
  });

  // --- Reconstruction from snapshot ---

  it('reconstructs from snapshot checkpoint', async () => {
    await writeMany(db, 5);
    // Create snapshot after 5 events
    await createSnapshot(db, 'space-1', counterReducer);

    // Write 3 more events
    for (let i = 0; i < 3; i++) {
      const ts = new Date(Date.UTC(2026, 1, 15, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { batch2: i } }));
    }

    const result = await reconstructState(db, 'space-1', counterReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 5 from snapshot + 3 replayed = 8
    expect(result.value).toBe(8);
  });

  it('uses latest snapshot as starting point', async () => {
    await writeMany(db, 3);
    await createSnapshot(db, 'space-1', accumulatorReducer);

    await writeMany(db, 2, {
      timestamp: '2026-02-14T01:00:00.000Z',
      payload: { extra: true },
    });
    await createSnapshot(db, 'space-1', accumulatorReducer);

    // Write 1 more
    await writeEvent(db, makeInput({
      timestamp: '2026-02-14T02:00:00.000Z',
      payload: { final: true },
    }));

    const result = await reconstructState(db, 'space-1', accumulatorReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = result.value as readonly unknown[];
    // All 6 events should be in the accumulated state
    expect(state).toHaveLength(6);
  });

  // --- Reconstruction at specific timestamp ---

  it('reconstructs state at specific timestamp', async () => {
    // Events at t=0, t=1, t=2, t=3, t=4 seconds
    await writeMany(db, 5);

    // Reconstruct at t=2 (should include events at 0, 1, 2)
    const atTime = new Date(Date.UTC(2026, 1, 14, 0, 0, 2)).toISOString();
    const result = await reconstructState(db, 'space-1', counterReducer, atTime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(3);
  });

  it('reconstructs at timestamp with snapshot before target time', async () => {
    // Write 5 events (t=0..4)
    await writeMany(db, 5);
    // Snapshot after 5 events
    await createSnapshot(db, 'space-1', counterReducer);

    // Write 5 more (t=5..9) at later timestamps
    for (let i = 5; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { index: i } }));
    }

    // Reconstruct at t=7 (snapshot covers 0-4, replay 5,6,7 = 8 total)
    const atTime = new Date(Date.UTC(2026, 1, 14, 0, 0, 7)).toISOString();
    const result = await reconstructState(db, 'space-1', counterReducer, atTime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(8);
  });

  // --- With custom reducer ---

  it('works with a sum reducer', async () => {
    for (let i = 1; i <= 4; i++) {
      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({
        timestamp: ts,
        payload: { value: i * 10 },
      }));
    }

    const result = await reconstructState(db, 'space-1', sumReducer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 10 + 20 + 30 + 40 = 100
    expect(result.value).toBe(100);
  });

  // --- Error cases ---

  it('returns error for space with no events', async () => {
    const result = await reconstructState(db, 'nonexistent', counterReducer);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_QUERY');
  });

  it('returns error when timestamp predates all events', async () => {
    await writeMany(db, 3);

    const earlyTime = '2020-01-01T00:00:00.000Z';
    const result = await reconstructState(db, 'space-1', counterReducer, earlyTime);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_QUERY');
  });

  it('returns error for invalid timestamp format', async () => {
    await writeMany(db, 1);

    const result = await reconstructState(db, 'space-1', counterReducer, 'not-a-date');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_QUERY');
  });

  // --- Different spaces ---

  it('space isolation: reconstructing one space ignores others', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });

    const resultA = await reconstructState(db, 'alpha', counterReducer);
    const resultB = await reconstructState(db, 'beta', counterReducer);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.value).toBe(3);
    expect(resultB.value).toBe(5);
  });

  // --- Performance ---

  it('reconstructs 500 events with snapshots efficiently', async () => {
    // Write 500 events, creating snapshots every 100
    for (let i = 0; i < 500; i++) {
      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({
        timestamp: ts,
        payload: { index: i },
      }));

      if ((i + 1) % 100 === 0) {
        await createSnapshot(db, 'space-1', counterReducer);
      }
    }

    const start = performance.now();
    const result = await reconstructState(db, 'space-1', counterReducer);
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(500);
    // With snapshots, reconstruction should be fast
    // Only replaying from last snapshot (events 401-500)
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);

  // --- Timestamp at exact event time ---

  it('includes event exactly at the target timestamp', async () => {
    await writeMany(db, 5);

    // Timestamp exactly at event #3 (index 2, t=2)
    const exactTime = new Date(Date.UTC(2026, 1, 14, 0, 0, 2)).toISOString();
    const result = await reconstructState(db, 'space-1', accumulatorReducer, exactTime);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const state = result.value as readonly unknown[];
    // Events at t=0, t=1, t=2 → 3 events
    expect(state).toHaveLength(3);
    expect(state[2]).toEqual({ index: 2 });
  });
});
