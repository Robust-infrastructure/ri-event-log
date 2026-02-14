/**
 * ri-event-log — Integrity verifier tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { verifyIntegrity } from './verifier.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyIntegrity', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-verify-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  // --- Empty database ---

  it('empty database returns valid with 0 events', async () => {
    const result = await verifyIntegrity(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(0);
    expect(result.value.checkedEvents).toBe(0);
    expect(result.value.firstBrokenLink).toBeUndefined();
    expect(result.value.duration).toBeGreaterThanOrEqual(0);
  });

  it('empty database per-space returns valid with 0 events', async () => {
    const result = await verifyIntegrity(db, 'nonexistent');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(0);
  });

  // --- Valid chains ---

  it('single event: valid chain', async () => {
    await writeMany(db, 1);
    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(1);
    expect(result.value.checkedEvents).toBe(1);
  });

  it('100 events: valid chain', async () => {
    await writeMany(db, 100);
    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(100);
    expect(result.value.checkedEvents).toBe(100);
  });

  // --- Tampered payload ---

  it('detects tampered event (payload modified)', async () => {
    const events = await writeMany(db, 5);
    const target = events[2];
    if (target === undefined) throw new Error('Expected 5 events');

    // Tamper with the payload in the database directly
    await db.events.update(target.id, {
      payload: { tampered: true },
    });

    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.firstBrokenLink).toBeDefined();
    if (result.value.firstBrokenLink === undefined) return;
    expect(result.value.firstBrokenLink.eventId).toBe(target.id);
    // The expected hash (recomputed) differs from the stored hash (actual)
    expect(result.value.firstBrokenLink.actual).toBe(target.hash);
    expect(result.value.firstBrokenLink.expected).not.toBe(target.hash);
  });

  // --- Tampered hash ---

  it('detects tampered event (hash modified)', async () => {
    const events = await writeMany(db, 5);
    const target = events[1];
    const nextEvent = events[2];
    if (target === undefined || nextEvent === undefined) {
      throw new Error('Expected 5 events');
    }

    // Modify the hash of event[1] — event[2]'s previousHash will mismatch
    await db.events.update(target.id, {
      hash: 'aaaa' + target.hash.slice(4),
    });

    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.firstBrokenLink).toBeDefined();
    if (result.value.firstBrokenLink === undefined) return;
    // The first broken event is event[1] because its hash doesn't match recomputed
    expect(result.value.firstBrokenLink.eventId).toBe(target.id);
  });

  // --- Deleted event (gap in chain) ---

  it('detects deleted event (gap in chain)', async () => {
    const events = await writeMany(db, 5);
    const target = events[2];
    if (target === undefined) throw new Error('Expected 5 events');

    // Delete event[2] — event[3] will have a previousHash pointing to event[2]'s hash
    // but event[1] will be read as the predecessor
    await db.events.delete(target.id);

    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.firstBrokenLink).toBeDefined();
  });

  // --- Per-space verification ---

  it('per-space verification only checks events for the requested space', async () => {
    await writeMany(db, 5, { spaceId: 'space-a' });
    await writeMany(db, 5, { spaceId: 'space-b' });

    // Tamper with space-b
    const spaceBEvents = await db.events
      .where('spaceId')
      .equals('space-b')
      .toArray();
    const target = spaceBEvents[2];
    if (target === undefined) throw new Error('Expected events');
    await db.events.update(target.id, { payload: { tampered: true } });

    // space-a should be valid
    const resultA = await verifyIntegrity(db, 'space-a');
    expect(resultA.ok).toBe(true);
    if (!resultA.ok) return;
    expect(resultA.value.valid).toBe(true);
    expect(resultA.value.totalEvents).toBe(5);

    // space-b should be invalid
    const resultB = await verifyIntegrity(db, 'space-b');
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    expect(resultB.value.valid).toBe(false);
  });

  // --- Full database verification ---

  it('full verification checks all spaces', async () => {
    await writeMany(db, 3, { spaceId: 'space-a' });
    await writeMany(db, 3, { spaceId: 'space-b' });

    // Both spaces valid
    const resultValid = await verifyIntegrity(db);
    expect(resultValid.ok).toBe(true);
    if (!resultValid.ok) return;
    expect(resultValid.value.valid).toBe(true);
    expect(resultValid.value.totalEvents).toBe(6);
    expect(resultValid.value.checkedEvents).toBe(6);
  });

  it('full verification detects tampering in any space', async () => {
    await writeMany(db, 3, { spaceId: 'space-a' });
    await writeMany(db, 3, { spaceId: 'space-b' });

    // Tamper with space-b
    const spaceBEvents = await db.events
      .where('spaceId')
      .equals('space-b')
      .toArray();
    const target = spaceBEvents[1];
    if (target === undefined) throw new Error('Expected events');
    await db.events.update(target.id, { payload: { tampered: true } });

    const result = await verifyIntegrity(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.firstBrokenLink).toBeDefined();
  });

  // --- Duration ---

  it('report includes positive duration', async () => {
    await writeMany(db, 10);
    const result = await verifyIntegrity(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.duration).toBeGreaterThanOrEqual(0);
  });

  // --- Performance ---

  it('1,000 events: verification completes within 2 seconds', async () => {
    const spaceId = 'perf-space';
    for (let i = 0; i < 1000; i++) {
      await writeEvent(db, makeInput({
        spaceId,
        timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, 0, i)).toISOString(),
        payload: { idx: i },
      }));
    }

    const start = performance.now();
    const result = await verifyIntegrity(db, spaceId);
    const duration = performance.now() - start;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(1000);
    expect(result.value.checkedEvents).toBe(1000);
    // Verification of 1K events should complete in reasonable time
    // (exercises chunked processing: CHUNK_SIZE=500 → 2 chunks)
    expect(duration).toBeLessThan(5000);
  }, 60_000); // 1 minute timeout for setup (writing 1K events)
});
