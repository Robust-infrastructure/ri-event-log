/**
 * ri-event-log — Storage budget monitor tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { getStorageUsage } from './budget.js';
import { EventLogDatabase } from './database.js';
import { writeEvent } from './event-writer.js';
import type { WriteEventInput } from './event-writer.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStorageUsage', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-budget-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns zero counts for empty database', async () => {
    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalEvents).toBe(0);
    expect(result.value.totalSnapshots).toBe(0);
    expect(result.value.estimatedBytes).toBe(0);
    expect(result.value.oldestEvent).toBeUndefined();
    expect(result.value.newestEvent).toBeUndefined();
    expect(result.value.spaces).toHaveLength(0);
  });

  it('counts events correctly', async () => {
    await writeMany(db, 10);

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalEvents).toBe(10);
  });

  it('estimates bytes with positive value for non-empty database', async () => {
    await writeMany(db, 5);

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.estimatedBytes).toBeGreaterThan(0);
  });

  it('byte estimate grows linearly with event count', async () => {
    await writeMany(db, 5);
    const result5 = await getStorageUsage(db);
    expect(result5.ok).toBe(true);
    if (!result5.ok) return;
    const bytes5 = result5.value.estimatedBytes;

    // Write 5 more (10 total)
    for (let i = 5; i < 10; i++) {
      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
      await writeEvent(db, makeInput({ timestamp: ts, payload: { index: i } }));
    }

    const result10 = await getStorageUsage(db);
    expect(result10.ok).toBe(true);
    if (!result10.ok) return;
    const bytes10 = result10.value.estimatedBytes;

    // Bytes should roughly double (within reason, exact ratio depends on hash growth)
    expect(bytes10).toBeGreaterThan(bytes5);
    const ratio = bytes10 / bytes5;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.5);
  });

  it('tracks oldest and newest event timestamps', async () => {
    await writeMany(db, 5);

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Events written at t=0..4 seconds from 2026-02-14T00:00:00
    expect(result.value.oldestEvent).toBe('2026-02-14T00:00:00.000Z');
    expect(result.value.newestEvent).toBe('2026-02-14T00:00:04.000Z');
  });

  it('provides per-space breakdown', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });
    await writeMany(db, 2, { spaceId: 'gamma' });

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalEvents).toBe(10);
    expect(result.value.spaces).toHaveLength(3);

    // Spaces should be sorted alphabetically
    const [alpha, beta, gamma] = result.value.spaces;
    expect(alpha?.spaceId).toBe('alpha');
    expect(alpha?.eventCount).toBe(3);
    expect(beta?.spaceId).toBe('beta');
    expect(beta?.eventCount).toBe(5);
    expect(gamma?.spaceId).toBe('gamma');
    expect(gamma?.eventCount).toBe(2);
  });

  it('per-space bytes are positive', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const space of result.value.spaces) {
      expect(space.estimatedBytes).toBeGreaterThan(0);
    }
  });

  it('events distributed across 5 spaces have correct per-space counts', async () => {
    const spaceNames = ['s1', 's2', 's3', 's4', 's5'];
    const counts = [2, 4, 6, 8, 10];

    for (let s = 0; s < spaceNames.length; s++) {
      const spaceId = spaceNames[s];
      const count = counts[s];
      if (spaceId === undefined || count === undefined) continue;
      await writeMany(db, count, { spaceId });
    }

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalEvents).toBe(30); // 2+4+6+8+10
    expect(result.value.spaces).toHaveLength(5);

    const spaceMap = new Map(result.value.spaces.map((s) => [s.spaceId, s.eventCount]));
    expect(spaceMap.get('s1')).toBe(2);
    expect(spaceMap.get('s2')).toBe(4);
    expect(spaceMap.get('s3')).toBe(6);
    expect(spaceMap.get('s4')).toBe(8);
    expect(spaceMap.get('s5')).toBe(10);
  });

  it('includes snapshot bytes in total estimate', async () => {
    await writeMany(db, 5);

    // Get baseline bytes
    const before = await getStorageUsage(db);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const bytesBefore = before.value.estimatedBytes;

    // Create a snapshot (adds to snapshots table)
    const { createSnapshot } = await import('../snapshots/snapshot-manager.js');
    const reducer = (_state: unknown, event: Event): unknown => event.payload;
    await createSnapshot(db, 'space-1', reducer);

    const after = await getStorageUsage(db);
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(after.value.totalSnapshots).toBe(1);
    expect(after.value.estimatedBytes).toBeGreaterThan(bytesBefore);
  });

  it('report is frozen (immutable)', async () => {
    await writeMany(db, 1);

    const result = await getStorageUsage(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.isFrozen(result.value)).toBe(true);
  });
});
